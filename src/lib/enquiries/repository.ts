import type { SupabaseClient } from '@supabase/supabase-js';

import {
  ACTIVE_ENQUIRY_STATES,
  assertValidEnquiryTransition,
  INITIAL_ENQUIRY_STATE,
  parseEnquiry,
  parseEnquiryFactsPatch,
  type Enquiry,
  type EnquiryFactsPatch,
  type EnquiryWorkflowState,
} from './model';

export const ENQUIRY_COLUMNS = [
  'id',
  'account_id',
  'conversation_id',
  'created_by_user_id',
  'workflow_state',
  'customer_intent',
  'postcode',
  'address',
  'property_type',
  'floor',
  'lift_available',
  'parking',
  'access_constraints',
  'item_descriptions',
  'waste_type',
  'estimated_volume',
  'heavy_special_items',
  'photos_received',
  'preferred_date',
  'preferred_time_window',
  'missing_information',
  'state_changed_at',
  'created_at',
  'updated_at',
].join(',');

export class EnquiryRepositoryError extends Error {
  readonly code: 'not_found' | 'conflict' | 'database_error';

  constructor(code: EnquiryRepositoryError['code'], message: string) {
    super(message);
    this.name = 'EnquiryRepositoryError';
    this.code = code;
  }
}

export async function createEnquiry(
  db: SupabaseClient,
  input: {
    accountId: string;
    conversationId: string;
    createdByUserId: string;
    facts?: EnquiryFactsPatch;
  }
): Promise<Enquiry> {
  const facts = parseEnquiryFactsPatch(input.facts ?? {});

  const { data: conversation, error: conversationError } = await db
    .from('conversations')
    .select('id')
    .eq('id', input.conversationId)
    .eq('account_id', input.accountId)
    .maybeSingle();

  if (conversationError) {
    throw databaseError('Could not verify the enquiry conversation');
  }
  if (!conversation) {
    throw new EnquiryRepositoryError('not_found', 'Conversation not found');
  }

  const { data, error } = await db
    .from('enquiries')
    .insert({
      account_id: input.accountId,
      conversation_id: input.conversationId,
      created_by_user_id: input.createdByUserId,
      workflow_state: INITIAL_ENQUIRY_STATE,
      ...facts,
    })
    .select(ENQUIRY_COLUMNS)
    .single();

  if (error?.code === '23505') {
    throw new EnquiryRepositoryError(
      'conflict',
      'This conversation already has an active enquiry'
    );
  }
  if (error || !data) {
    throw databaseError('Could not create enquiry');
  }

  return parseEnquiry(data);
}

export interface EnsureInitialEnquiryResult {
  enquiry: Enquiry;
  /**
   * True only when this call inserted the row. False means the enquiry
   * already existed — either from an earlier message on the same thread or
   * from a concurrent delivery that won the insert race.
   */
  created: boolean;
}

export interface CreateRepeatEnquiryResult {
  enquiry: Enquiry;
  /** False only when this approved idempotency key already created the row. */
  created: boolean;
}

/**
 * Start a second-or-later job explicitly after every prior enquiry is closed.
 * The database unique indexes are the final race backstop; the idempotency
 * metadata lets a retry distinguish its own winning row from another action.
 */
