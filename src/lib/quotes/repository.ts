import type { SupabaseClient } from '@supabase/supabase-js';

import {
  parseQuote,
  parseQuoteEvent,
  type Quote,
  type QuoteCustomerDecision,
  type QuoteEvent,
  type QuoteOrigin,
  type QuoteProposal,
  type QuoteWorkflowStatus,
} from './model';

export const QUOTE_COLUMNS = [
  'id',
  'account_id',
  'enquiry_id',
  'revision_number',
  'status',
  'customer_decision',
  'origin',
  'currency',
  'amount_type',
  'fixed_amount_minor',
  'range_min_minor',
  'range_max_minor',
  'supersedes_quote_id',
  'superseded_by_quote_id',
  'recommendation_quote_id',
  'assumptions',
  'exclusions',
  'operator_notes',
  'source_reference',
  'source_observed_at',
  'override_reason',
  'override_reason_note',
  'created_by_user_id',
  'approved_at',
  'approved_by_user_id',
  'presented_at',
  'presented_by_user_id',
  'decision_recorded_at',
  'decision_recorded_by_user_id',
  'decision_note',
  'creation_idempotency_key',
  'last_action_idempotency_key',
  'last_action_by_user_id',
  'created_at',
  'updated_at',
].join(',');

export const QUOTE_EVENT_COLUMNS = [
  'id',
  'account_id',
  'quote_id',
  'event_type',
  'from_status',
  'to_status',
  'customer_decision',
  'actor_user_id',
  'idempotency_key',
  'occurred_at',
].join(',');

const CURRENT_QUOTE_STATUSES: QuoteWorkflowStatus[] = [
  'draft',
  'awaiting_approval',
  'approved',
  'presented',
];

export type QuoteRepositoryErrorCode =
  'not_found' | 'conflict' | 'invalid_input' | 'database_error';

export class QuoteRepositoryError extends Error {
  readonly code: QuoteRepositoryErrorCode;

  constructor(code: QuoteRepositoryErrorCode, message: string) {
    super(message);
    this.name = 'QuoteRepositoryError';
    this.code = code;
  }
}

export interface QuoteMutationResult {
  quote: Quote;
  replayed: boolean;
}

export interface CreateStoredQuoteInput {
  accountId: string;
  enquiryId: string;
  actorUserId: string;
  idempotencyKey: string;
  origin: QuoteOrigin;
  initialStatus: 'draft' | 'awaiting_approval';
  proposal: QuoteProposal;
}

export interface ReviseStoredQuoteInput {
  accountId: string;
  quoteId: string;
  actorUserId: string;
  idempotencyKey: string;
  origin: QuoteOrigin;
  recommendationQuoteId: string | null;
  proposal: QuoteProposal;
}

export interface QuoteRepository {
  createInitial(input: CreateStoredQuoteInput): Promise<QuoteMutationResult>;
  revise(input: ReviseStoredQuoteInput): Promise<QuoteMutationResult>;
  transition(input: {
    accountId: string;
    quoteId: string;
    actorUserId: string;
    idempotencyKey: string;
    expectedStatuses: readonly QuoteWorkflowStatus[];
    patch: Record<string, unknown>;
    requireUnknownDecision?: boolean;
  }): Promise<QuoteMutationResult>;
  get(accountId: string, quoteId: string): Promise<Quote | null>;
  getCurrent(accountId: string, enquiryId: string): Promise<Quote | null>;
  getHistory(accountId: string, enquiryId: string): Promise<Quote[]>;
  getEvents(accountId: string, enquiryId: string): Promise<QuoteEvent[]>;
}

/**
 * Supabase implementation. Every query carries `account_id` even though RLS
 * applies too; the composite FKs and database guards remain the backstop for
 * privileged callers.
 */
export class SupabaseQuoteRepository implements QuoteRepository {
  constructor(private readonly db: SupabaseClient) {}

