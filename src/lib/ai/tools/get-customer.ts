import type { SupabaseClient } from '@supabase/supabase-js';

import type { Enquiry } from '@/lib/enquiries/model';

import { defineReadTool, ToolError } from './contract';
import {
  isRecord,
  loadActiveEnquiry,
  loadHistoricalEnquiries,
  parseOptionalId,
  toToolEnquiryContext,
  truncateNullable,
  unavailable,
  type ToolEnquiryContext,
} from './shared';

export const GET_CUSTOMER_MAX_TAGS = 20;
export const GET_CUSTOMER_MAX_NOTES = 5;
export const GET_CUSTOMER_MAX_HISTORICAL_ENQUIRIES = 3;
export const GET_CUSTOMER_MAX_NOTE_CHARS = 1_000;

export interface GetCustomerInput {
  contact_id?: string;
  conversation_id?: string;
}

export interface GetCustomerOutput {
  customer_id: string;
  conversation_id: string | null;
  name: string | null;
  phone: string | null;
  whatsapp_identity: {
    wa_user_id: string | null;
    wa_parent_user_id: string | null;
    wa_username: string | null;
  };
  address: string | null;
  postcode: string | null;
  /**
   * Which canonical record the two fields above came from. `unknown`
   * means neither the active enquiry nor any closed one has recorded a
   * service address — the value is genuinely absent, not unread.
   *
   * A customer's address lives on the enquiry, never on the contact
   * (see docs/enquiry-state.md), so a returning customer's most recent
   * enquiry is the only non-invented source for it.
   */
  address_source: 'active_enquiry' | 'previous_enquiry' | 'unknown';
  tags: Array<{ id: string; name: string; color: string }>;
  notes: Array<{
    id: string;
    text: string;
    created_at: string;
    text_truncated: boolean;
  }>;
  active_enquiry: ToolEnquiryContext | null;
  previous_enquiries: ToolEnquiryContext[];
  freshness: {
    source: 'wacrm';
    retrieved_at: string;
    contact_updated_at: string;
    active_enquiry_updated_at: string | null;
  };
  bounds: {
    tags_limit: number;
    tags_truncated: boolean;
    notes_limit: number;
    notes_truncated: boolean;
    historical_enquiries_limit: number;
    historical_enquiries_truncated: boolean;
  };
}

interface ContactRow {
  id: string;
  name: string | null;
  phone: string;
  wa_user_id: string | null;
  wa_parent_user_id: string | null;
  wa_username: string | null;
  updated_at: string;
}

interface ConversationRow {
  id: string;
  contact_id: string;
}

interface ContactNoteRow {
  id: string;
  note_text: string;
  created_at: string;
}

interface ContactTagRow {
  id: string;
  tag_id: string;
}

interface TagRow {
  id: string;
  name: string;
  color: string;
}

export const getCustomerTool = defineReadTool<
  GetCustomerInput,
  GetCustomerOutput
>('get_customer', async (context, rawInput) => {
  const input = parseInput(rawInput);
  let conversation: ConversationRow | null = null;

  if (input.conversation_id) {
    conversation = await loadConversationById(
      context.db,
      context.account_id,
      input.conversation_id
    );
    if (!conversation) {
      throw new ToolError('not_found', 'Customer not found');
    }
  }

  const contactId = input.contact_id ?? conversation?.contact_id;
  if (!contactId) {
    throw new ToolError(
      'invalid_input',
      'contact_id or conversation_id is required'
    );
  }
  if (conversation && input.contact_id !== undefined) {
    if (conversation.contact_id !== input.contact_id) {
      throw new ToolError(
        'conflict',
        'contact_id does not match conversation_id'
      );
    }
  }

  const contact = await loadContact(context.db, context.account_id, contactId);
  if (!contact) throw new ToolError('not_found', 'Customer not found');

  if (!conversation) {
    conversation = await loadConversationByContact(
      context.db,
      context.account_id,
      contact.id
    );
  }

  const [tagResult, noteResult, activeEnquiry, historyResult] =
    await Promise.all([
      loadTags(context.db, context.account_id, contact.id),
      loadNotes(context.db, context.account_id, contact.id),
      conversation
        ? loadActiveEnquiry(context.db, context.account_id, conversation.id)
        : Promise.resolve(null),
      conversation
        ? loadHistoricalEnquiries(
            context.db,
            context.account_id,
            conversation.id,
            GET_CUSTOMER_MAX_HISTORICAL_ENQUIRIES
          )
        : Promise.resolve({ enquiries: [], truncated: false }),
    ]);

  const active = activeEnquiry ? toToolEnquiryContext(activeEnquiry) : null;

  return {
    customer_id: contact.id,
    conversation_id: conversation?.id ?? null,
    name: contact.name ?? null,
    phone: contact.phone.trim() === '' ? null : contact.phone,
    whatsapp_identity: {
      wa_user_id: contact.wa_user_id ?? null,
      wa_parent_user_id: contact.wa_parent_user_id ?? null,
      wa_username: contact.wa_username ?? null,
    },
    ...resolveServiceAddress(active, historyResult.enquiries),
    tags: tagResult.tags,
    notes: noteResult.notes,
    active_enquiry: active,
    previous_enquiries: historyResult.enquiries.map(toToolEnquiryContext),
    freshness: {
      source: 'wacrm',
      retrieved_at: new Date().toISOString(),
      contact_updated_at: contact.updated_at,
      active_enquiry_updated_at: active?.updated_at ?? null,
    },
    bounds: {
      tags_limit: GET_CUSTOMER_MAX_TAGS,
      tags_truncated: tagResult.truncated,
      notes_limit: GET_CUSTOMER_MAX_NOTES,
      notes_truncated: noteResult.truncated,
      historical_enquiries_limit: GET_CUSTOMER_MAX_HISTORICAL_ENQUIRIES,
      historical_enquiries_truncated: historyResult.truncated,
    },
  };
});