export async function createRepeatEnquiry(
  db: SupabaseClient,
  input: {
    accountId: string;
    conversationId: string;
    createdByUserId: string;
    idempotencyKey: string;
    approvalId: string;
    correlationId: string;
  }
): Promise<CreateRepeatEnquiryResult> {
  const replay = await getRepeatEnquiryByIdempotencyKey(
    db,
    input.accountId,
    input.idempotencyKey
  );
  if (replay) {
    if (replay.conversation_id !== input.conversationId) {
      throw new EnquiryRepositoryError(
        'conflict',
        'The idempotency key was already used for another conversation'
      );
    }
    return { enquiry: replay, created: false };
  }

  const { data: conversation, error: conversationError } = await db
    .from('conversations')
    .select('id')
    .eq('id', input.conversationId)
    .eq('account_id', input.accountId)
    .maybeSingle();
  if (conversationError) {
    throw databaseError('Could not verify the repeat-enquiry conversation');
  }
  if (!conversation) {
    throw new EnquiryRepositoryError('not_found', 'Conversation not found');
  }

  const history = await getConversationEnquiry(
    db,
    input.accountId,
    input.conversationId
  );
  if (!history) {
    throw new EnquiryRepositoryError(
      'conflict',
      'A repeat enquiry requires existing enquiry history'
    );
  }

  const { data: active, error: activeError } = await db
    .from('enquiries')
    .select('id')
    .eq('account_id', input.accountId)
    .eq('conversation_id', input.conversationId)
    .in('workflow_state', [...ACTIVE_ENQUIRY_STATES])
    .limit(1)
    .maybeSingle();
  if (activeError) {
    throw databaseError('Could not verify active enquiry state');
  }
  if (active) {
    throw new EnquiryRepositoryError(
      'conflict',
      'This conversation already has an active enquiry'
    );
  }

  const { data, error } = await db
    .from('enquiries')
    .insert({
      account_id: input.accountId,
      conversation_id: input.conversationId,
      created_by_user_id: input.createdByUserId,
      workflow_state: INITIAL_ENQUIRY_STATE,
      repeat_action_idempotency_key: input.idempotencyKey,
      repeat_action_approval_id: input.approvalId,
      repeat_action_correlation_id: input.correlationId,
    })
    .select(ENQUIRY_COLUMNS)
    .single();

  if (error?.code === '23505') {
    const winner = await getRepeatEnquiryByIdempotencyKey(
      db,
      input.accountId,
      input.idempotencyKey
    );
    if (winner && winner.conversation_id === input.conversationId) {
      return { enquiry: winner, created: false };
    }
    throw new EnquiryRepositoryError(
      'conflict',
      'This conversation already has an active enquiry'
    );
  }
  if (error || !data) {
    throw databaseError('Could not create repeat enquiry');
  }

  return { enquiry: parseEnquiry(data), created: true };
}

async function getRepeatEnquiryByIdempotencyKey(
  db: SupabaseClient,
  accountId: string,
  idempotencyKey: string
): Promise<Enquiry | null> {
  const { data, error } = await db
    .from('enquiries')
    .select(ENQUIRY_COLUMNS)
    .eq('account_id', accountId)
    .eq('repeat_action_idempotency_key', idempotencyKey)
    .maybeSingle();
  if (error) {
    throw databaseError('Could not resolve repeat-enquiry idempotency');
  }
  return data ? parseEnquiry(data) : null;
}

/**
 * Guarantee that a conversation has its FIRST enquiry, and only its first.
 *
 * The activation rule is deliberately narrow: an enquiry is created only
 * when the conversation has no enquiry rows AT ALL. It is not "create one
 * whenever there is no *active* enquiry", because that would silently turn
 * every post-completion "thanks!" into a repeat job. Repeat-job creation
 * belongs to an explicit business action, not to message ingestion.
 *
 * Idempotency and race safety come from the database, not from this read:
 *
 *   - The account-scoped existence read is the fast path. It also covers
 *     terminal-only histories, where the partial unique index would
 *     happily allow a second row.
 *   - `idx_enquiries_one_active_per_conversation` rejects a concurrent
 *     second insert with a unique violation, because `new_enquiry` is
 *     non-terminal. That violation is caught and resolved back to the
 *     winning row, so parallel first deliveries converge on one enquiry
 *     instead of racing to a constraint error.
 *
 * The composite foreign key on `(conversation_id, account_id)` and the
 * conversation existence check inside {@link createEnquiry} are what keep
 * this account-scoped on service-role writes that bypass RLS.
 *
 * Callers on an authoritative-write path (inbound ingestion) must treat a
 * throw as non-fatal and retry on the next qualifying event: the rule
 * above means a failed first activation is self-healing.
 */
export async function ensureInitialEnquiryForConversation(
  db: SupabaseClient,
  input: {
    accountId: string;
    conversationId: string;
    createdByUserId: string;
  }
): Promise<EnsureInitialEnquiryResult> {
  const existing = await getFirstConversationEnquiry(
    db,
    input.accountId,
    input.conversationId
  );
  if (existing) {
    return { enquiry: existing, created: false };
  }

  try {
    return {
      enquiry: await createEnquiry(db, {
        accountId: input.accountId,
        conversationId: input.conversationId,
        createdByUserId: input.createdByUserId,
      }),
      created: true,
    };
  } catch (error) {
    // Lost the insert race against a concurrent first delivery. Re-read and
    // adopt the winner. Only the one-active-per-conversation index can
    // produce 23505 here: `id` is server-generated, and
    // `enquiries_id_account_key` is derived from that same id.
    if (error instanceof EnquiryRepositoryError && error.code === 'conflict') {
      const winner = await getFirstConversationEnquiry(
        db,
        input.accountId,
        input.conversationId
      );
      if (winner) {
        return { enquiry: winner, created: false };
      }
    }
    throw error;
  }
}

