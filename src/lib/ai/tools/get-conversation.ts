import type { SupabaseClient } from '@supabase/supabase-js';

import type { ContentType, MessageStatus, SenderType } from '@/types';
import {
  isEnquiryWorkflowState,
  type EnquiryWorkflowState,
} from '@/lib/enquiries/model';

import { defineReadTool, ToolError } from './contract';
import {
  isRecord,
  loadActiveEnquiry,
  parseRequiredId,
  toToolEnquiryContext,
  unavailable,
  type ToolEnquiryContext,
} from './shared';

export const GET_CONVERSATION_DEFAULT_MESSAGE_LIMIT = 20;
export const GET_CONVERSATION_MAX_MESSAGE_LIMIT = 50;
export const GET_CONVERSATION_MAX_MESSAGE_CHARS = 2_000;
export const GET_CONVERSATION_MAX_MEDIA_REFERENCE_CHARS = 2_048;
export const GET_CONVERSATION_ENQUIRY_TRANSITION_LIMIT = 20;

export interface GetConversationInput {
  conversation_id: string;
  recent_message_limit?: number;
}

export interface ToolConversationMessage {
  id: string;
  direction: 'inbound' | 'outbound';
  sender_type: SenderType;
  content_type: ContentType;
  content_text: string | null;
  content_truncated: boolean;
  media: {
    reference: string | null;
    reference_truncated: boolean;
    mime_type: string | null;
  } | null;
  status: MessageStatus;
  created_at: string;
  reply_to_message_id: string | null;
  interactive_reply_id: string | null;
  ai_generated: boolean;
}

export interface ToolEnquiryTransition {
  enquiry_id: string;
  previous_state: EnquiryWorkflowState | null;
  new_state: EnquiryWorkflowState;
  changed_at: string;
  changed_by_user_id: string | null;
}

export interface GetConversationOutput {
  conversation_id: string;
  status: 'open' | 'pending' | 'closed';
  customer: {
    contact_id: string;
    name: string | null;
    phone: string | null;
    whatsapp_identity: {
      wa_user_id: string | null;
      wa_parent_user_id: string | null;
      wa_username: string | null;
    };
  };
  recent_messages: ToolConversationMessage[];
  active_enquiry: ToolEnquiryContext | null;
  enquiry_recent_transitions: ToolEnquiryTransition[];
  context_window: {
    message_limit: number;
    returned_messages: number;
    has_earlier_messages: boolean;
    message_text_max_chars: number;
    enquiry_transition_limit: number;
    returned_enquiry_transitions: number;
    has_earlier_enquiry_transitions: boolean;
  };
  freshness: {
    source: 'wacrm';
    retrieved_at: string;
    conversation_updated_at: string;
    active_enquiry_updated_at: string | null;
  };
}

interface ConversationRow {
  id: string;
  contact_id: string;
  status: 'open' | 'pending' | 'closed';
  updated_at: string;
}

interface ContactRow {
  id: string;
  name: string | null;
  phone: string;
  wa_user_id: string | null;
  wa_parent_user_id: string | null;
  wa_username: string | null;
}

interface MessageRow {
  id: string;
  sender_type: SenderType;
  content_type: ContentType;
  content_text: string | null;
  media_url: string | null;
  media_type: string | null;
  status: MessageStatus;
  created_at: string;
  reply_to_message_id: string | null;
  interactive_reply_id: string | null;
  ai_generated: boolean;
}

interface EnquiryIdRow {
  id: string;
}

interface EnquiryStateEventRow {
  id: string;
  enquiry_id: string;
  from_state: string | null;
  to_state: string;
  changed_by_user_id: string | null;
  changed_at: string;
}

export const getConversationTool = defineReadTool<
  GetConversationInput,
  GetConversationOutput
