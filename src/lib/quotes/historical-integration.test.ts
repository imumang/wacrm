import { describe, expect, it } from 'vitest';

import { classifyHistoricalCaseEvidence } from '@/lib/historical-cases/model';
import { buildFinalizationPayloads } from '@/lib/historical-cases/outcome';

import type { Quote } from './model';

describe('canonical quote evidence in historical classification', () => {
  it('keeps an AI-only canonical suggestion at tier E', () => {
    const result = classifyHistoricalCaseEvidence({
      enquiryOutcome: null,
      completedAt: null,
      facts: [],
      quoteEvidence: {
        aiSuggestionCount: 1,
        humanApprovedQuoteCount: 0,
        customerFacingQuoteCount: 0,
        quoteDecision: null,
      },
    });
    expect(result.tier).toBe('E');
  });

  it('treats human approval as comparison evidence, not final outcome', () => {
    const result = classifyHistoricalCaseEvidence({
      enquiryOutcome: null,
      completedAt: null,
      facts: [],
      quoteEvidence: {
        aiSuggestionCount: 1,
        humanApprovedQuoteCount: 1,
        customerFacingQuoteCount: 0,
        quoteDecision: null,
      },
    });
    expect(result.tier).toBe('D');
    expect(result.tier).not.toBe('A');
  });

  it('separates acceptance, price rejection, better price, and silence', () => {
    const classify = (
      decision:
        'accepted' | 'rejected_price' | 'found_better_price' | 'no_response'
    ) =>
      classifyHistoricalCaseEvidence({
        enquiryOutcome: null,
        completedAt: null,
        facts: [],
        quoteEvidence: {
          aiSuggestionCount: 1,
          humanApprovedQuoteCount: 1,
          customerFacingQuoteCount: 1,
          quoteDecision: decision,
        },
      });

    expect(classify('accepted')).toMatchObject({ tier: 'B' });
    expect(classify('rejected_price')).toMatchObject({
      tier: 'F',
      quote_decision: 'rejected_price',
    });
    expect(classify('found_better_price')).toMatchObject({
      tier: 'F',
      quote_decision: 'found_better_price',
    });
    expect(classify('no_response')).toMatchObject({
      tier: 'F',
      quote_decision: 'no_response',
    });
  });

  it('prefers canonical quote evidence over stale legacy quote-shaped facts', () => {
    const legacyAcceptedFact = {
      id: 'fact',
      account_id: 'account',
      case_id: 'case',
      fact_key: 'quote_decision' as const,
      value_source: 'captured' as const,
      value_text: 'accepted',
      value_number: null,
      value_integer: null,
      value_boolean: null,
      value_timestamp: null,
      provenance: 'operator_entered' as const,
      source_message_id: null,
      source_media_id: null,
      observed_at: null,
      recorded_by_user_id: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    };
    const result = classifyHistoricalCaseEvidence({
      enquiryOutcome: null,
      completedAt: null,
      facts: [legacyAcceptedFact],
      quoteEvidence: {
        aiSuggestionCount: 0,
        humanApprovedQuoteCount: 1,
        customerFacingQuoteCount: 1,
        quoteDecision: 'no_response',
      },
    });
    expect(result).toMatchObject({ tier: 'F', quote_decision: 'no_response' });
  });

  it('bounds the commercial snapshot while the canonical audit stays complete', () => {
    const quotes = Array.from({ length: 17 }, (_, index) =>
      quoteRevision(index + 1)
    );
    const commercial = new Map(
      buildFinalizationPayloads(
        { id: 'case', completed_at: null } as never,
        [],
        null,
        quotes
      )
    ).get('commercial') as Record<string, unknown>;

    expect(commercial).toMatchObject({
      quote_source: 'canonical_quotes',
      quote_revision_count: 17,
      quote_revisions_truncated: true,
    });
    const snapshotQuotes = commercial.quote_revisions as Array<
      Record<string, unknown>
    >;
    expect(snapshotQuotes).toHaveLength(16);
    expect(snapshotQuotes[0].revision_number).toBe(2);
    expect(snapshotQuotes[0]).not.toHaveProperty('assumptions');
  });
});

function quoteRevision(revision: number): Quote {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id: `quote-${revision}`,
    account_id: 'account',
    enquiry_id: 'enquiry',
    revision_number: revision,
    status: revision === 17 ? 'draft' : 'superseded',
    customer_decision: 'unknown',
    origin: 'manual',
    currency: 'GBP',
    amount_type: 'fixed',
    fixed_amount_minor: 30_000 + revision,
    range_min_minor: null,
    range_max_minor: null,
    supersedes_quote_id: revision === 1 ? null : `quote-${revision - 1}`,
    superseded_by_quote_id: revision === 17 ? null : `quote-${revision + 1}`,
    recommendation_quote_id: null,
    assumptions: ['deliberately omitted from compact snapshot'],
    exclusions: [],
    operator_notes: null,
    source_reference: null,
    source_observed_at: null,
    override_reason: null,
    override_reason_note: null,
    created_by_user_id: 'actor',
    approved_at: null,
    approved_by_user_id: null,
    presented_at: null,
    presented_by_user_id: null,
    decision_recorded_at: null,
    decision_recorded_by_user_id: null,
    decision_note: null,
    creation_idempotency_key: `create-${revision}`,
    last_action_idempotency_key: null,
    last_action_by_user_id: null,
    created_at: now,
    updated_at: now,
  };
}
