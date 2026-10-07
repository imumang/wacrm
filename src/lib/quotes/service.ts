import type { SupabaseClient } from '@supabase/supabase-js';

import {
  QUOTE_CUSTOMER_DECISIONS,
  QUOTE_ORIGINS,
  QuoteValidationError,
  parseQuoteProposal,
  quoteAmountsEqual,
  quoteEvidenceFromHistory,
  validateIdempotencyKey,
  type CanonicalQuoteEvidence,
  type Quote,
  type QuoteCustomerDecision,
  type QuoteEvent,
  type QuoteOrigin,
  type QuoteProposal,
} from './model';
import {
  QuoteRepositoryError,
  SupabaseQuoteRepository,
  quoteDecisionPatch,
  type QuoteMutationResult,
  type QuoteRepository,
} from './repository';

export interface QuoteHistory {
  quotes: Quote[];
  events: QuoteEvent[];
}

export class QuoteService {
  constructor(private readonly repository: QuoteRepository) {}

  async createManualQuote(input: {
    accountId: string;
    enquiryId: string;
    actorUserId: string;
    idempotencyKey: unknown;
    proposal: unknown;
    origin?: 'manual' | 'imported_historical';
  }): Promise<QuoteMutationResult> {
    const origin = input.origin ?? 'manual';
    const proposal = parseQuoteProposal(input.proposal);
    assertImportedProvenance(origin, proposal);
    return this.repository.createInitial({
      accountId: requireId(input.accountId, 'accountId'),
      enquiryId: requireId(input.enquiryId, 'enquiryId'),
      actorUserId: requireId(input.actorUserId, 'actorUserId'),
      idempotencyKey: validateIdempotencyKey(input.idempotencyKey),
      origin,
      initialStatus: 'draft',
      proposal,
    });
  }

  async createQuoteSuggestion(input: {
    accountId: string;
    enquiryId: string;
    actorUserId: string;
    idempotencyKey: unknown;
    proposal: unknown;
    origin: 'ai_suggested' | 'hybrid_engine';
  }): Promise<QuoteMutationResult> {
    if (input.origin !== 'ai_suggested' && input.origin !== 'hybrid_engine') {
      throw new QuoteValidationError(
        'A quote suggestion origin must be ai_suggested or hybrid_engine'
      );
    }
    return this.repository.createInitial({
      accountId: requireId(input.accountId, 'accountId'),
      enquiryId: requireId(input.enquiryId, 'enquiryId'),
      actorUserId: requireId(input.actorUserId, 'actorUserId'),
      idempotencyKey: validateIdempotencyKey(input.idempotencyKey),
      origin: input.origin,
      initialStatus: 'awaiting_approval',
      proposal: parseQuoteProposal(input.proposal),
    });
  }

  async approveQuote(input: QuoteActionInput): Promise<QuoteMutationResult> {
    const at = new Date().toISOString();
    return this.repository.transition({
      ...parseActionInput(input),
      expectedStatuses: ['draft', 'awaiting_approval'],
      requireUnknownDecision: true,
      patch: {
        status: 'approved',
        approved_at: at,
        approved_by_user_id: input.actorUserId,
      },
    });
  }

  async reviseQuote(input: {
    accountId: string;
    quoteId: string;
    actorUserId: string;
    idempotencyKey: unknown;
    proposal: unknown;
    origin?: QuoteOrigin;
  }): Promise<QuoteMutationResult> {
    const action = parseActionInput(input);
    const current = await this.repository.get(action.accountId, action.quoteId);
    if (!current)
      throw new QuoteRepositoryError('not_found', 'Quote not found');
    const proposal = parseQuoteProposal(input.proposal);
    const recommendationQuoteId =
      current.origin === 'ai_suggested' || current.origin === 'hybrid_engine'
        ? current.id
        : current.recommendation_quote_id;

    // The reason is deliberately optional until the business decides to make
    // it mandatory. The reference is not optional: a changed recommendation
    // must remain recoverable even when no reason was supplied.
    if (
      recommendationQuoteId !== null &&
      !quoteAmountsEqual(current, proposal) &&
      proposal.override_reason === null
    ) {
      // Supported but not required. This branch exists as an explicit policy
      // marker so a future requirement can tighten one condition, not redesign
      // the data model.
    }

    const origin = input.origin ?? 'manual';
    if (!(QUOTE_ORIGINS as readonly string[]).includes(origin)) {
      throw new QuoteValidationError(
        `origin must be one of: ${QUOTE_ORIGINS.join(', ')}`
      );
    }
    assertImportedProvenance(origin, proposal);

    return this.repository.revise({
      ...action,
      origin,
      recommendationQuoteId,
      proposal,
    });
  }