>('get_conversation', async (context, rawInput) => {
  const input = parseInput(rawInput);
  const conversation = await loadConversation(
    context.db,
    context.account_id,
    input.conversation_id
  );
  if (!conversation) {
    // Unknown and foreign IDs intentionally collapse to the same result.
    throw new ToolError('not_found', 'Conversation not found');
  }

  const contact = await loadContact(
    context.db,
    context.account_id,
    conversation.contact_id
  );
  if (!contact) {
    throw new ToolError('not_found', 'Conversation customer not found');
  }

  const [messageResult, enquiry, transitionResult] = await Promise.all([
    loadMessages(context.db, conversation.id, input.recent_message_limit),
    loadActiveEnquiry(context.db, context.account_id, conversation.id),
    loadRecentEnquiryTransitions(
      context.db,
      context.account_id,
      conversation.id
    ),
  ]);
  const activeEnquiry = enquiry ? toToolEnquiryContext(enquiry) : null;

  return {
    conversation_id: conversation.id,
    status: conversation.status,
    customer: {
      contact_id: contact.id,
      name: contact.name ?? null,
      phone: contact.phone.trim() === '' ? null : contact.phone,
      whatsapp_identity: {
        wa_user_id: contact.wa_user_id ?? null,
        wa_parent_user_id: contact.wa_parent_user_id ?? null,
        wa_username: contact.wa_username ?? null,
      },
    },
    recent_messages: messageResult.messages,
    active_enquiry: activeEnquiry,
    enquiry_recent_transitions: transitionResult.transitions,
    context_window: {
      message_limit: input.recent_message_limit,
      returned_messages: messageResult.messages.length,
      has_earlier_messages: messageResult.hasEarlier,
      message_text_max_chars: GET_CONVERSATION_MAX_MESSAGE_CHARS,
      enquiry_transition_limit: GET_CONVERSATION_ENQUIRY_TRANSITION_LIMIT,
      returned_enquiry_transitions: transitionResult.transitions.length,
      has_earlier_enquiry_transitions: transitionResult.hasEarlier,
    },
    freshness: {
      source: 'wacrm',
      retrieved_at: new Date().toISOString(),
      conversation_updated_at: conversation.updated_at,
      active_enquiry_updated_at: activeEnquiry?.updated_at ?? null,
    },
  };
});

function parseInput(input: unknown): Required<GetConversationInput> {
  if (!isRecord(input)) {
    throw new ToolError('invalid_input', 'Tool input must be an object');
  }
  const conversationId = parseRequiredId(
    input.conversation_id,
    'conversation_id'
  );
  const rawLimit = input.recent_message_limit;
  const limit =
    rawLimit === undefined ? GET_CONVERSATION_DEFAULT_MESSAGE_LIMIT : rawLimit;
  if (
    typeof limit !== 'number' ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > GET_CONVERSATION_MAX_MESSAGE_LIMIT
  ) {
    throw new ToolError(
      'invalid_input',
      `recent_message_limit must be an integer from 1 to ${GET_CONVERSATION_MAX_MESSAGE_LIMIT}`
    );
  }
  return { conversation_id: conversationId, recent_message_limit: limit };
}

async function loadConversation(
  db: SupabaseClient,
  accountId: string,
  conversationId: string
): Promise<ConversationRow | null> {
  const { data, error } = await db
    .from('conversations')
    .select('id,contact_id,status,updated_at')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw unavailable('Could not load conversation');
  return (data as ConversationRow | null) ?? null;
}

async function loadContact(
  db: SupabaseClient,
  accountId: string,
  contactId: string
): Promise<ContactRow | null> {
  const { data, error } = await db
    .from('contacts')
    .select('id,name,phone,wa_user_id,wa_parent_user_id,wa_username')
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw unavailable('Could not load conversation customer');
  return (data as ContactRow | null) ?? null;
}

async function loadMessages(
  db: SupabaseClient,
  conversationId: string,
  limit: number
): Promise<{ messages: ToolConversationMessage[]; hasEarlier: boolean }> {
  const { data, error } = await db
    .from('messages')
    .select(
      [
        'id',
        'sender_type',
        'content_type',
        'content_text',
        'media_url',
        'media_type',
        'status',
        'created_at',
        'reply_to_message_id',
        'interactive_reply_id',
        'ai_generated',
      ].join(',')
    )
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit + 1);
  if (error) throw unavailable('Could not load conversation messages');

  // The column list is assembled at runtime, so PostgREST cannot infer a
  // row type; the shape is declared locally and validated by the caller.
  const rows = (data ?? []) as unknown as MessageRow[];
  const newestFirst = rows.slice(0, limit);
  return {
    messages: newestFirst.reverse().map(toToolMessage),
    hasEarlier: rows.length > limit,
  };
}