  async createInitial(
    input: CreateStoredQuoteInput
  ): Promise<QuoteMutationResult> {
    const replay = await this.getByCreationKey(
      input.accountId,
      input.idempotencyKey
    );
    if (replay) {
      if (replay.enquiry_id !== input.enquiryId) {
        throw new QuoteRepositoryError(
          'conflict',
          'The idempotency key was already used for another enquiry'
        );
      }
      return { quote: replay, replayed: true };
    }

    const { data: enquiry, error: enquiryError } = await this.db
      .from('enquiries')
      .select('id')
      .eq('account_id', input.accountId)
      .eq('id', input.enquiryId)
      .maybeSingle();
    if (enquiryError) throw databaseError('Could not verify quote enquiry');
    if (!enquiry) {
      throw new QuoteRepositoryError('not_found', 'Enquiry not found');
    }

    const { data, error } = await this.db
      .from('quotes')
      .insert({
        account_id: input.accountId,
        enquiry_id: input.enquiryId,
        revision_number: 1,
        status: input.initialStatus,
        customer_decision: 'unknown',
        origin: input.origin,
        ...proposalPayload(input.proposal),
        created_by_user_id: input.actorUserId,
        creation_idempotency_key: input.idempotencyKey,
      })
      .select(QUOTE_COLUMNS)
      .single();

    if (error && isConflict(error.code)) {
      const winner = await this.getByCreationKey(
        input.accountId,
        input.idempotencyKey
      );
      if (winner && winner.enquiry_id === input.enquiryId) {
        return { quote: winner, replayed: true };
      }
      throw new QuoteRepositoryError(
        'conflict',
        'A quote cannot be created for this enquiry in its current state'
      );
    }
    if (error || !data) throw databaseError('Could not create quote');
    return { quote: parseQuote(data), replayed: false };
  }

  async revise(input: ReviseStoredQuoteInput): Promise<QuoteMutationResult> {
    const replay = await this.getByCreationKey(
      input.accountId,
      input.idempotencyKey
    );
    if (replay) {
      if (replay.supersedes_quote_id !== input.quoteId) {
        throw new QuoteRepositoryError(
          'conflict',
          'The idempotency key was already used for another quote action'
        );
      }
      return { quote: replay, replayed: true };
    }

    const { data, error } = await this.db.rpc('quote_create_revision', {
      p_account_id: input.accountId,
      p_quote_id: input.quoteId,
      p_actor_user_id: input.actorUserId,
      p_idempotency_key: input.idempotencyKey,
      p_origin: input.origin,
      p_recommendation_quote_id: input.recommendationQuoteId,
      p_currency: input.proposal.currency,
      p_amount_type: input.proposal.amount_type,
      p_fixed_amount_minor: input.proposal.fixed_amount_minor,
      p_range_min_minor: input.proposal.range_min_minor,
      p_range_max_minor: input.proposal.range_max_minor,
      p_assumptions: input.proposal.assumptions,
      p_exclusions: input.proposal.exclusions,
      p_operator_notes: input.proposal.operator_notes,
      p_source_reference: input.proposal.source_reference,
      p_source_observed_at: input.proposal.source_observed_at,
      p_override_reason: input.proposal.override_reason,
      p_override_reason_note: input.proposal.override_reason_note,
    });

    if (error) {
      if (isConflict(error.code)) {
        const winner = await this.getByCreationKey(
          input.accountId,
          input.idempotencyKey
        );
        if (winner && winner.supersedes_quote_id === input.quoteId) {
          return { quote: winner, replayed: true };
        }
        throw new QuoteRepositoryError(
          'conflict',
          'The quote changed before the revision could be created'
        );
      }
      throw databaseError('Could not revise quote');
    }
    if (!data) throw databaseError('Could not revise quote');
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw databaseError('Could not revise quote');
    return { quote: parseQuote(row), replayed: false };
  }

  async transition(input: {
    accountId: string;
    quoteId: string;
    actorUserId: string;
    idempotencyKey: string;
    expectedStatuses: readonly QuoteWorkflowStatus[];
    patch: Record<string, unknown>;
    requireUnknownDecision?: boolean;
  }): Promise<QuoteMutationResult> {
    const current = await this.get(input.accountId, input.quoteId);
    if (!current)
      throw new QuoteRepositoryError('not_found', 'Quote not found');
    if (current.last_action_idempotency_key === input.idempotencyKey) {
      return { quote: current, replayed: true };
    }

    let query = this.db
      .from('quotes')
      .update({
        ...input.patch,
        last_action_idempotency_key: input.idempotencyKey,
        last_action_by_user_id: input.actorUserId,
      })
      .eq('account_id', input.accountId)
      .eq('id', input.quoteId)
      .in('status', [...input.expectedStatuses]);
    if (input.requireUnknownDecision) {
      query = query.eq('customer_decision', 'unknown');
    }

    const { data, error } = await query.select(QUOTE_COLUMNS).maybeSingle();
    if (error?.code === '23505') {
      const replay = await this.get(input.accountId, input.quoteId);
      if (replay?.last_action_idempotency_key === input.idempotencyKey) {
        return { quote: replay, replayed: true };
      }
      throw new QuoteRepositoryError(
        'conflict',
        'The idempotency key was already used for another quote action'
      );
    }
    if (error) {
      if (isConflict(error.code)) {
        throw new QuoteRepositoryError(
          'conflict',
          'The quote transition is not valid from its current state'
        );
      }
      throw databaseError('Could not update quote lifecycle');
    }
    if (data) return { quote: parseQuote(data), replayed: false };

    const after = await this.get(input.accountId, input.quoteId);
    if (!after) throw new QuoteRepositoryError('not_found', 'Quote not found');
    if (after.last_action_idempotency_key === input.idempotencyKey) {
      return { quote: after, replayed: true };
    }
    throw new QuoteRepositoryError(
      'conflict',
      'The quote changed before the action could be applied'
    );
  }

