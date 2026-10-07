/**
 * Shared inbound message ingestion for the Meta Cloud API webhook.
 *
 * The Meta Cloud API webhook (`src/app/api/whatsapp/webhook/route.ts`)
 * has owned "an inbound WhatsApp message arrived, put it in WACRM" since
 * the beginning. These database operations live behind one boundary so
 * the webhook remains focused on validating and parsing Meta payloads,
 * while the invariants that decide whether WACRM ends up with one contact,
 * one conversation, and one copy of each message stay together:
 *
 *   - identity resolution (phone / BSUID → contact),
 *   - the one-conversation-per-(account, contact) lookup,
 *   - the `(conversation_id, message_id)` idempotency boundary,
 *   - post-insert conversation bookkeeping (unread bump, reopen, and
 *     broadcast-reply flag),
 *   - initial enquiry activation, so a thread that never had business state
 *     gets exactly one `new_enquiry` before any downstream consumer runs.
 *
 * Everything Meta-specific (payload shape, media retrieval, the Cloud API
 * token) stays in the caller.
 *
 * The `db` client is a parameter rather than a module-level singleton for
 * two reasons: the webhook holds no user session and must use the service
 * role, and it keeps these operations independently testable.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import {
  ensureInitialEnquiryForConversation,
  EnquiryRepositoryError,
} from '@/lib/enquiries/repository'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import {
  hasUsableIdentity,
  identityDisplayName,
  type WaIdentity,
} from '@/lib/whatsapp/wa-identity'
import { reopenClosedConversation } from '@/lib/conversations/reopen'

/**
 * Who a message came from. This alias keeps the ingestion boundary named
 * in its own vocabulary while accepting the object produced by
 * `resolveInboundIdentity` unchanged.
 */
export type InboundIdentity = WaIdentity

/**
 * A contact row, narrowed to the fields the ingestion path reads.
 *
 * Deliberately not `any` even though the underlying Supabase row is
 * untyped here: the webhook's own version of this alias was `any`, and
 * widening it is a drive-by refactor of a path that must not change.
 */
interface ContactRow {
  id: string
  phone?: string | null
  name?: string | null
  wa_user_id?: string | null
  wa_parent_user_id?: string | null
  wa_username?: string | null
  [key: string]: unknown
}

export interface ContactOutcome {
  contact: ContactRow
  /** True when this call created the row. Drives `new_contact_created`. */
  wasCreated: boolean
}

export interface FindOrCreateContactArgs {
  accountId: string
  /**
   * Sender-of-record for inserts that need a NOT NULL `user_id` FK. The
   * choice is arbitrary but must be *stable* so repeated deliveries
   * attribute consistently.
   */
  configOwnerUserId: string
  identity: InboundIdentity
}

export interface FindOrCreateConversationArgs {
  accountId: string
  configOwnerUserId: string
  contactId: string
}

export interface ConversationOutcome {
  conversation: { id: string; status?: string | null; [key: string]: unknown }
  created: boolean
}

/**
 * Look a contact up by business-scoped user id. Exact match on the column
 * backing migration 040's unique index — no fuzzy matching, because a
 * BSUID is an opaque identifier with exactly one correct spelling.
 */
async function findContactByWaUserId(
  db: SupabaseClient,
  accountId: string,
  waUserId: string,
): Promise<ContactRow | null> {
  const { data, error } = await db
    .from('contacts')
    .select('*')
    .eq('account_id', accountId)
    .eq('wa_user_id', waUserId)
    .maybeSingle()

  if (error) {
    console.error('[inbound] BSUID contact lookup failed:', error.message)
    return null
  }
  return (data as ContactRow | null) ?? null
}

/**
 * Fields worth writing back onto a contact we just matched, given what
 * this delivery told us. Returns null when nothing changed, so the common
 * case costs no UPDATE.
 *
 * The BSUID backfill is the important Meta one: it stamps the id onto a
 * contact we have only ever known by phone, so the NEXT message from that
 * person — which may arrive with no phone number at all — still resolves
 * to this row instead of forking a new one.
 */
export function contactIdentityPatch(
  existing: ContactRow,
  identity: InboundIdentity,
): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {}

  // Only ever from a label Meta actually supplied.
  // `identityDisplayName` falls back to the phone number / BSUID, which
  // is the right choice for a brand-new row but would clobber an agent's
  // hand-edited name on every inbound message.
  const name = identity.name || identity.waUsername
  if (name && name !== existing.name) patch.name = name

  if (identity.waUserId && identity.waUserId !== existing.wa_user_id) {
    patch.wa_user_id = identity.waUserId
  }
  if (
    identity.waParentUserId &&
    identity.waParentUserId !== existing.wa_parent_user_id
  ) {
    patch.wa_parent_user_id = identity.waParentUserId
  }
  if (identity.waUsername && identity.waUsername !== existing.wa_username) {
    patch.wa_username = identity.waUsername
  }
  // Only ever fills a blank. An existing number is left alone — the send
  // path's variant retry already owns correcting it, and Meta's
  // formatting differences are not a reason to rewrite it.
  if (identity.phone && !normalizePhone(existing.phone ?? '')) {
    patch.phone = identity.phone
  }

  return Object.keys(patch).length > 0 ? patch : null
}