  async markQuotePresented(
    input: QuoteActionInput
  ): Promise<QuoteMutationResult> {
    const at = new Date().toISOString();
    return this.repository.transition({
      ...parseActionInput(input),
      expectedStatuses: ['approved'],
      requireUnknownDecision: true,
      patch: {
        status: 'presented',
        presented_at: at,
        presented_by_user_id: input.actorUserId,
      },
    });
  }

  async recordQuoteDecision(
    input: QuoteActionInput & {
      decision: unknown;
      decisionNote?: unknown;
    }
  ): Promise<QuoteMutationResult> {
    const action = parseActionInput(input);
    const decision = parseDecision(input.decision);
    const decisionNote = readOptionalNote(input.decisionNote);
    return this.repository.transition({
      ...action,
      expectedStatuses: ['presented'],
      requireUnknownDecision: true,
      patch: quoteDecisionPatch(
        decision,
        input.actorUserId,
        decisionNote,
        new Date().toISOString()
      ),
    });
  }

  async withdrawQuote(input: QuoteActionInput): Promise<QuoteMutationResult> {
    return this.repository.transition({
      ...parseActionInput(input),
      expectedStatuses: ['draft', 'awaiting_approval', 'approved', 'presented'],
      requireUnknownDecision: true,
      patch: { status: 'withdrawn' },
    });
  }

  async expireQuote(input: QuoteActionInput): Promise<QuoteMutationResult> {
    return this.repository.transition({
      ...parseActionInput(input),
      expectedStatuses: ['approved', 'presented'],
      requireUnknownDecision: true,
      patch: { status: 'expired' },
    });
  }

  getCurrentQuote(accountId: string, enquiryId: string): Promise<Quote | null> {
    return this.repository.getCurrent(
      requireId(accountId, 'accountId'),
      requireId(enquiryId, 'enquiryId')
    );
  }

  async getQuoteHistory(
    accountId: string,
    enquiryId: string
  ): Promise<QuoteHistory> {
    const scopedAccountId = requireId(accountId, 'accountId');
    const scopedEnquiryId = requireId(enquiryId, 'enquiryId');
    const [quotes, events] = await Promise.all([
      this.repository.getHistory(scopedAccountId, scopedEnquiryId),
      this.repository.getEvents(scopedAccountId, scopedEnquiryId),
    ]);
    return { quotes, events };
  }
}

interface QuoteActionInput {
  accountId: string;
  quoteId: string;
  actorUserId: string;
  idempotencyKey: unknown;
}

function parseActionInput(input: QuoteActionInput) {
  return {
    accountId: requireId(input.accountId, 'accountId'),
    quoteId: requireId(input.quoteId, 'quoteId'),
    actorUserId: requireId(input.actorUserId, 'actorUserId'),
    idempotencyKey: validateIdempotencyKey(input.idempotencyKey),
  };
}

function parseDecision(
  value: unknown
): Exclude<QuoteCustomerDecision, 'unknown'> {
  if (
    typeof value !== 'string' ||
    value === 'unknown' ||
    !(QUOTE_CUSTOMER_DECISIONS as readonly string[]).includes(value)
  ) {
    throw new QuoteValidationError(
      `decision must be one of: ${QUOTE_CUSTOMER_DECISIONS.filter((item) => item !== 'unknown').join(', ')}`
    );
  }
  return value as Exclude<QuoteCustomerDecision, 'unknown'>;
}

function readOptionalNote(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new QuoteValidationError('decision_note must be a non-empty string');
  }
  const note = value.trim();
  if (note.length > 1_000) {
    throw new QuoteValidationError(
      'decision_note must be at most 1000 characters'
    );
  }
  return note;
}

function requireId(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.trim()
    )
  ) {
    throw new QuoteValidationError(`${field} must be a UUID`);
  }
  return value.trim();
}

function assertImportedProvenance(
  origin: QuoteOrigin,
  proposal: QuoteProposal
): void {
  if (origin !== 'imported_historical') return;
  if (
    proposal.source_reference === null ||
    proposal.source_observed_at === null
  ) {
    throw new QuoteValidationError(
      'Imported historical quotes require source_reference and source_observed_at'
    );
  }
}

export function createQuoteService(db: SupabaseClient): QuoteService {
  return new QuoteService(new SupabaseQuoteRepository(db));
}

export async function getCanonicalQuoteEvidence(
  db: SupabaseClient,
  input: { accountId: string; enquiryId: string }
): Promise<CanonicalQuoteEvidence | null> {
  const history = await new SupabaseQuoteRepository(db).getHistory(
    input.accountId,
    input.enquiryId
  );
  return history.length === 0 ? null : quoteEvidenceFromHistory(history);
}

export async function getCanonicalQuoteHistory(
  db: SupabaseClient,
  input: { accountId: string; enquiryId: string }
): Promise<Quote[]> {
  return new SupabaseQuoteRepository(db).getHistory(
    input.accountId,
    input.enquiryId
  );
}