  async get(accountId: string, quoteId: string): Promise<Quote | null> {
    const { data, error } = await this.db
      .from('quotes')
      .select(QUOTE_COLUMNS)
      .eq('account_id', accountId)
      .eq('id', quoteId)
      .maybeSingle();
    if (error) throw databaseError('Could not load quote');
    return data ? parseQuote(data) : null;
  }

  async getCurrent(
    accountId: string,
    enquiryId: string
  ): Promise<Quote | null> {
    const { data, error } = await this.db
      .from('quotes')
      .select(QUOTE_COLUMNS)
      .eq('account_id', accountId)
      .eq('enquiry_id', enquiryId)
      .in('status', CURRENT_QUOTE_STATUSES)
      .order('revision_number', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw databaseError('Could not load current quote');
    return data ? parseQuote(data) : null;
  }

  async getHistory(accountId: string, enquiryId: string): Promise<Quote[]> {
    const { data, error } = await this.db
      .from('quotes')
      .select(QUOTE_COLUMNS)
      .eq('account_id', accountId)
      .eq('enquiry_id', enquiryId)
      .order('revision_number', { ascending: false })
      .order('id', { ascending: false })
      .limit(200);
    if (error) throw databaseError('Could not load quote history');
    return ((data ?? []) as unknown[]).map(parseQuote).reverse();
  }

  async getEvents(accountId: string, enquiryId: string): Promise<QuoteEvent[]> {
    const history = await this.getHistory(accountId, enquiryId);
    if (history.length === 0) return [];
    const { data, error } = await this.db
      .from('quote_events')
      .select(QUOTE_EVENT_COLUMNS)
      .eq('account_id', accountId)
      .in(
        'quote_id',
        history.map((quote) => quote.id)
      )
      .order('occurred_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(1_000);
    if (error) throw databaseError('Could not load quote audit history');
    return ((data ?? []) as unknown[]).map(parseQuoteEvent).reverse();
  }

  private async getByCreationKey(
    accountId: string,
    idempotencyKey: string
  ): Promise<Quote | null> {
    const { data, error } = await this.db
      .from('quotes')
      .select(QUOTE_COLUMNS)
      .eq('account_id', accountId)
      .eq('creation_idempotency_key', idempotencyKey)
      .maybeSingle();
    if (error) throw databaseError('Could not resolve quote idempotency');
    return data ? parseQuote(data) : null;
  }
}

function proposalPayload(proposal: QuoteProposal): Record<string, unknown> {
  return {
    currency: proposal.currency,
    amount_type: proposal.amount_type,
    fixed_amount_minor: proposal.fixed_amount_minor,
    range_min_minor: proposal.range_min_minor,
    range_max_minor: proposal.range_max_minor,
    assumptions: proposal.assumptions,
    exclusions: proposal.exclusions,
    operator_notes: proposal.operator_notes,
    source_reference: proposal.source_reference,
    source_observed_at: proposal.source_observed_at,
    override_reason: proposal.override_reason,
    override_reason_note: proposal.override_reason_note,
  };
}

function isConflict(code: string | undefined): boolean {
  return code === '23505' || code === '23514' || code === 'P0001';
}

function databaseError(message: string): QuoteRepositoryError {
  return new QuoteRepositoryError('database_error', message);
}

export function quoteDecisionPatch(
  decision: Exclude<QuoteCustomerDecision, 'unknown'>,
  actorUserId: string,
  decisionNote: string | null,
  at: string
): Record<string, unknown> {
  return {
    customer_decision: decision,
    decision_recorded_at: at,
    decision_recorded_by_user_id: actorUserId,
    decision_note: decisionNote,
  };
}