/**
 * Find or create the contact this inbound message belongs to.
 *
 * Resolution order, and why:
 *
 *   1. BSUID — stable per (user, business portfolio). Meta keeps sending
 *      it even when it withholds the phone number (issue #519), so it is
 *      the key that survives a customer adopting a username.
 *   2. Phone — the fallback. `findExistingContact` pre-filters in
 *      SQL by the last-8-digit suffix, then applies the strict
 *      `phonesMatch` in JS, and is the same helper the manual contact
 *      form and CSV import use, so every path agrees on what "same
 *      number" means (issue #212).
 *
 * Returns null when the identity is unusable or the DB rejected the write,
 * so a caller drops the message rather than creating an unreachable
 * contact.
 */
export async function findOrCreateInboundContact(
  db: SupabaseClient,
  args: FindOrCreateContactArgs,
): Promise<ContactOutcome | null> {
  const { accountId, configOwnerUserId, identity } = args

  if (!hasUsableInboundIdentity(identity)) {
    return null
  }

  let existingContact: ContactRow | null = identity.waUserId
    ? await findContactByWaUserId(db, accountId, identity.waUserId)
    : null

  if (!existingContact && identity.phone) {
    existingContact = await findExistingContact(db, accountId, identity.phone)
  }

  if (existingContact) {
    const patch = contactIdentityPatch(existingContact, identity)
    if (patch) {
      const { data: updated, error: updateError } = await db
        .from('contacts')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id)
        .select()
        .maybeSingle()

      if (updateError) {
        // A BSUID backfill can lose a race with a concurrent
        // delivery that already claimed it for another row. Not fatal —
        // the message still belongs to the contact we matched.
        console.error('[inbound] contact identity backfill failed:', updateError.message)
      } else if (updated) {
        existingContact = updated as ContactRow
      }
    }
    return { contact: existingContact, wasCreated: false }
  }

  // Create. `account_id` is the tenancy column; `user_id` is the NOT NULL
  // FK audit column (no inbound message has a single "user who created"
  // it, so we attribute to a stable account-level owner).
  //
  // `phone` stays NOT NULL in the schema, so an identity with no phone
  // number is stored with '' — which migration 022's partial unique index
  // (`WHERE phone_normalized <> ''`) tolerates, and which the BSUID
  // unique index keeps unique instead.
  const { data: newContact, error: createError } = await db
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone: identity.phone,
      name: identityDisplayName(identity),
      wa_user_id: identity.waUserId,
      wa_parent_user_id: identity.waParentUserId,
      wa_username: identity.waUsername,
    })
    .select()
    .single()

  if (createError) {
    // Lost a race: a concurrent delivery created this contact between our
    // lookup and insert, and a unique index (022's phone or 040's BSUID)
    // rejected the duplicate. Re-resolve the existing row
    // instead of dropping the message.
    if (isUniqueViolation(createError)) {
      const raced = identity.waUserId
        ? await findContactByWaUserId(db, accountId, identity.waUserId)
        : null
      if (raced) return { contact: raced, wasCreated: false }
      if (identity.phone) {
        const racedByPhone = await findExistingContact(
          db,
          accountId,
          identity.phone,
        )
        if (racedByPhone) {
          return { contact: racedByPhone as ContactRow, wasCreated: false }
        }
      }
    }
    console.error('[inbound] error creating contact:', createError)
    return null
  }

  return { contact: newContact as ContactRow, wasCreated: true }
}

/**
 * False when Meta gave us no key at all — no phone and no BSUID. There is
 * nothing to find or create a contact under, so the
 * delivery has to be dropped rather than turned into an anonymous row.
 *
 * Kept at the ingestion boundary so callers do not need to duplicate its
 * identity contract.
 */
export function hasUsableInboundIdentity(identity: InboundIdentity): boolean {
  return hasUsableIdentity(identity)
}

/**
 * Find or create the conversation for a contact, oldest-first.
 *
 * Deliberately NOT `.maybeSingle()` / `.single()`. `.single()` errors on
 * both 0 rows and ≥2 rows, and the old code treated any error as "none
 * found" and inserted a new row — so once two conversations existed for
 * a contact, every subsequent inbound message created another one, a wall
 * of duplicate chats (issue #363). `LIMIT 1` resolves to the same
 * canonical survivor migration 036 keeps, so any pre-existing duplicates
 * converge instead of compounding.
 */
