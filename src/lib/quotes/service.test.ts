import { describe, expect, it } from 'vitest';

import type {
  Quote,
  QuoteCustomerDecision,
  QuoteEvent,
  QuoteWorkflowStatus,
} from './model';
import {
  QuoteRepositoryError,
  type CreateStoredQuoteInput,
  type QuoteMutationResult,
  type QuoteRepository,
  type ReviseStoredQuoteInput,
} from './repository';
import { QuoteService } from './service';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const OTHER_ACCOUNT = '22222222-2222-4222-8222-222222222222';
const ENQUIRY = '33333333-3333-4333-8333-333333333333';
const ACTOR = '44444444-4444-4444-8444-444444444444';

const fixed = (minor: number) => ({
  currency: 'GBP',
  amount_type: 'fixed' as const,
  fixed_amount_minor: minor,
});

describe('canonical quote lifecycle', () => {
  it('creates manual fixed and range quotes without approving them', async () => {
    const fixedStore = new MemoryQuoteRepository();
    const fixedResult = await new QuoteService(fixedStore).createManualQuote({
      accountId: ACCOUNT,
      enquiryId: ENQUIRY,
      actorUserId: ACTOR,
      idempotencyKey: 'manual-fixed',
      proposal: fixed(28_000),
    });
    expect(fixedResult.quote).toMatchObject({
      origin: 'manual',
      status: 'draft',
      customer_decision: 'unknown',
      fixed_amount_minor: 28_000,
      approved_at: null,
      presented_at: null,
    });

    const rangeStore = new MemoryQuoteRepository();
    const rangeResult = await new QuoteService(rangeStore).createManualQuote({
      accountId: ACCOUNT,
      enquiryId: ENQUIRY,
      actorUserId: ACTOR,
      idempotencyKey: 'manual-range',
      proposal: {
        currency: 'GBP',
        amount_type: 'range',
        range_min_minor: 28_000,
        range_max_minor: 37_000,
      },
    });
    expect(rangeResult.quote).toMatchObject({
      amount_type: 'range',
      fixed_amount_minor: null,
      range_min_minor: 28_000,
      range_max_minor: 37_000,
    });
  });

  it('keeps an AI suggestion unapproved, unpresented, and undecided', async () => {
    const store = new MemoryQuoteRepository();
    const result = await new QuoteService(store).createQuoteSuggestion({
      accountId: ACCOUNT,
      enquiryId: ENQUIRY,
      actorUserId: ACTOR,
      idempotencyKey: 'ai-1',
      origin: 'ai_suggested',
      proposal: fixed(30_000),
    });
    expect(result.quote).toMatchObject({
      origin: 'ai_suggested',
      status: 'awaiting_approval',
      approved_at: null,
      presented_at: null,
      customer_decision: 'unknown',
    });
    expect(result.quote).not.toHaveProperty('final_amount_collected');
  });

  it('moves draft to approved to presented to accepted with actor audit', async () => {
    const { service, quote } = await manualQuote();
    const approved = await service.approveQuote(action(quote.id, 'approve-1'));
    expect(approved.quote.status).toBe('approved');
    expect(approved.quote.approved_by_user_id).toBe(ACTOR);

    const presented = await service.markQuotePresented(
      action(quote.id, 'present-1')
    );
    expect(presented.quote.status).toBe('presented');
    expect(presented.quote.presented_by_user_id).toBe(ACTOR);

    const decided = await service.recordQuoteDecision({
      ...action(quote.id, 'accept-1'),
      decision: 'accepted',
    });
    expect(decided.quote.customer_decision).toBe('accepted');
    expect(decided.quote.decision_recorded_by_user_id).toBe(ACTOR);
    expect(decided.quote).not.toHaveProperty('final_amount_collected');
  });

  it.each(['rejected_price', 'found_better_price', 'no_response'] as const)(
    'records %s without collapsing customer outcomes',
    async (decision) => {
      const { service, quote } = await presentedQuote();
      const result = await service.recordQuoteDecision({
        ...action(quote.id, `decision-${decision}`),
        decision,
      });
      expect(result.quote.customer_decision).toBe(decision);
    }
  );

  it('revises rather than overwriting and preserves the AI recommendation', async () => {
    const store = new MemoryQuoteRepository();
    const service = new QuoteService(store);
    const suggestion = await service.createQuoteSuggestion({
      accountId: ACCOUNT,
      enquiryId: ENQUIRY,
      actorUserId: ACTOR,
      idempotencyKey: 'suggestion',
      origin: 'hybrid_engine',
      proposal: fixed(30_000),
    });
    const revised = await service.reviseQuote({
      ...action(suggestion.quote.id, 'revision'),
      proposal: {
        ...fixed(34_000),
        override_reason: 'manual_judgement',
      },
    });

    expect(revised.quote).toMatchObject({
      revision_number: 2,
      fixed_amount_minor: 34_000,
      supersedes_quote_id: suggestion.quote.id,
      recommendation_quote_id: suggestion.quote.id,
      override_reason: 'manual_judgement',
    });
    const history = await service.getQuoteHistory(ACCOUNT, ENQUIRY);
    expect(history.quotes.map((item) => item.fixed_amount_minor)).toEqual([
      30_000, 34_000,
    ]);
    expect(history.quotes[0]).toMatchObject({
      status: 'superseded',
      fixed_amount_minor: 30_000,
    });
  });

  it('rejects invalid transitions', async () => {
    const { service, quote } = await manualQuote();
    await expect(
      service.markQuotePresented(action(quote.id, 'too-soon'))
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('replays duplicate create and revision requests without duplicates', async () => {
    const store = new MemoryQuoteRepository();
    const service = new QuoteService(store);
    const input = {
      accountId: ACCOUNT,
      enquiryId: ENQUIRY,
      actorUserId: ACTOR,
      idempotencyKey: 'same-create',
      proposal: fixed(28_000),
    };
    const first = await service.createManualQuote(input);
    const replay = await service.createManualQuote(input);
    expect(replay).toMatchObject({ replayed: true });
    expect(replay.quote.id).toBe(first.quote.id);

    const revisionInput = {
      ...action(first.quote.id, 'same-revision'),
      proposal: fixed(32_000),
    };
    const revision = await service.reviseQuote(revisionInput);
    const revisionReplay = await service.reviseQuote(revisionInput);
    expect(revisionReplay.quote.id).toBe(revision.quote.id);
    expect(
      (await service.getQuoteHistory(ACCOUNT, ENQUIRY)).quotes
    ).toHaveLength(2);
  });

  it('allows exactly one concurrent revision winner', async () => {
    const { service, quote } = await manualQuote();
    const results = await Promise.allSettled([
      service.reviseQuote({
        ...action(quote.id, 'revision-a'),
        proposal: fixed(32_000),
      }),
      service.reviseQuote({
        ...action(quote.id, 'revision-b'),
        proposal: fixed(33_000),
      }),
    ]);
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(
      1
    );
    expect(results.filter((item) => item.status === 'rejected')).toHaveLength(
      1
    );
  });

  it('preserves a decision on an old revision when a follow-up is quoted', async () => {
    const { service, quote } = await presentedQuote();
    await service.recordQuoteDecision({
      ...action(quote.id, 'rejected-old'),
      decision: 'rejected_price',
    });
    const followUp = await service.reviseQuote({
      ...action(quote.id, 'follow-up'),
      proposal: fixed(25_000),
    });
    const history = await service.getQuoteHistory(ACCOUNT, ENQUIRY);
    expect(history.quotes[0]).toMatchObject({
      status: 'superseded',
      customer_decision: 'rejected_price',
    });
    expect(followUp.quote).toMatchObject({
      status: 'draft',
      customer_decision: 'unknown',
      revision_number: 2,
    });
  });

  it('denies cross-account access', async () => {
    const { service, quote } = await manualQuote();
    await expect(
      service.approveQuote({
        ...action(quote.id, 'foreign'),
        accountId: OTHER_ACCOUNT,
      })
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(await service.getCurrentQuote(OTHER_ACCOUNT, ENQUIRY)).toBeNull();
  });

  it('keeps imported historical provenance and absent outcomes explicit', async () => {
    const store = new MemoryQuoteRepository();
    const result = await new QuoteService(store).createManualQuote({
      accountId: ACCOUNT,
      enquiryId: ENQUIRY,
      actorUserId: ACTOR,
      idempotencyKey: 'historical',
      origin: 'imported_historical',
      proposal: {
        ...fixed(28_000),
        source_reference: 'invoice-and-whatsapp-evidence-17',
        source_observed_at: '2024-06-01T10:00:00Z',
      },
    });
    expect(result.quote).toMatchObject({
      origin: 'imported_historical',
      customer_decision: 'unknown',
      source_reference: 'invoice-and-whatsapp-evidence-17',
    });
    expect(result.quote).not.toHaveProperty('final_amount_collected');
  });

  it('rejects an imported historical quote without source evidence', async () => {
    await expect(
      new QuoteService(new MemoryQuoteRepository()).createManualQuote({
        accountId: ACCOUNT,
        enquiryId: ENQUIRY,
        actorUserId: ACTOR,
        idempotencyKey: 'historical-without-source',
        origin: 'imported_historical',
        proposal: fixed(28_000),
      })
    ).rejects.toThrow(/source_reference and source_observed_at/);
  });
});

function action(quoteId: string, idempotencyKey: string) {
  return {
    accountId: ACCOUNT,
    quoteId,
    actorUserId: ACTOR,
    idempotencyKey,
  };
}

async function manualQuote() {
  const store = new MemoryQuoteRepository();
  const service = new QuoteService(store);
  const { quote } = await service.createManualQuote({
    accountId: ACCOUNT,
    enquiryId: ENQUIRY,
    actorUserId: ACTOR,
    idempotencyKey: 'manual',
    proposal: fixed(28_000),
  });
  return { store, service, quote };
}

async function presentedQuote() {
  const context = await manualQuote();
  await context.service.approveQuote(action(context.quote.id, 'approve'));
  const { quote } = await context.service.markQuotePresented(
    action(context.quote.id, 'present')
  );
  return { ...context, quote };
}

class MemoryQuoteRepository implements QuoteRepository {
  private quotes: Quote[] = [];
  private events: QuoteEvent[] = [];
  private sequence = 0;

  async createInitial(
    input: CreateStoredQuoteInput
  ): Promise<QuoteMutationResult> {
    const replay = this.quotes.find(
      (quote) =>
        quote.account_id === input.accountId &&
        quote.creation_idempotency_key === input.idempotencyKey
    );
    if (replay) return { quote: replay, replayed: true };
    if (this.quotes.some((quote) => quote.enquiry_id === input.enquiryId)) {
      throw new QuoteRepositoryError('conflict', 'Current quote exists');
    }
    const quote = this.makeQuote(input, 1, null, null);
    this.quotes.push(quote);
    this.event(
      quote,
      'created',
      null,
      quote.status,
      null,
      input.idempotencyKey
    );
    return { quote, replayed: false };
  }

  async revise(input: ReviseStoredQuoteInput): Promise<QuoteMutationResult> {
    const replay = this.quotes.find(
      (quote) =>
        quote.account_id === input.accountId &&
        quote.creation_idempotency_key === input.idempotencyKey
    );
    if (replay) return { quote: replay, replayed: true };
    const parent = this.quotes.find(
      (quote) =>
        quote.id === input.quoteId && quote.account_id === input.accountId
    );
    if (!parent || parent.status === 'superseded') {
      throw new QuoteRepositoryError('conflict', 'Quote is not revisable');
    }
    const previousStatus = parent.status;
    parent.status = 'superseded';
    parent.last_action_idempotency_key = input.idempotencyKey;
    parent.last_action_by_user_id = input.actorUserId;
    const quote = this.makeQuote(
      {
        ...input,
        enquiryId: parent.enquiry_id,
        initialStatus:
          input.origin === 'ai_suggested' || input.origin === 'hybrid_engine'
            ? 'awaiting_approval'
            : 'draft',
      },
      parent.revision_number + 1,
      parent.id,
      input.recommendationQuoteId
    );
    parent.superseded_by_quote_id = quote.id;
    this.quotes.push(quote);
    this.event(
      parent,
      'superseded',
      previousStatus,
      'superseded',
      null,
      input.idempotencyKey
    );
    this.event(
      quote,
      'created',
      null,
      quote.status,
      null,
      input.idempotencyKey
    );
    return { quote, replayed: false };
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
    const quote = this.quotes.find(
      (item) => item.id === input.quoteId && item.account_id === input.accountId
    );
    if (!quote) throw new QuoteRepositoryError('not_found', 'Quote not found');
    if (quote.last_action_idempotency_key === input.idempotencyKey) {
      return { quote, replayed: true };
    }
    if (
      !input.expectedStatuses.includes(quote.status) ||
      (input.requireUnknownDecision && quote.customer_decision !== 'unknown')
    ) {
      throw new QuoteRepositoryError('conflict', 'Invalid transition');
    }
    const from = quote.status;
    Object.assign(quote, input.patch, {
      last_action_idempotency_key: input.idempotencyKey,
      last_action_by_user_id: input.actorUserId,
      updated_at: new Date().toISOString(),
    });
    const decision =
      quote.customer_decision === 'unknown' ? null : quote.customer_decision;
    const eventType =
      decision && from === quote.status
        ? 'customer_decision_recorded'
        : quote.status === 'approved'
          ? 'approved'
          : quote.status === 'presented'
            ? 'presented'
            : quote.status === 'withdrawn'
              ? 'withdrawn'
              : 'expired';
    this.event(
      quote,
      eventType,
      from,
      quote.status,
      decision,
      input.idempotencyKey
    );
    return { quote, replayed: false };
  }

  async get(accountId: string, quoteId: string) {
    return (
      this.quotes.find(
        (quote) => quote.account_id === accountId && quote.id === quoteId
      ) ?? null
    );
  }

  async getCurrent(accountId: string, enquiryId: string) {
    return (
      this.quotes.find(
        (quote) =>
          quote.account_id === accountId &&
          quote.enquiry_id === enquiryId &&
          ['draft', 'awaiting_approval', 'approved', 'presented'].includes(
            quote.status
          )
      ) ?? null
    );
  }

  async getHistory(accountId: string, enquiryId: string) {
    return this.quotes
      .filter(
        (quote) =>
          quote.account_id === accountId && quote.enquiry_id === enquiryId
      )
      .sort((left, right) => left.revision_number - right.revision_number);
  }

  async getEvents(accountId: string, enquiryId: string) {
    const ids = new Set(
      (await this.getHistory(accountId, enquiryId)).map((quote) => quote.id)
    );
    return this.events.filter((event) => ids.has(event.quote_id));
  }

  private makeQuote(
    input: CreateStoredQuoteInput,
    revision: number,
    supersedes: string | null,
    recommendation: string | null
  ): Quote {
    const now = new Date().toISOString();
    return {
      id: `00000000-0000-4000-8000-${String(++this.sequence).padStart(12, '0')}`,
      account_id: input.accountId,
      enquiry_id: input.enquiryId,
      revision_number: revision,
      status: input.initialStatus,
      customer_decision: 'unknown',
      origin: input.origin,
      ...input.proposal,
      supersedes_quote_id: supersedes,
      superseded_by_quote_id: null,
      recommendation_quote_id: recommendation,
      created_by_user_id: input.actorUserId,
      approved_at: null,
      approved_by_user_id: null,
      presented_at: null,
      presented_by_user_id: null,
      decision_recorded_at: null,
      decision_recorded_by_user_id: null,
      decision_note: null,
      creation_idempotency_key: input.idempotencyKey,
      last_action_idempotency_key: null,
      last_action_by_user_id: null,
      created_at: now,
      updated_at: now,
    };
  }

  private event(
    quote: Quote,
    type: QuoteEvent['event_type'],
    from: QuoteWorkflowStatus | null,
    to: QuoteWorkflowStatus,
    decision: QuoteCustomerDecision | null,
    idempotencyKey: string
  ) {
    this.events.push({
      id: `event-${this.events.length + 1}`,
      account_id: quote.account_id,
      quote_id: quote.id,
      event_type: type,
      from_status: from,
      to_status: to,
      customer_decision: decision,
      actor_user_id: quote.last_action_by_user_id ?? quote.created_by_user_id,
      idempotency_key: idempotencyKey,
      occurred_at: new Date().toISOString(),
    });
  }
}
