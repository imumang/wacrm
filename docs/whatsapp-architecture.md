# WACRM — WhatsApp / Meta Cloud API Architecture

**Current behaviour only.** This document describes what the code does
today. It does not design, propose, or hint at any coexistence feature.
Companion documents: [`project-context.md`](./project-context.md),
[`database-architecture.md`](./database-architecture.md).

Existing operator-facing docs (accurate and reused rather than
duplicated): [`multi-waba.md`](./multi-waba.md),
[`whatsapp-connection-troubleshooting.md`](./whatsapp-connection-troubleshooting.md).

Source of truth: `src/lib/whatsapp/*` and `src/app/api/whatsapp/*` at
commit `80c3f9a`.

## Module map

| File | Responsibility |
| --- | --- |
| `src/lib/whatsapp/meta-api.ts` | Every Graph API call. 42 KB — the largest file in the integration. |
| `src/lib/whatsapp/encryption.ts` | AES-256-GCM encrypt/decrypt of `access_token` / `verify_token`. |
| `src/lib/whatsapp/webhook-signature.ts` | HMAC-SHA256 verification of inbound POSTs. |
| `src/lib/whatsapp/send-message.ts` | Outbound send core (validate → Meta → persist → pause flows). |
| `src/lib/whatsapp/resolve-conversation.ts` | Phone → contact + conversation, for callers that hold no `conversation_id`. |
| `src/lib/whatsapp/wa-identity.ts` | Inbound sender identity: phone vs BSUID (issue #519). |
| `src/lib/whatsapp/phone-utils.ts` | `normalizePhone`, `sanitizePhoneForMeta`, `isValidE164`, `phoneVariants`, `isRecipientNotAllowedError`. |
| `src/lib/whatsapp/waba-pairing.ts` | Pure WABA/phone pairing checks and error text (issue #505). |
| `src/lib/whatsapp/meta-error-explain.ts` | Turns a `MetaApiError` into actionable text + `code`/`subcode`/`fbtrace_id`/`step`. |
| `src/lib/whatsapp/broadcast-core.ts` | Two-phase broadcast create + deliver. |
| `src/lib/whatsapp/broadcast-resume.ts` | Resume an interrupted broadcast. |
| `src/lib/whatsapp/mirror-inbound-media.ts` | Copy inbound attachments into `chat-media` (issue #466). |
| `src/lib/whatsapp/template-*.ts` | Template row resolution, body substitution, component builders, validators, lifecycle. |
| `src/lib/whatsapp/interactive.ts` | Interactive button/list payload validation and preview text. |
| `src/lib/whatsapp/template-webhook.ts` | Meta template status / quality / components webhook fields. |
| `src/lib/whatsapp/template-status-normalize.ts` | Status string normalisation. |
| `src/lib/whatsapp/inbound.ts` | Shared inbound database boundary: contact and conversation find-or-create, the `(conversation_id, message_id)` idempotency boundary, initial enquiry activation, and post-insert conversation bookkeeping. |

Routes:

| Route | Methods | Purpose |
| --- | --- | --- |
| `/api/whatsapp/webhook` | GET, POST | Meta verification handshake; inbound messages + statuses. |
| `/api/whatsapp/config` | GET, POST, DELETE | Read/test, save (register + subscribe), reset. |
| `/api/whatsapp/config/verify-registration` | GET | Three-check diagnostic. |
| `/api/whatsapp/send` | POST | Dashboard composer / contact-detail send. |
| `/api/whatsapp/react` | POST | Agent reaction. |
| `/api/whatsapp/media/[mediaId]` | GET | Authenticated proxy that streams bytes from Meta. |
| `/api/whatsapp/broadcast`, `/broadcast/[id]/resume` | POST | Broadcast create / resume. |
| `/api/whatsapp/templates`, `/templates/[id]`, `/templates/sync`, `/templates/submit` | various | Template CRUD, sync from Meta, submit for approval. |

## Connection flow (operator perspective)

UI: `src/components/settings/whatsapp-config.tsx`
(`Settings → WhatsApp connection`).

The form collects five values, all optional except the first two:

| Field | Required | Notes |
| --- | --- | --- |
| `phone_number_id` | yes | Must be digits-only (`isNumericMetaId`). Rejected up front with a named `field` if a phone number / URL was pasted. |
| `waba_id` | no | Nullable for legacy rows; digits-only when present. |
| `access_token` | yes | Meta System User token. Required on every save (the route re-verifies against Meta each time). |
| `verify_token` | no | Encrypted at rest. Must match at least one account's token for the `GET` handshake. |
| `pin` | no | Exactly 6 digits when present (`/^\d{6}$/`). The Meta two-step verification PIN. |

The UI shows a separate "Verify with Meta" probe
(`/api/whatsapp/config/verify-registration`) and a distinct
"Not registered" banner when `registered_at` is null, so "credentials
saved" is never conflated with "actually live".

## Credentials / configuration

`POST /api/whatsapp/config` performs, in order:

1. **Auth** — session required; `account_id` resolved from
   `profiles` (inlined in the route rather than via
   `getCurrentAccount()`, so every non-auth failure can still return a
   shaped 200).
2. **Shape validation** — `access_token` + `phone_number_id` present;
   `phone_number_id` and `waba_id` digits-only; `pin` is 6 digits.
3. **Cross-account claim check** — service-role query for a
   `phone_number_id` already held by a *different* `account_id`;
   conflicts return **409**. Under the caller's own session this row is
   invisible (RLS), which is why the service role is used.
4. **Meta number verification** — `verifyPhoneNumber()` →
   `GET /{phone_number_id}?fields=id,display_phone_number,verified_name,quality_rating`.
   Failure → `metaFailure(err, 'verify_number', …)`.
5. **WABA/phone pairing** — when `waba_id` is given,
   `listWabaPhoneNumbers()` (paged up to 5 pages, `limit=100`) and
   `phoneNumberBelongsToWaba()`. A mismatch returns **400** with the
   list of numbers Meta actually sees under that WABA, naming the
   problem instead of subscribing the wrong account (#505).
6. **Encryption** — `encrypt(access_token)`, and
   `encrypt(verify_token)` when provided.
7. **`/register`** (step 1 of Meta registration) — see below.
8. **`/subscribed_apps`** (step 2) — see below.
9. **Persist** — UPDATE by `account_id` if a row exists, else INSERT
   with `{ account_id, user_id, ...baseRow }`.
10. **Response** — `{ success, saved, registered, registration_skipped,
    phone_info }`, or `{ success: false, saved: true, registered: false,
    registration_error, meta, phone_info }` with HTTP 200 so the UI can
    show a specific remediation step.

`GET /api/whatsapp/config` (the "Test API Connection" button) always
returns 200 in non-auth cases, reporting one of:

- `no_account` — profile not linked to an account
- `no_config` — nothing saved
- `db_error`
- `token_corrupted` + `needs_reset` — decrypt failed (usually
  `ENCRYPTION_KEY` differs between environments)
- `meta_api_error` + `meta{…}`
- `connected: true` with `phone_info` and `waba_subscription`

`DELETE /api/whatsapp/config` removes the row for the caller's account
("Reset Configuration").

### Token storage

- `encrypt()` — AES-256-GCM, 12-byte random IV, 16-byte auth tag,
  output `ivHex:ctHex:tagHex` (three colon-separated parts).
  `ENCRYPTION_KEY` is read at module load as 64 hex chars → 32 bytes.
- `decrypt()` — auto-detects format by part count. Three parts = GCM
  (current, authenticated). Two parts = **legacy CBC**
  (`aes-256-cbc`, unauthenticated, decrypt-only). `isLegacyFormat()`
  lets call sites upgrade a row in place.
- The GCM rationale is explicit in the source: unauthenticated CBC means a
  bit-flip in the ciphertext row decrypts silently, and if the mutated
  bytes happened to form a valid token, messages would go out under a
  spoofed account.
- Upgrade paths exist on two call sites: the send core
  (`send-message.ts`, fire-and-forget after a successful decrypt) and the
  webhook `GET` verify handler. Both are idempotent.
- **No key derivation, no key rotation, no per-account key.** One
  deployment-wide key.

### Assumed token properties

The code assumes the stored `access_token` is a **Meta System User
token** with at least:

- `whatsapp_business_messaging` (send + read message/media)
- `whatsapp_business_management` (read phone numbers, WABA
  subscription state, templates) — optional in practice: the GET
  handler treats a `subscribed_apps` failure as non-fatal because a
  token lacking that scope can still send.
- Business asset assignment on the WABA it belongs to.

`docs/multi-waba.md` Setup B states tokens are "generated inside the
Business portfolio that owns its app". There is **no** code path that
exchanges, refreshes, or validates a token's lifetime or scope, and
**no** field recording the system-user id or business id.

## Registration / subscription

Two independent Meta calls, both required before inbound events are
delivered to this app.

### `POST /{phone_number_id}/register` — `registerPhoneNumber()`

Body: `{ messaging_product: 'whatsapp', pin }`.

- Requires the 6-digit two-step verification PIN the operator set in
  Meta WhatsApp Manager → Two-step verification.
- A failure whose message matches `/already.*registered/i` is treated as
  **success** with `alreadyRegistered: true`.
- When the number is already registered for the same account and the
  user supplied **no** PIN, the call is **skipped**
  (`registrationSkipped = true`). This exists because Meta TEST numbers
  are pre-registered and expose no 2FA PIN, so requiring one made them
  impossible to connect (#242).
- A `/register` failure does **not** abort the save. The row is still
  written with `status: 'disconnected'`, `connected_at: null`,
  `registered_at: null`, and `last_registration_error` set. HTTP is
  still 200 with `registered: false`, so the user can retry without
  re-entering everything.
- Registration is *attempted* when: no prior row for this account, the
  `phone_number_id` changed, **or** a non-empty PIN was supplied (the
  PIN-rotated case). It is skipped when the same number is already
  registered and no PIN was given — re-registering an active number
  with a stale PIN would fail and undo the subscription.

### `POST /{waba_id}/subscribed_apps` — `subscribeWabaToApp()`

- No body; `Authorization: Bearer <token>`.
- Idempotent on Meta's side, so it runs on **every** save and
  `subscribed_apps_at` is stamped on success.
- A failure **does** abort the save and returns `metaFailure(err,
  'subscribe_waba', …)` (400 or 502). Nothing has been written at that
  point, so the user fixes the cause and saves again. This is deliberate:
  the previous behaviour swallowed the error, leaving a green
  "Connected" banner over a webhook that never fired (#505).
- Skipped only when `waba_id` is absent.

### `GET /{waba_id}/subscribed_apps` — `getSubscribedApps()`

Diagnostic. Two consumers:

- `GET /api/whatsapp/config` → `appSubscriptionState(subs, META_APP_ID)` →
  `{ subscribed, appIdMatch }`. `appIdMatch` is `null` when
  `META_APP_ID` is not configured.
- `GET /api/whatsapp/config/verify-registration` → treats *any* returned
  entry as success (the token can only see apps it belongs to).

### Two-step verification

Handled only as an input to `/register`. There is **no** call to set,
verify, or reset a PIN, and no storage of the PIN — it is passed
straight to Meta and never persisted.

## Webhook path

Route: `src/app/api/whatsapp/webhook/route.ts`,
`export const maxDuration = 60`.

Excluded from the middleware auth gate explicitly
(`src/middleware.ts` skips paths containing `/webhook`).

### GET — verification handshake

1. Require `hub.mode=subscribe`, `hub.challenge`, `hub.verify_token`.
2. Service-role `SELECT id, verify_token FROM whatsapp_config` —
   **every** config, across all accounts.
3. For each row, `decrypt(verify_token) === verifyToken`, in constant
   semantics (plain string equality on the decrypted value). A row that
   throws (wrong key / malformed) is skipped, not fatal.
4. On match: fire-and-forget upgrade of a legacy CBC `verify_token` to
   GCM, then return the challenge as `text/plain`.
5. No match → **403** `Verification token mismatch`.

So the handshake succeeds if **any** account's verify token matches —
which is what lets one callback URL serve many WABAs/accounts.

### POST — event delivery

1. `await request.text()` for the **raw bytes** (reading `.json()` first
   would re-encode and break the signature).
2. Read `x-hub-signature-256`.
3. `verifyMetaWebhookSignature(rawBody, signature)`; failure → **401**
   (deliberately not 200, so Meta's delivery dashboard shows failures
   loudly). See "Signature verification".
4. Parse JSON; malformed → **400**.
5. Respond `{ status: 'received' }` **200 immediately**.
6. Process inside `after(async () => { … })`.

`after()` is mandatory, not stylistic: on a serverless runtime the
function can be frozen the moment the response is sent, so a detached
`processWebhook(body)` promise dropped a non-deterministic *subset* of
inbound messages (issue #301). `after()` keeps the invocation alive until
the promise resolves, bounded by `maxDuration`.

### Change routing inside `processWebhook()`

For each `entry` × `changes`:

- If `change.field` is one of `message_template_status_update` /
  `_quality_update` / `_components_update` → delegate to
  `handleTemplateWebhookChange({ field, value, wabaId: entry.id })` and
  `continue`. For template events `entry.id` is the **WABA id**, which
  the handler uses to resolve the owning account when the template has
  no local row yet (#534).
- If `value.statuses` → `handleStatusUpdate()` for each.
- If no `value.messages` **or** no `value.contacts` → skip. (A message
  delivery without a `contacts` array is dropped, even though
  `wa-identity` can work from message-level fields alone.)

## Signature verification

`src/lib/whatsapp/webhook-signature.ts`.

- `META_APP_SECRET` is **required**. If unset (or comma/space-only),
  `verifyMetaWebhookSignature` logs an error and returns `false` —
  **fail closed**. An earlier version fell open with a warning, which
  made a public template's webhook fully spoofable whenever an operator
  forgot the env var.
- The value may be a **comma-separated list** of secrets (#500): each
  Meta App signs with its own secret, so one deployment serving WABAs
  under several Apps accepts any of them. `parseAppSecrets()` splits,
  trims and drops empties.
- Each candidate is compared with `crypto.timingSafeEqual` over
  `sha256=<hex>` HMACs. Length mismatch short-circuits (the function
  throws otherwise). There is deliberately **no** early return inside
  the loop, so the cost is proportional to the number of configured
  apps — public knowledge to the operator — not to the secret contents.
- `META_APP_ID` is a single value (used only for image-header template
  Resumable Upload handles) and is unrelated to verification.

## Inbound messages

`processWebhook()` → resolve config → `processMessage()`.

### Tenant resolution

```ts
.from('whatsapp_config').select('*').eq('phone_number_id', phoneNumberId)
```

- 0 rows → log and drop.
- ≥2 rows → log with the owning `account_id`s and drop. Migration 013's
  unique constraint should make this impossible, but a pre-constraint row
  or a race would surface here.
- Exactly 1 row is the config. Its `account_id` is the tenancy value
  threaded into every downstream lookup; its `user_id` is the audit
  `user_id` written on new rows that need a NOT NULL FK.

Then `decrypt(config.access_token)` once and reuse it for media fetches.

`config.mirror_inbound_media !== false` supplies the per-account media
opt-out (default true even for rows read before migration 039).

### Sender identity

`resolveInboundIdentity(message, contact)` → `{ phone, waUserId,
waParentUserId, waUsername, name }`.

- Phone comes from `messages[].from` or `contacts[].wa_id`, normalised
  to digits.
- BSUIDs come from `messages[].from_user_id` /
  `from_parent_user_id` or `contacts[].user_id` / `parent_user_id`.
  `cleanBsuid()` refuses anything that does not match
  `^[A-Za-z]{2}\.(?:ENT\.)?[A-Za-z0-9]{4,}$` rather than storing a bad
  permanent contact key.
- Message-level fields win over contact-level on disagreement.
- `hasUsableIdentity()` — neither phone nor BSUID ⇒ the delivery is
  **dropped loudly** rather than turned into an unreachable contact row.

The BSUID path exists because, since WhatsApp usernames, Meta omits the
phone number entirely for a sender who has adopted a username and has no
recent interaction history (#519). BSUID is stable per (user, business
portfolio), so it is the better key when present.

### Contact find-or-create

1. `findContactByWaUserId(accountId, waUserId)` — exact match on the
   index from migration 040.
2. Else `findExistingContact(db, accountId, phone)` from
   `src/lib/contacts/dedupe.ts` — SQL pre-filter on the last-8-digit
   suffix, then a strict `phonesMatch` in JS. The same helper backs the
   manual contact form and CSV import, so all three paths agree on what
   "same number" means (#212).
3. Matched → `contactIdentityPatch(existing, identity)` writes back only
   genuinely new information: a `wa_user_id` backfill (the important
   one — it means the *next* username-only message resolves to the same
   row), a phone backfill **only when the existing phone is blank**, and
   a name only when Meta actually supplied a label (never the
   `identityDisplayName` fallback, which would clobber a hand-edited
   name). Returns `null` when nothing changed, so the common case costs
   no UPDATE.
4. Not matched → INSERT with
   `{ account_id, user_id, phone, name, wa_user_id, wa_parent_user_id, wa_username }`.
   A BSUID-only sender is stored with `phone: ''`, which migration 022's
   partial unique index tolerates.
5. On `23505` (lost a race) → re-resolve by BSUID then by phone and use
   the winner rather than dropping the message.

### Conversation find-or-create

`SELECT … FROM conversations WHERE account_id = ? AND contact_id = ?
ORDER BY created_at ASC LIMIT 1`.

- Deliberately **not** `.maybeSingle()`. The old code treated any error
  as "none found" and inserted a new row, so once two conversations
  existed for a contact every subsequent inbound created another one —
  a wall of duplicate chats (#363). `LIMIT 1` resolves to the same
  canonical survivor migration 036 keeps.
- On insert, a `23505` re-resolves the winner.

`conversation.created` is dispatched to public webhook subscribers
**immediately** after the thread is opened and **before** the reaction
short-circuit, so a conversation first opened by a reaction still fires
it.

### Reactions

`message.type === 'reaction'` short-circuits before
`parseMessageContent` (so no media fetch happens) and before the message
insert. It never writes to `messages`, never bumps `unread_count`, never
updates `last_message_text`.

- Target resolved via `lookupInternalIdByMetaId(metaId, conversationId)`
  — scoped to the conversation. A missing parent is logged and skipped so
  the webhook still acks 200.
- Empty emoji = removal ⇒ `DELETE` on
  `(message_id, actor_type='customer', actor_id=contactId)`.
- Otherwise `upsert` on `onConflict: 'message_id,actor_type,actor_id'`.

### Content parsing

`parseMessageContent()` returns `{ contentText, mediaUrl, mediaType,
interactiveReplyId }`.

| Meta type | Handling |
| --- | --- |
| `text` | `content_text` = body |
| `image` / `video` | caption becomes `content_text`; media fetched + mirrored |
| `document` | caption ‖ filename as `content_text`; `filename` becomes the mirrored object name |
| `audio` / `sticker` | media only (no `content_text`) |
| `location` | `name - address - lat,long` joined |
| `reaction` | not reached (short-circuited earlier) |
| `interactive` | `button_reply` ‖ `list_reply`; `content_text` = title ‖ id; `interactive_reply_id` = id |
| `button` | Template **quick-reply** tap: `content_text` = `button.text` ‖ `button.payload`; `interactive_reply_id` = `payload` ‖ label. Meta uses this distinct envelope for template buttons (#478). |
| default | `content_text` = `[Unsupported message type: X]` |

`mediaType` stores Meta's MIME on `messages.media_type` (migration 039)
so downloads no longer guess an extension from fetched bytes.

### Media fetching and mirroring

`verifyAndBuildUrl(mediaId, fileName?)`:

1. `getMediaUrl({ mediaId, accessToken })` — verifies the id and gets the
   short-lived CDN URL.
2. If mirroring is on: `mirrorInboundMedia({ storage, accountId, mediaId,
   downloadUrl, accessToken, mimeType, fileSize, fileName,
   messageTimestamp })` → uploads to `chat-media` at
   `account-<id>/inbound/…` and returns a durable public URL.
3. Fall back to `/api/whatsapp/media/<mediaId>`.
4. Any throw ⇒ log and return `null` (no media URL on the row).

Mirroring is **strictly best-effort** by design: a webhook that throws
would make Meta retry the delivery and re-run contact creation, flows,
automations and AI replies. An expiring attachment is the lesser failure.

Media types exceeding `MEDIA_MAX_BYTES` or a MIME the bucket refuses are
skipped for the same reason.

### Idempotency (the key invariant)

```ts
.from('messages').upsert({ …, message_id: message.id, … },
  { onConflict: 'conversation_id,message_id', ignoreDuplicates: true })
  .select('id')
```

The unique index from migration 037 turns Meta's retries into an
`ON CONFLICT DO NOTHING`. `.select()` then returns a row **only on a
genuine first insert**. An empty array means "this delivery was a
replay", and the handler returns immediately.

This is the single idempotency boundary, and it sits **before** the
unread bump and every downstream side effect (#367). A replay therefore
cannot double-bump `unread_count`, re-advance flows, re-fire automations,
re-invoke AI handling, or re-dispatch public webhooks.

### Post-insert fan-out (only on a genuine first insert)

Steps 1–4 run inside `afterInboundInsert()` in `src/lib/whatsapp/inbound.ts`;
steps 5–7 run in the webhook route.

1. **Initial enquiry activation** — `ensureInitialEnquiryForConversation()`.
   Creates one `new_enquiry` if and only if the conversation has no enquiry
   history at all, so a thread always has business state before anything
   downstream reads it. Deliberately not "whenever no *active* enquiry
   exists" — that would turn a post-completion "thanks" into a repeat job.
   A concurrent second insert is rejected by the one-active-enquiry partial
   unique index and resolved back to the winner, so parallel first
   deliveries still produce exactly one enquiry. Best-effort: the message
   row is already committed, so a failure is logged with a bounded label and
   swallowed, and the next inbound message retries on its own. See
   [`enquiry-state.md`](./enquiry-state.md#initial-enquiry-activation).
2. **Unread bump** — RPC `bump_conversation_on_inbound(conversation_id,
   last_message_text)`. DB-side atomic increment; the old app-side
   read-modify-write lost one bump under concurrency (#369).
3. **Reopen** — `reopenClosedConversation()`. A customer writing again
   re-opens a closed thread (#409).
4. **Broadcast reply flag** — `flagBroadcastReplyIfAny()`: the most
   recent `sent`/`delivered`/`read` recipient row for this contact in
   this account flips to `replied`, advancing the parent broadcast's
   `replied_count` via the migration-003 aggregate trigger.
   Best-effort; errors are swallowed.
5. **Flows** — `dispatchInboundToFlows({...})`. Returns `consumed`. When
   a flow consumed the message, the content-level automation triggers
   below are suppressed (the customer is navigating a bot menu, not
   sending a fresh trigger word). `new_contact_created` and
   `first_inbound_message` still fire.
6. **Automations** — awaited, in this order:
   `first_inbound_message` (contact's first-ever customer message,
   computed by counting prior customer rows **before** the insert so
   manually-imported contacts are caught too), `new_contact_created`
   (this call created the row), then — if not flow-consumed —
   `new_message_received`, `keyword_match`, and `interactive_reply` when
   a button/list tap arrived. Each is awaited, not fire-and-forget: we are
   inside `after()`, which only keeps the function alive for promises it
   can see, and a detached dispatch could freeze after writing the log
   row but before running the steps (#301/#409).
7. **AI auto-reply** — `dispatchInboundToAiReply(...)`, only when the
   flow did not consume the message, there is no `interactive_reply_id`,
   and the inbound text is non-empty. Flows win over the LLM.
7. **Public webhook** — `dispatchWebhookEvent(..., 'message.received', …)`,
   awaited, last.

## Message statuses

`handleStatusUpdate()` runs on every `value.statuses[]` entry.

1. **Failure extraction** — when `status === 'failed'` and `errors[0]`
   exists, `{ code, title, details: error_data.details ?? null }` is
   captured. Read only on `failed`, so a later non-failed status does not
   clear the reason (#535).
2. **Mirror onto `messages`** — `UPDATE messages SET status = …` by
   `message_id`. **No `.select()`**: `message_id` is *not* unique
   (migration 009 — Meta ids repeat across numbers), so this updates
   0..N rows. On failure the three `error_*` columns are also written
   (migration 042).
3. **Mirror onto `broadcast_recipients`** — matched on
   `whatsapp_message_id` (migration 003) with `.maybeSingle()`. The
   parent broadcast's counts are re-derived by the aggregate trigger.
4. **Transition guard** — `isValidStatusTransition(current, incoming)`:
   - ladder is `pending → sent → delivered → read → replied`, forward-only
     (a webhook replay must never regress a recipient);
   - `failed` is a terminal side branch, accepted **only** from `pending`
     or `sent`;
   - `failed` is terminal — nothing transitions out of it;
   - an unknown current status accepts anything on the ladder;
   - an unknown incoming status is refused.
5. **Timestamps** — `sent_at`, `delivered_at`, `read_at` from Meta's epoch
   timestamp. The free-text reason is folded into the existing
   `error_message` column rather than adding three columns.
6. **Public webhook** — `message.status_updated`, last, so a slow
   subscriber cannot delay the mirrors above.

Status handling is independent of the config lookup: it does **not**
require `phone_number_id` to resolve.

## Outbound messages

Core: `sendMessageToConversation(db, accountId, params)` in
`src/lib/whatsapp/send-message.ts`. Transport-agnostic — it accepts
either an RLS-scoped user client or the service-role client, because
every query filters by `accountId`.

Sequence:

1. `validateSendMessageParams()` — message type in
   `{ text, template, interactive, image, video, document, audio }`;
   required content per type; `validateInteractivePayload()` against
   Meta's limits; 1024-char caption cap (audio excluded). Exported
   separately so a route can reject a malformed payload *before* it
   find-or-creates a conversation (which would otherwise leave an orphan
   empty thread).
2. Load `conversations … contact:contacts(*)` filtered by
   `(id, account_id)`.
3. **Target resolution** — `resolveContactSendTarget(contact)`: a valid
   E.164 phone wins (`{ recipient_type: 'individual', to }`); otherwise a
   BSUID is used (`{ recipient: bsuid }`, issue #519). Neither ⇒
   `SendMessageError('bad_request', …)`.
4. Load `whatsapp_config` by `account_id` (`.single()` — the table is
   one-row-per-account). Missing ⇒ `whatsapp_not_configured`.
5. `decrypt(access_token)`; if legacy CBC, fire-and-forget re-encrypt to
   GCM.
6. **Reply context** — `reply_to_message_id` must resolve to a
   `messages` row **inside the same conversation**, so a caller cannot
   quote messages they cannot see. A parent without a Meta
   `message_id` sends without context (warned).
7. **Template row** — `resolveTemplateRow()` tolerates the `en` /
   `en_US` split so an omitted language still resolves. A malformed row
   ⇒ `template_malformed` telling the user to run "Sync from Meta".
8. **Send** — `attempt(phone)` dispatches on message type to
   `sendTextMessage` / `sendTemplateMessage` / `sendMediaMessage` /
   `sendInteractiveButtons` / `sendInteractiveList`.
9. **Phone-variant retry** — when the target is a phone, iterate
   `phoneVariants(sanitizedPhone)` and retry **only** on
   `isRecipientNotAllowedError`. A BSUID is opaque and gets a single
   attempt.
10. **Contact auto-correct** — if a variant other than the sanitised
    phone worked, the working form is written back to
    `contacts.phone`.
11. Any Meta failure ⇒ `SendMessageError('meta_error', …, 502)`.
12. **Persist** — INSERT `messages` with `sender_type: 'agent'`,
    `status: 'sent'`, `message_id: waMessageId`. Interactive messages
    store `interactive_payload` and use the body as `content_text`;
    templates store the **substituted** body (an empty bubble here was
    #483). A DB failure here after a successful Meta send raises a
    distinct message — "Message sent to Meta but failed to save to DB"
    — so the operator can reconcile.
13. **Conversation summary** — update `last_message_text`,
    `last_message_at`, `updated_at`.
14. **Pause flows** — any `active` `flow_runs` row for
    `(account_id, contact_id)` flips to `status: 'paused_by_agent'`,
    `ended_at`, `end_reason: 'agent_replied'`. Best-effort.

Dashboard entry point: `POST /api/whatsapp/send` requires role `agent`
(`requireRole('agent')`) and applies `checkRateLimit('send:<userId>', …)`
**before** touching Meta — because RLS blocking the INSERT would not
unsend the message, a viewer would still deliver to the customer. It
accepts either `conversation_id` or `contact_id`; the latter
find-or-creates a conversation.

Public entry point: `POST /api/v1/messages` with an API key, using
`resolveConversationByPhone()` when no `conversation_id` is supplied.

Reactions: `POST /api/whatsapp/react`, role `agent`, rate-limited
separately (`react:<userId>`), writes only `actor_type = 'agent'` rows
into `message_reactions`.

### `recipientFields()` — the phone vs BSUID rule

`meta-api.ts` routes every send's `to` through
`recipientFields(value)`:

```ts
isBusinessScopedUserId(to) ? { recipient: to.trim() }
                           : { recipient_type: 'individual', to }
```

The two are never ambiguous: a sanitised phone is digits only, and a BSUID
always carries a two-letter prefix and a dot.

## Templates

- **Local catalogue** — `message_templates`, per account, stores Meta's
  status enum **verbatim** (APPROVED / PENDING / REJECTED / PAUSED /
  DISABLED / IN_APPEAL / PENDING_DELETION) so edit / resubmit / delete
  can distinguish recoverable from terminal states and webhook events
  land 1:1 with no translation table.
- **Sync** — `POST /api/whatsapp/templates/sync` pulls from
  `GET /{waba_id}/message_templates`, normalises category and quality
  score, and **does not delete** locally-created rows that have no Meta
  counterpart — drift stays visible so an operator can clean it up.
- **Submit** — `POST /api/whatsapp/templates/submit` creates/edits a
  template on Meta. Image-header templates need a Resumable-Upload
  handle from the **app-scoped** upload API, which is the only consumer
  of `META_APP_ID`. `WHATSAPP_TEMPLATES_DRY_RUN=true` skips the Meta
  call and stores a synthetic `dry-run-<uuid>` `meta_template_id` — used
  in CI and local dev.
- **Send** — `template-body.ts` resolves the row and substitutes
  params; `template-components.ts` / `template-send-builder.ts` /
  `template-header-handle.ts` build header/body/button components;
  `template-validators.ts` validates before hitting Meta.
- **Lifecycle webhooks** — `template-webhook.ts` handles the three
  `message_template_*` fields. **These are not subscribed by default**;
  they must be toggled manually per app in Meta App Dashboard →
  WhatsApp → Configuration → Webhooks. Until then status arrives only via
  "Sync from Meta". For a template with no local row, the handler
  resolves the account from the webhook `entry.id` (the WABA id) against
  `whatsapp_config.waba_id` and creates a stub row with
  `body_text = ''`; "Sync from Meta" backfills components by matching on
  `(account_id, name, language)` (#534).
- `meta_template_id` is globally unique per WABA; the lookup does not
  filter by user, so a theoretical cross-tenant id collision updates both
  rows and logs a warning.

## Media

**Outbound** — the composer and Flow `send_media` node upload to the
public `chat-media` bucket and store a durable public URL, so Meta can
fetch without credentials. Path `account-<account_id>/<timestamp>-<name>.<ext>`;
16 MB cap; MIME allow-list per migration 023 widened by 039.

**Inbound** — copied into the same bucket under
`account-<id>/inbound/…` by `mirror-inbound-media.ts` (issue #466).
Meta deletes media ~30 days after receipt; before the mirror the CRM
stored only the proxy pointer, so every inbound attachment silently
rotted. Path determinism comes from the Meta media id plus the message
timestamp. Filenames are derived from MIME
(`EXTENSION_BY_MIME` in `src/lib/media/filename.ts`) and, for documents,
the sender's own `document.filename`.

**`GET /api/whatsapp/media/[mediaId]`** — session required; resolves the
caller's `account_id`, loads that account's config, `getMediaUrl()` then
`downloadMedia()`, streams the bytes with `Cache-Control: public,
max-age=86400`. It never accepts an arbitrary token. It remains as the
fallback when mirroring is off or fails.

## Contact / conversation matching

| Layer | Key | Mechanism |
| --- | --- | --- |
| Inbound webhook | BSUID first, phone second | exact index match, then `findExistingContact` (last-8 SQL pre-filter + strict JS match) |
| Inbound webhook | conversation | `(account_id, contact_id)`, `ORDER BY created_at ASC LIMIT 1` |
| Public API by phone | phone | `resolveConversationByPhone()` → same `findExistingContact` helper, then the same one-conversation-per-(account, contact) lookup |
| Dashboard by `contact_id` | contact id | `findOrCreateConversation()` in `send/route.ts` (`.maybeSingle()` here, unlike the webhook — a mild inconsistency) |
| DB guarantee | phone | `UNIQUE (account_id, phone_normalized) WHERE phone_normalized <> ''` (022) |
| DB guarantee | BSUID | `UNIQUE (account_id, wa_user_id) WHERE wa_user_id IS NOT NULL` (040) |
| DB guarantee | conversation | `UNIQUE (account_id, contact_id)` (036) |

All three insert paths handle a `23505` race by re-resolving the winner
rather than dropping the message.

## Multi-WABA / multi-account routing

- **Routing key** is `phone_number_id` from
  `value.metadata.phone_number_id`, looked up in `whatsapp_config`.
- **Multi-account** — several wacrm accounts, each with its own row,
  each with its own `phone_number_id` / `waba_id` / token. Meta delivers
  every subscribed WABA to the one callback URL; the webhook fans out by
  `phone_number_id`.
- **Multi-WABA per Meta App** — works out of the box; each wacrm account
  enters its own WABA id.
- **WABAs under different Meta Apps** — `META_APP_SECRET` takes a
  comma-separated list; a delivery is accepted if its signature matches
  any. `META_APP_ID` remains a single value and only affects image-header
  template uploads (`docs/multi-waba.md` Setup C).
- **Verify token** — the handshake accepts **any** account's verify
  token, so one string works for every WABA on the deployment.
- **Cross-account collision is refused** — `POST /api/whatsapp/config`
  returns 409 when a `phone_number_id` is already claimed by another
  account; the global `UNIQUE (phone_number_id)` (013) backs it.
- **One number per account** — `UNIQUE (account_id)` on
  `whatsapp_config` (017).

## Idempotency, deduplication and retries

| Concern | Mechanism |
| --- | --- |
| Inbound webhook replay | `upsert(..., { onConflict: 'conversation_id,message_id', ignoreDuplicates: true }).select('id')` — empty result short-circuits all fan-out |
| Contact creation race | `23505` → re-resolve by BSUID, then phone |
| Conversation creation race | `23505` → re-resolve oldest-first |
| Duplicate contacts (historical) | migration 022's merge; the partial unique index prevents new ones |
| Duplicate conversations (historical) | migration 036's merge; the webhook uses `LIMIT 1` so lookups converge on the survivor |
| Lost unread increments | `bump_conversation_on_inbound` RPC, `service_role` only |
| Duplicate initial enquiries | zero-history read, then `23505` on `idx_enquiries_one_active_per_conversation` → adopt the winner |
| Lost initial enquiry (transient DB failure) | logged and swallowed; the next inbound message retries, because the rule is "no enquiry history yet" |
| Lost automation/flow counters | `increment_automation_execution_count` / `increment_flow_execution_count` |
| Orphaned broadcast parents | `create_broadcast_with_recipients` RPC (037 → 038 → 041) |
| Status regression | `isValidStatusTransition` forward-only ladder |
| Broadcast resume | `broadcast-resume.ts` + `POST /api/whatsapp/broadcast/[id]/resume` |
| Media URL expiry | inbound mirror into `chat-media` |

**Retries Meta performs** are inbound only: a non-2xx or slow ack makes
Meta redeliver the same payload, which the idempotency boundary absorbs.
**Retries wacrm performs** are the outbound `phoneVariants` loop
(narrow — only on "recipient not allowed") and the broadcast variant
loop. There is no general outbound retry queue.

## Relevant database objects

Tables: `whatsapp_config`, `messages`, `message_reactions`,
`broadcast_recipients`, `contacts`, `conversations`, `message_templates`.

Indexes/constraints that carry correctness:

- `whatsapp_config_account_id_key` — `UNIQUE (account_id)`
- `whatsapp_config_phone_number_id_key` — `UNIQUE (phone_number_id)` (013)
- `idx_messages_conversation_message_id` — `UNIQUE (conversation_id,
  message_id)` (037)
- `idx_contacts_account_wa_user_id` — partial unique on BSUID (040)
- migration 022's partial unique on `(account_id, phone_normalized)`
- migration 036's unique on `(account_id, contact_id)`
- `broadcast_recipients.whatsapp_message_id` (003)
- `idx_enquiries_one_active_per_conversation` — partial unique on
  `conversation_id` for non-terminal enquiries (045); this is what makes
  concurrent initial activation converge on one row

Functions: `bump_conversation_on_inbound` (037, `service_role` only),
`create_broadcast_with_recipients` (041, `service_role` only),
`is_valid_enquiry_state_transition` / `guard_enquiry_write` /
`audit_enquiry_state_change` (045), `is_account_member` (017,
`SECURITY DEFINER`), `handle_new_user` (017).

Triggers: `set_updated_at` on `whatsapp_config`,
`broadcast_recipient_aggregate_trigger`.

Storage: `chat-media` bucket with account-scoped write RLS (020, 023,
039).

RLS on `whatsapp_config`: `viewer` SELECT, `admin+` INSERT / UPDATE /
DELETE (017).

## Important files and functions

Connection / config
- `POST /api/whatsapp/config` — `src/app/api/whatsapp/config/route.ts`
- `GET /api/whatsapp/config`, `DELETE`
- `GET /api/whatsapp/config/verify-registration`
- `registerPhoneNumber`, `subscribeWabaToApp`, `getSubscribedApps`,
  `verifyPhoneNumber`, `listWabaPhoneNumbers` — `meta-api.ts`
- `isNumericMetaId`, `phoneNumberBelongsToWaba`,
  `describeWabaPhoneMismatch`, `appSubscriptionState` — `waba-pairing.ts`
- `explainMetaError`, `metaErrorPayload`, `MetaConnectStep` —
  `meta-error-explain.ts`
- `WhatsAppConfig()` — `src/components/settings/whatsapp-config.tsx`

Webhook
- `GET` / `POST` / `processWebhook` / `processMessage` /
  `parseMessageContent` / `handleStatusUpdate` / `handleReaction` /
  `findOrCreateContact` / `findOrCreateConversation` /
  `flagBroadcastReplyIfAny` / `lookupInternalIdByMetaId` /
  `contactIdentityPatch` / `isValidStatusTransition` —
  `src/app/api/whatsapp/webhook/route.ts`
- `verifyMetaWebhookSignature`, `parseAppSecrets` — `webhook-signature.ts`
- `handleTemplateWebhookChange`, `isTemplateWebhookField` —
  `template-webhook.ts`
- `mirrorInboundMedia` — `mirror-inbound-media.ts`

Identity / matching
- `resolveInboundIdentity`, `hasUsableIdentity`,
  `identityDisplayName`, `resolveContactSendTarget`, `contactHandle`,
  `isBusinessScopedUserId` — `wa-identity.ts`
- `normalizePhone`, `sanitizePhoneForMeta`, `isValidE164`,
  `phoneVariants`, `isRecipientNotAllowedError` — `phone-utils.ts`
- `findExistingContact`, `isUniqueViolation` — `src/lib/contacts/dedupe.ts`
- `resolveConversationByPhone` — `resolve-conversation.ts`
- `reopenClosedConversation` — `src/lib/conversations/reopen.ts`

Outbound
- `sendMessageToConversation`, `validateSendMessageParams`,
  `SendMessageError` — `send-message.ts`
- `sendTextMessage`, `sendTemplateMessage`, `sendMediaMessage`,
  `sendInteractiveButtons`, `sendInteractiveList`,
  `sendReactionMessage`, `getMediaUrl`, `downloadMedia`,
  `recipientFields`, `MetaApiError` — `meta-api.ts`
- `createBroadcast`, `deliverBroadcast`, `BroadcastError` —
  `broadcast-core.ts`
- `encrypt`, `decrypt`, `isLegacyFormat` — `encryption.ts`

## Known current limitations

Structural facts about today's implementation. Each is stated with its
evidence; none is a proposal.

1. **One WhatsApp number per account, one owner per number.** Enforced by
   `UNIQUE (account_id)` (017) and `UNIQUE (phone_number_id)` (013), plus
   the explicit 409 in `POST /api/whatsapp/config`. There is no
   primary/secondary notion, and no concept of more than one identity on
   a number.
2. **No coexistence, no onboarding, no echo, no history sync.** A
   repository-wide search for `coexist`, `smb_message_echoes`,
   `whatsapp_business_app_onboarding`, message echoes, chat-history sync,
   Embedded Signup and an OAuth flow finds **no** implementation. The
   only `embedded signup` reference is a comment in `meta-api.ts`
   explaining that a number previously claimed by the app that ran
   Embedded Signup is why `/register` is needed. Connection is manual:
   the operator pastes ids and a System User token.
3. **System-user-token assumption is implicit.** Nothing records which
   business portfolio, system user, or app a token belongs to. Meta
   calls are made with the account's stored token; there is no
   exchange, refresh, expiry, or scope introspection, and no `app_id`
   column on `whatsapp_config`. `META_APP_ID` / `META_APP_SECRET` are
   deployment-wide env vars, which is exactly why
   `docs/multi-waba.md` Setup C exists.
4. **Inbound webhook drops message-only deliveries.** The guard is
   `if (!value.messages || !value.contacts) continue`, even though
   `wa-identity` can resolve a sender from message-level fields alone.
   A delivery with `messages` but no `contacts` is discarded.
5. **The PIN is never stored and never verifiable locally.** It is
   passed to `/register` and discarded. Whether the number has 2FA
   enabled is never checked, so "no PIN supplied" is the only signal
   distinguishing "skip registration" from "registration needed".
6. **Registration failure is non-fatal by design.** The row is saved
   with `status: 'disconnected'` and `registered_at: null`, so a broken
   setup can persist indefinitely; only the UI banner and the diagnostic
   endpoint surface it.
7. **Access-token scope failures are partly non-fatal.** A `subscribed_apps`
   failure in the GET health check is reported as a sub-object rather
   than failing the check, so "connected" can coexist with an
   unreadable subscription state.
8. **Everything inbound is phone-or-BSUID keyed per account.** Identity is
   resolved only within the `account_id` that owns the
   `phone_number_id`. There is no cross-account identity linkage.
9. **Template lifecycle webhooks require manual Meta configuration.**
   The three `message_template_*` fields are not subscribed by default
   and cannot be subscribed via API; status can silently go stale until
   someone presses "Sync from Meta".
10. **`META_APP_ID` is single-valued**, so with several Meta Apps only one
    app can serve image-header template uploads (`docs/multi-waba.md`
    Setup C documents the workarounds).
11. **`meta-api.ts` is 42 KB** with every Graph call in one module. Named
    single-object parameters were introduced precisely because a
    swapped-args bug (`getMediaUrl(mediaId, accessToken)` vs
    `(accessToken, mediaId)`) had been found four times; the comment
    states the convention is load-bearing.
12. **No chat-history backfill of any kind.** Inbound history begins at
    the first webhook delivery after `/{phone_number_id}/register`.
13. **Message-status handling is config-independent.** Statuses are
    matched by `message_id` alone (0..N rows), with no `phone_number_id`
    filter, so a status can in principle be applied to a message row
    belonging to a different number that shares the id.
14. **The media mirror is unbounded in storage growth.** Mitigated only
    by the per-account `mirror_inbound_media` opt-out and the 16 MB
    per-object cap.
15. **`src/app/api/whatsapp/send/route.ts` uses `.maybeSingle()`** for its
    conversation lookup while the webhook and `resolve-conversation.ts`
    both use `ORDER BY created_at ASC LIMIT 1`. If pre-036 duplicates
    exist for a contact, this path can error where the others converge.