export async function findOrCreateInboundConversation(
  db: SupabaseClient,
  args: FindOrCreateConversationArgs,
): Promise<ConversationOutcome | null> {
  const { accountId, configOwnerUserId, contactId } = args

  const { data: existingRows, error: findError } = await db
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1)

  if (findError) {
    console.error('[inbound] error finding conversation:', findError)
    return null
  }

  if (existingRows && existingRows.length > 0) {
    return { conversation: existingRows[0], created: false }
  }

  const { data: newConv, error: createError } = await db
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
    })
    .select()
    .single()

  if (createError) {
    // Lost a race (migration 036's unique index). Re-resolve the winner
    // rather than dropping the message.
    if (isUniqueViolation(createError)) {
      const { data: raced } = await db
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1)
      if (raced && raced.length > 0) {
        return { conversation: raced[0], created: false }
      }
    }
    console.error('[inbound] error creating conversation:', createError)
    return null
  }

  return { conversation: newConv, created: true }
}

/**
 * Resolve a Meta message id into the matching internal UUID, scoped
 * to one conversation. Returns null when we never received the parent
 * (e.g. a reply to a message from before this CRM install).
 */
export async function lookupInternalIdByMessageId(
  db: SupabaseClient,
  messageId: string,
  conversationId: string,
): Promise<string | null> {
  const { data, error } = await db
    .from('messages')
    .select('id')
    .eq('message_id', messageId)
    .eq('conversation_id', conversationId)
    .maybeSingle()

  if (error) {
    console.error('[inbound] message-id lookup failed:', error.message)
    return null
  }
  return (data as { id: string } | null)?.id ?? null
}

/** The row shape {@link persistInboundMessage} writes. */
export interface InboundMessageRow {
  conversation_id: string
  sender_type: 'customer' | 'agent' | 'bot'
  content_type: string
  content_text: string | null
  media_url: string | null
  media_type: string | null
  message_id: string
  status: string
  created_at: string
  reply_to_message_id: string | null
  interactive_reply_id: string | null
}

/**
 * The single idempotency boundary for inbound messages.
 *
 * `upsert(..., { onConflict: 'conversation_id,message_id',
 * ignoreDuplicates: true })` hits migration 037's unique index and turns
 * a replay into an `ON CONFLICT DO NOTHING`; the trailing `.select()`
 * then returns a row ONLY on a genuine first insert. An empty result
 * means "we have already stored this message", and the caller must return
 * immediately.
 *
 * This must sit BEFORE any downstream side effect (unread bump, flows,
 * automations, AI, webhooks). A replay must not double-bump unread or
 * re-fire any of them — issue #367.
 */
export async function persistInboundMessage(
  db: SupabaseClient,
  row: InboundMessageRow,
): Promise<{ inserted: boolean; id: string | null } | null> {
  const { data, error } = await db
    .from('messages')
    .upsert(row, {
      onConflict: 'conversation_id,message_id',
      ignoreDuplicates: true,
    })
    .select('id')

  if (error) {
    console.error('[inbound] error inserting message:', error)
    return null
  }

  const rows = (data ?? []) as { id: string }[]
  if (rows.length === 0) {
    return { inserted: false, id: null }
  }
  return { inserted: true, id: rows[0].id }
}

/**
 * Post-insert bookkeeping that every inbound message needs. Runs ONLY
 * after {@link persistInboundMessage} reports a
 * genuine first insert.
 *
 * That call site is the whole trigger scope for initial enquiry
 * activation. Reactions short-circuit before it, status events never
 * reach it, and outbound agent sends are not ingested here at all — so
 * the only traffic that can create an enquiry is a genuine customer
 * inbound conversation message.
 *
 * Order is load-bearing and matches the Meta webhook exactly:
 *
 *   0. `ensureInitialEnquiryForConversation` — runs FIRST so the thread
 *      carries business state before anything downstream reads it. Every
 *      later step in the webhook (flows, automations, the AI reply path)
 *      is a consumer that may need enquiry context, and none of them are
 *      allowed to be the thing that discovers there is none.
 *   1. `bump_conversation_on_inbound` — a DB-side atomic increment
 *      (migration 037). The old app-side read-modify-write lost one bump
 *      under concurrency (issue #369).
 *   2. `reopenClosedConversation` — a customer writing again re-opens a
 *      closed thread (issue #409). Gated on the row's CURRENT status in
 *      SQL, so a stale read cannot write 'open' over a re-close.
 *   3. `flagBroadcastReplyIfAny` — advances the parent broadcast's
 *      `replied_count` for a still-unreplied recipient. Best-effort;
 *      errors are swallowed because they must not break ingestion.
 *
 * Message ingestion is authoritative and the message row is already
 * committed by this point. Every step here is therefore best-effort: a
 * business-state failure must never cost us the delivery.
 */
