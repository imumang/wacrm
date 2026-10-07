import { describe, expect, it } from 'vitest';

import {
  parseQuoteProposal,
  quoteAmountsEqual,
  quoteEvidenceFromHistory,
  type Quote,
} from './model';

describe('quote proposal money model', () => {
  it('parses a manual fixed quote in integer minor units', () => {
    expect(
      parseQuoteProposal({
        currency: 'gbp',
        amount_type: 'fixed',
        fixed_amount_minor: 28_000,
      })
    ).toMatchObject({
      currency: 'GBP',
      amount_type: 'fixed',
      fixed_amount_minor: 28_000,
      range_min_minor: null,
      range_max_minor: null,
    });
  });

  it('preserves a range instead of manufacturing one price', () => {
    expect(
      parseQuoteProposal({
        currency: 'GBP',
        amount_type: 'range',
        range_min_minor: 28_000,
        range_max_minor: 37_000,
      })
    ).toMatchObject({
      amount_type: 'range',
      fixed_amount_minor: null,
      range_min_minor: 28_000,
      range_max_minor: 37_000,
    });
  });

  it('rejects an unknown amount rather than reading it as zero', () => {
    expect(() =>
      parseQuoteProposal({ currency: 'GBP', amount_type: 'fixed' })
    ).toThrow(/requires fixed_amount_minor/);
    expect(() =>
      parseQuoteProposal({ currency: 'GBP', amount_type: 'range' })
    ).toThrow(/requires range_min_minor and range_max_minor/);
  });

  it('rejects invalid monetary ranges and floating-point money', () => {
    expect(() =>
      parseQuoteProposal({
        currency: 'GBP',
        amount_type: 'range',
        range_min_minor: 37_000,
        range_max_minor: 28_000,
      })
    ).toThrow(/less than or equal/);
    expect(() =>
      parseQuoteProposal({
        currency: 'GBP',
        amount_type: 'fixed',
        fixed_amount_minor: 280.5,
      })
    ).toThrow(/safe integer/);
  });

  it('compares the complete amount shape, including currency and ranges', () => {
    const fixed = parseQuoteProposal({
      currency: 'GBP',
      amount_type: 'fixed',
      fixed_amount_minor: 30_000,
    });
    expect(quoteAmountsEqual(fixed, fixed)).toBe(true);
    expect(
      quoteAmountsEqual(
        fixed,
        parseQuoteProposal({
          currency: 'GBP',
          amount_type: 'fixed',
          fixed_amount_minor: 34_000,
        })
      )
    ).toBe(false);
  });

  it('uses the latest revision decision instead of a superseded rejection', () => {
    const base = {
      account_id: '11111111-1111-4111-8111-111111111111',
      enquiry_id: '22222222-2222-4222-8222-222222222222',
      currency: 'GBP',
      amount_type: 'fixed' as const,
      fixed_amount_minor: 30_000,
      range_min_minor: null,
      range_max_minor: null,
      assumptions: [],
      exclusions: [],
      operator_notes: null,
      source_reference: null,
      source_observed_at: null,
      override_reason: null,
      override_reason_note: null,
      superseded_by_quote_id: null,
      recommendation_quote_id: null,
      created_by_user_id: '33333333-3333-4333-8333-333333333333',
      approved_at: null,
      approved_by_user_id: null,
      presented_at: null,
      presented_by_user_id: null,
      decision_recorded_at: null,
      decision_recorded_by_user_id: null,
      decision_note: null,
      last_action_idempotency_key: null,
      last_action_by_user_id: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    };
    const history = [
      {
        ...base,
        id: '44444444-4444-4444-8444-444444444444',
        revision_number: 1,
        status: 'superseded',
        customer_decision: 'rejected_price',
        origin: 'manual',
        supersedes_quote_id: null,
        creation_idempotency_key: 'v1',
      },
      {
        ...base,
        id: '55555555-5555-4555-8555-555555555555',
        revision_number: 2,
        status: 'draft',
        customer_decision: 'unknown',
        origin: 'manual',
        supersedes_quote_id: '44444444-4444-4444-8444-444444444444',
        creation_idempotency_key: 'v2',
      },
    ] satisfies Quote[];

    expect(quoteEvidenceFromHistory(history).quoteDecision).toBeNull();
  });
});