async function loadRecentEnquiryTransitions(
  db: SupabaseClient,
  accountId: string,
  conversationId: string
): Promise<{ transitions: ToolEnquiryTransition[]; hasEarlier: boolean }> {
  // Each enquiry has at least its trigger-written creation event. Looking at
  // at most limit + 1 newest enquiries is therefore sufficient to find the
  // limit + 1 newest events without an unbounded enquiry-id read.
  const { data: enquiryData, error: enquiryError } = await db
    .from('enquiries')
    .select('id')
    .eq('account_id', accountId)
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(GET_CONVERSATION_ENQUIRY_TRANSITION_LIMIT + 1);
  if (enquiryError) throw unavailable('Could not load enquiry history');

  const enquiryIds = ((enquiryData ?? []) as EnquiryIdRow[]).map(
    (enquiry) => enquiry.id
  );
  if (enquiryIds.length === 0) {
    return { transitions: [], hasEarlier: false };
  }

  const { data, error } = await db
    .from('enquiry_state_events')
    .select('id,enquiry_id,from_state,to_state,changed_by_user_id,changed_at')
    .eq('account_id', accountId)
    .in('enquiry_id', enquiryIds)
    .order('changed_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(GET_CONVERSATION_ENQUIRY_TRANSITION_LIMIT + 1);
  if (error) throw unavailable('Could not load enquiry state history');

  const rows = (data ?? []) as EnquiryStateEventRow[];
  const newest = rows.slice(0, GET_CONVERSATION_ENQUIRY_TRANSITION_LIMIT);
  return {
    transitions: newest.reverse().map(toToolEnquiryTransition),
    hasEarlier: rows.length > GET_CONVERSATION_ENQUIRY_TRANSITION_LIMIT,
  };
}

function toToolEnquiryTransition(
  event: EnquiryStateEventRow
): ToolEnquiryTransition {
  if (
    (event.from_state !== null && !isEnquiryWorkflowState(event.from_state)) ||
    !isEnquiryWorkflowState(event.to_state)
  ) {
    throw new ToolError('internal', 'Stored enquiry state history is invalid');
  }
  return {
    enquiry_id: event.enquiry_id,
    previous_state: event.from_state,
    new_state: event.to_state,
    changed_at: event.changed_at,
    changed_by_user_id: event.changed_by_user_id ?? null,
  };
}

function toToolMessage(message: MessageRow): ToolConversationMessage {
  const text = message.content_text ?? null;
  const contentTruncated =
    text !== null && text.length > GET_CONVERSATION_MAX_MESSAGE_CHARS;
  const mediaReference = message.media_url ?? null;
  const referenceTruncated =
    mediaReference !== null &&
    mediaReference.length > GET_CONVERSATION_MAX_MEDIA_REFERENCE_CHARS;
  const hasMedia =
    message.content_type === 'image' ||
    message.content_type === 'document' ||
    message.content_type === 'audio' ||
    message.content_type === 'video' ||
    mediaReference !== null ||
    message.media_type !== null;

  return {
    id: message.id,
    direction: message.sender_type === 'customer' ? 'inbound' : 'outbound',
    sender_type: message.sender_type,
    content_type: message.content_type,
    content_text: contentTruncated
      ? text!.slice(0, GET_CONVERSATION_MAX_MESSAGE_CHARS)
      : text,
    content_truncated: contentTruncated,
    media: hasMedia
      ? {
          reference: referenceTruncated ? null : mediaReference,
          reference_truncated: referenceTruncated,
          mime_type: message.media_type ?? null,
        }
      : null,
    status: message.status,
    created_at: message.created_at,
    reply_to_message_id: message.reply_to_message_id ?? null,
    interactive_reply_id: message.interactive_reply_id ?? null,
    ai_generated: message.ai_generated === true,
  };
}