/**
 * Address and postcode are canonical on the enquiry, not on the contact.
 *
 * The active enquiry wins whenever it records either field. Otherwise the
 * most recent closed enquiry that actually recorded them is used, because a
 * returning customer at the same property is the common case. When no
 * enquiry holds a value the source is `unknown` and the fields stay null —
 * the contact's phone number is never mined for an address.
 */
function resolveServiceAddress(
  active: ToolEnquiryContext | null,
  history: Enquiry[]
): {
  address: string | null;
  postcode: string | null;
  address_source: GetCustomerOutput['address_source'];
} {
  const activeAddress = active?.facts.address ?? null;
  const activePostcode = active?.facts.postcode ?? null;
  if (activeAddress !== null || activePostcode !== null) {
    return {
      address: activeAddress,
      postcode: activePostcode,
      address_source: 'active_enquiry',
    };
  }

  for (const enquiry of history) {
    if (enquiry.address !== null || enquiry.postcode !== null) {
      return {
        address: enquiry.address,
        postcode: enquiry.postcode,
        address_source: 'previous_enquiry',
      };
    }
  }

  return { address: null, postcode: null, address_source: 'unknown' };
}

function parseInput(input: unknown): GetCustomerInput {
  if (!isRecord(input)) {
    throw new ToolError('invalid_input', 'Tool input must be an object');
  }
  const contactId = parseOptionalId(input.contact_id, 'contact_id');
  const conversationId = parseOptionalId(
    input.conversation_id,
    'conversation_id'
  );
  if (!contactId && !conversationId) {
    throw new ToolError(
      'invalid_input',
      'contact_id or conversation_id is required'
    );
  }
  return { contact_id: contactId, conversation_id: conversationId };
}

async function loadContact(
  db: SupabaseClient,
  accountId: string,
  contactId: string
): Promise<ContactRow | null> {
  const { data, error } = await db
    .from('contacts')
    .select('id,name,phone,wa_user_id,wa_parent_user_id,wa_username,updated_at')
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw unavailable('Could not load customer');
  return (data as ContactRow | null) ?? null;
}

async function loadConversationById(
  db: SupabaseClient,
  accountId: string,
  conversationId: string
): Promise<ConversationRow | null> {
  const { data, error } = await db
    .from('conversations')
    .select('id,contact_id')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw unavailable('Could not load customer conversation');
  return (data as ConversationRow | null) ?? null;
}

async function loadConversationByContact(
  db: SupabaseClient,
  accountId: string,
  contactId: string
): Promise<ConversationRow | null> {
  const { data, error } = await db
    .from('conversations')
    .select('id,contact_id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw unavailable('Could not load customer conversation');
  return (data as ConversationRow | null) ?? null;
}

async function loadNotes(
  db: SupabaseClient,
  accountId: string,
  contactId: string
): Promise<{ notes: GetCustomerOutput['notes']; truncated: boolean }> {
  const { data, error } = await db
    .from('contact_notes')
    .select('id,note_text,created_at')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(GET_CUSTOMER_MAX_NOTES + 1);
  if (error) throw unavailable('Could not load customer notes');

  const rows = (data ?? []) as ContactNoteRow[];
  return {
    notes: rows.slice(0, GET_CUSTOMER_MAX_NOTES).map((note) => {
      const truncatedFields = new Set<string>();
      return {
        id: note.id,
        text:
          truncateNullable(
            note.note_text,
            GET_CUSTOMER_MAX_NOTE_CHARS,
            'text',
            truncatedFields
          ) ?? '',
        created_at: note.created_at,
        text_truncated: truncatedFields.has('text'),
      };
    }),
    truncated: rows.length > GET_CUSTOMER_MAX_NOTES,
  };
}

async function loadTags(
  db: SupabaseClient,
  accountId: string,
  contactId: string
): Promise<{ tags: GetCustomerOutput['tags']; truncated: boolean }> {
  const { data: joins, error: joinError } = await db
    .from('contact_tags')
    .select('id,tag_id')
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(GET_CUSTOMER_MAX_TAGS + 1);
  if (joinError) throw unavailable('Could not load customer tags');

  const rows = (joins ?? []) as ContactTagRow[];
  const selected = rows.slice(0, GET_CUSTOMER_MAX_TAGS);
  if (selected.length === 0) {
    return { tags: [], truncated: rows.length > GET_CUSTOMER_MAX_TAGS };
  }

  const { data: tags, error: tagError } = await db
    .from('tags')
    .select('id,name,color')
    .eq('account_id', accountId)
    .in(
      'id',
      selected.map((join) => join.tag_id)
    );
  if (tagError) throw unavailable('Could not load customer tags');

  const tagsById = new Map(
    ((tags ?? []) as TagRow[]).map((tag) => [tag.id, tag] as const)
  );
  return {
    tags: selected
      .map((join) => tagsById.get(join.tag_id))
      .filter((tag): tag is TagRow => tag !== undefined),
    truncated: rows.length > GET_CUSTOMER_MAX_TAGS,
  };
}