/**
 * Oldest enquiry on a conversation, whatever its state.
 *
 * Distinct from {@link getConversationEnquiry}, which returns the newest
 * row as "the current one". This one answers "has this thread ever had an
 * enquiry?", which is the question the initial-activation rule asks.
 */
async function getFirstConversationEnquiry(
  db: SupabaseClient,
  accountId: string,
  conversationId: string
): Promise<Enquiry | null> {
  const { data, error } = await db
    .from('enquiries')
    .select(ENQUIRY_COLUMNS)
    .eq('account_id', accountId)
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw databaseError('Could not load conversation enquiry history');
  }
  return data ? parseEnquiry(data) : null;
}

/** Latest enquiry for a conversation, including a terminal one. */
export async function getConversationEnquiry(
  db: SupabaseClient,
  accountId: string,
  conversationId: string
): Promise<Enquiry | null> {
  const { data, error } = await db
    .from('enquiries')
    .select(ENQUIRY_COLUMNS)
    .eq('account_id', accountId)
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw databaseError('Could not load conversation enquiry');
  }
  return data ? parseEnquiry(data) : null;
}

export async function getEnquiry(
  db: SupabaseClient,
  accountId: string,
  enquiryId: string
): Promise<Enquiry | null> {
  const { data, error } = await db
    .from('enquiries')
    .select(ENQUIRY_COLUMNS)
    .eq('id', enquiryId)
    .eq('account_id', accountId)
    .maybeSingle();

  if (error) {
    throw databaseError('Could not load enquiry');
  }
  return data ? parseEnquiry(data) : null;
}

export async function updateEnquiryFacts(
  db: SupabaseClient,
  input: {
    accountId: string;
    enquiryId: string;
    facts: EnquiryFactsPatch;
  }
): Promise<Enquiry> {
  const facts = parseEnquiryFactsPatch(input.facts);
  if (Object.keys(facts).length === 0) {
    const existing = await getEnquiry(db, input.accountId, input.enquiryId);
    if (!existing) {
      throw new EnquiryRepositoryError('not_found', 'Enquiry not found');
    }
    return existing;
  }

  const { data, error } = await db
    .from('enquiries')
    .update(facts)
    .eq('id', input.enquiryId)
    .eq('account_id', input.accountId)
    .select(ENQUIRY_COLUMNS)
    .maybeSingle();

  if (error) {
    throw databaseError('Could not update enquiry facts');
  }
  if (!data) {
    throw new EnquiryRepositoryError('not_found', 'Enquiry not found');
  }
  return parseEnquiry(data);
}

export async function transitionEnquiry(
  db: SupabaseClient,
  input: {
    accountId: string;
    enquiryId: string;
    to: EnquiryWorkflowState;
  }
): Promise<Enquiry> {
  const current = await getEnquiry(db, input.accountId, input.enquiryId);
  if (!current) {
    throw new EnquiryRepositoryError('not_found', 'Enquiry not found');
  }

  assertValidEnquiryTransition(current.workflow_state, input.to);
  if (current.workflow_state === input.to) return current;

  const { data, error } = await db
    .from('enquiries')
    .update({ workflow_state: input.to })
    .eq('id', input.enquiryId)
    .eq('account_id', input.accountId)
    // Compare-and-set: a concurrent transition cannot be overwritten by
    // this caller's now-stale read.
    .eq('workflow_state', current.workflow_state)
    .select(ENQUIRY_COLUMNS)
    .maybeSingle();

  if (error) {
    throw databaseError('Could not transition enquiry');
  }
  if (!data) {
    throw new EnquiryRepositoryError(
      'conflict',
      'Enquiry state changed concurrently'
    );
  }
  return parseEnquiry(data);
}

function databaseError(message: string): EnquiryRepositoryError {
  return new EnquiryRepositoryError('database_error', message);
}