export async function afterInboundInsert(
  db: SupabaseClient,
  args: {
    accountId: string
    contactId: string
    conversation: { id: string; status?: string | null }
    /**
     * Sender-of-record for the enquiry's `created_by_user_id`, which the
     * database requires on insert. Same stable account-level owner the
     * contact and conversation inserts use — an inbound message has no
     * single human author.
     */
    configOwnerUserId: string
    /** Used for the conversation summary when there is no text. */
    fallbackSummary: string
  },
): Promise<void> {
  const { accountId, contactId, conversation, configOwnerUserId, fallbackSummary } =
    args

  await activateInitialEnquiry(db, {
    accountId,
    conversationId: conversation.id,
    configOwnerUserId,
  })

  const { error: convError } = await db.rpc('bump_conversation_on_inbound', {
    p_conversation_id: conversation.id,
    p_last_message_text: fallbackSummary,
  })
  if (convError) {
    console.error('[inbound] error updating conversation:', convError)
  }

  await reopenClosedConversation(db, conversation)
  await flagBroadcastReplyIfAny(db, accountId, contactId)
}

/**
 * Create a conversation's first enquiry, and only its first.
 *
 * The activation rule lives in the domain layer
 * (`ensureInitialEnquiryForConversation`): create `new_enquiry` only when
 * the thread has no enquiry history at all. So a completed job followed by
 * "Thanks" does NOT produce a second enquiry, and a second, third, or
 * fiftieth message on a live thread reuses the same one. Repeat-job
 * creation is a separate, explicit business action.
 *
 * Failure is logged and swallowed, never rethrown. The inbound message is
 * already stored and must not be lost or retried by Meta because a
 * business-state write failed. Retry needs no separate mechanism: because
 * the rule keys off "no enquiry history yet" rather than "no enquiry
 * right now", the next inbound message on the same thread re-attempts the
 * activation by itself.
 */
async function activateInitialEnquiry(
  db: SupabaseClient,
  args: {
    accountId: string
    conversationId: string
    configOwnerUserId: string
  },
): Promise<void> {
  try {
    const outcome = await ensureInitialEnquiryForConversation(db, {
      accountId: args.accountId,
      conversationId: args.conversationId,
      createdByUserId: args.configOwnerUserId,
    })

    if (outcome.created) {
      console.info(
        '[inbound] initial enquiry created for conversation:',
        outcome.enquiry.id
      )
    }
  } catch (error) {
    console.error(
      '[inbound] initial enquiry activation failed:',
      safeFailureLabel(error)
    )
  }
}

/**
 * A bounded, non-sensitive label for an operational failure.
 *
 * Deliberately drops the underlying driver message: a PostgREST error can
 * echo SQL, constraint definitions, and column values, and none of those
 * belong in webhook logs. The repository's own error code is enough to
 * tell a permanent problem (a conversation that is not in this account)
 * from a transient one worth retrying on the next message.
 */
function safeFailureLabel(error: unknown): string {
  if (error instanceof EnquiryRepositoryError) {
    return `${error.name}:${error.code}`
  }
  if (error instanceof Error) return error.name
  return 'unknown_error'
}

/**
 * If this inbound message's sender is on a still-unreplied
 * `broadcast_recipients` row, flip it to `replied` so the reply count
 * advances on the parent broadcast.
 *
 * Best-effort by design: a failure here must not break inbound
 * processing, so errors are swallowed with a log.
 */
async function flagBroadcastReplyIfAny(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
): Promise<void> {
  try {
    // Most recent outbound broadcast in this account that hasn't been
    // replied to yet. Account-scoped so a shared-inbox reply marks the
    // broadcast as replied regardless of which teammate sent it.
    const { data: recs, error } = await db
      .from('broadcast_recipients')
      .select('id, status, broadcast_id, broadcasts!inner(account_id)')
      .eq('contact_id', contactId)
      .eq('broadcasts.account_id', accountId)
      .in('status', ['sent', 'delivered', 'read'])
      .order('created_at', { ascending: false })
      .limit(1)

    if (error || !recs || recs.length === 0) return

    const { error: updErr } = await db
      .from('broadcast_recipients')
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', (recs[0] as { id: string }).id)

    if (updErr) {
      console.error('[inbound] error marking broadcast recipient replied:', updErr)
    }
  } catch (err) {
    console.error('[inbound] flagBroadcastReplyIfAny failed:', err)
  }
}
