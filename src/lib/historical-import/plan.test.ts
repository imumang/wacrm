import { describe, expect, it } from 'vitest';

import type { HistoricalCaseFact } from '../historical-cases/model';
import {
  planDeal,
  planEnquiryImport,
  planLegacyConversation,
  type PlanEnquiryInput,
} from './plan';
import type { HistoricalImportEnquiryRow } from './repository';

const ENQUIRY_ID = '11111111-1111-1111-1111-111111111111';
const CONVERSATION_ID = '22222222-2222-2222-2222-222222222222';

function enquiry(
  overrides: Record<string, unknown> = {}
): HistoricalImportEnquiryRow {
  return {
    id: ENQUIRY_ID,
    account_id: 'account-1',
    conversation_id: CONVERSATION_ID,
    workflow_state: 'completed',
    state_changed_at: '2026-02-01T09:00:00+00:00',
    created_at: '2026-01-20T09:00:00+00:00',
    customer_intent: 'Clear out a flat',
    postcode: 'E14 9SH',
    address: '12 Something Street',
    property_type: 'flat',
    floor: '3rd',
    lift_available: false,
    parking: 'on street',
    access_constraints: ['no lift working'],
    item_descriptions: ['sofas', 'fridge'],
    waste_type: 'household',
    estimated_volume: '2 loads',
    heavy_special_items: [],
    photos_received: true,
    ...overrides,
  };
}

function input(
  overrides: Partial<PlanEnquiryInput> = {}
): PlanEnquiryInput {
  return {
    enquiry: enquiry(),
    existingCase: null,
    existingFacts: [],
    alreadyAttributed: false,
    mediaReferences: [],
    ...overrides,
  };
}

function storedFact(
  factKey: HistoricalCaseFact['fact_key'],
  provenance: HistoricalCaseFact['provenance']
): HistoricalCaseFact {
  return {
    id: `fact-${factKey}`,
    account_id: 'account-1',
    case_id: 'case-1',
    fact_key: factKey,
    value_source: 'canonical',
    value_text: null,
    value_number: null,
    value_integer: null,
    value_boolean: null,
    value_timestamp: null,
    provenance,
    source_message_id: null,
    source_media_id: null,
    observed_at: null,
    recorded_by_user_id: null,
    created_at: '2026-02-01T09:00:00.000Z',
    updated_at: '2026-02-01T09:00:00.000Z',
  };
}

describe('planEnquiryImport: what gets imported', () => {
  it('annotates only the canonical columns that hold a value', () => {
    const outcome = planEnquiryImport(input());

    expect(outcome.outcome).toBe('plan');
    if (outcome.outcome !== 'plan') return;

    const keys = outcome.facts.map((fact) => fact.fact_key).sort();
    expect(keys).toEqual([
      'access_constraints',
      'address',
      'customer_intent',
      'estimated_volume',
      'floor',
      'item_descriptions',
      'lift_available',
      'parking',
      'photos_received',
      'postcode',
      'property_type',
      'waste_type',
    ]);
    // `heavy_special_items` was an empty list, so there is nothing to
    // say about where it came from.
    expect(keys).not.toContain('heavy_special_items');
  });

  it('carries imported_historical provenance on every imported fact', () => {
    const outcome = planEnquiryImport(input());
    if (outcome.outcome !== 'plan') throw new Error('expected a plan');

    for (const fact of outcome.facts) {
      expect(fact.provenance).toBe('imported_historical');
      expect(fact.value_source).toBe('canonical');
    }
  });

  it('writes no price, decision or outcome fact at all', () => {
    const outcome = planEnquiryImport(input());
    if (outcome.outcome !== 'plan') throw new Error('expected a plan');

    const keys = outcome.facts.map((fact) => fact.fact_key);
    for (const forbidden of [
      'ai_suggested_amount',
      'human_approved_amount',
      'customer_facing_quote_amount',
      'final_amount_collected',
      'quote_decision',
      'actual_load_units',
      'actual_disposal_weight_kg',
      'actual_labour_minutes',
      'final_operational_outcome',
      'completed_at',
      'arrival_at',
      'departed_at',
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('records when the fact became known, from the enquiry itself', () => {
    const outcome = planEnquiryImport(input());
    if (outcome.outcome !== 'plan') throw new Error('expected a plan');

    expect(outcome.observedAt).toBe('2026-01-20T09:00:00.000Z');
    for (const fact of outcome.facts) {
      expect(fact.observed_at).toBe('2026-01-20T09:00:00.000Z');
    }
  });
});

describe('planEnquiryImport: unknown stays unknown', () => {
  it('imports nothing from an enquiry with no recorded detail', () => {
    const outcome = planEnquiryImport(
      input({
        enquiry: {
          id: ENQUIRY_ID,
          account_id: 'account-1',
          conversation_id: CONVERSATION_ID,
          workflow_state: 'new_enquiry',
          state_changed_at: '2026-02-01T09:00:00+00:00',
          created_at: '2026-02-01T09:00:00+00:00',
          customer_intent: null,
          postcode: null,
          address: null,
          property_type: null,
          floor: null,
          lift_available: null,
          parking: null,
          access_constraints: null,
          item_descriptions: null,
          waste_type: null,
          estimated_volume: null,
          heavy_special_items: null,
          photos_received: null,
        },
      })
    );

    expect(outcome).toMatchObject({
      outcome: 'skip',
      reason: 'no_mappable_facts',
      quality: 'unusable',
    });
  });

  it('never turns a missing value into a zero or a false', () => {
    const outcome = planEnquiryImport(
      input({ enquiry: enquiry({ lift_available: null, photos_received: null }) })
    );
    if (outcome.outcome !== 'plan') throw new Error('expected a plan');

    expect(outcome.facts.map((fact) => fact.fact_key)).not.toContain(
      'lift_available'
    );
    expect(outcome.facts.map((fact) => fact.fact_key)).not.toContain(
      'photos_received'
    );
  });

  it('keeps a recorded false, because false is a recorded answer', () => {
    const outcome = planEnquiryImport(input());
    if (outcome.outcome !== 'plan') throw new Error('expected a plan');

    expect(outcome.facts.map((fact) => fact.fact_key)).toContain(
      'lift_available'
    );
  });
});

describe('planEnquiryImport: unrecognizable values are reported, not repaired', () => {
  it('refuses to annotate a postcode that is not a postcode', () => {
    const outcome = planEnquiryImport(
      input({ enquiry: enquiry({ postcode: 'n/a' }) })
    );
    if (outcome.outcome !== 'plan') throw new Error('expected a plan');

    expect(outcome.facts.map((fact) => fact.fact_key)).not.toContain('postcode');
    expect(outcome.quality).toBe('partial');
    expect(outcome.qualityReasons.join(' ')).toMatch(/postcode/);
  });

  it('refuses an oversized text value instead of truncating it', () => {
    const outcome = planEnquiryImport(
      input({ enquiry: enquiry({ address: 'x'.repeat(2_001) }) })
    );
    if (outcome.outcome !== 'plan') throw new Error('expected a plan');

    expect(outcome.facts.map((fact) => fact.fact_key)).not.toContain('address');
    expect(outcome.quality).toBe('partial');
  });
});

describe('planEnquiryImport: idempotency and frozen truth', () => {
  it('skips a source record the ledger already attributes', () => {
    const outcome = planEnquiryImport(input({ alreadyAttributed: true }));

    expect(outcome).toMatchObject({
      outcome: 'skip',
      reason: 'already_imported',
      sourceKind: 'enquiry',
      sourceRecordId: ENQUIRY_ID,
    });
  });

  it('reports a conflict against a finalized case instead of touching it', () => {
    const outcome = planEnquiryImport(
      input({
        existingCase: { finalizedAt: '2026-03-01T00:00:00.000Z' },
      })
    );

    expect(outcome).toMatchObject({
      outcome: 'conflict',
      reason: 'finalized_case_not_mutated',
      enquiryId: ENQUIRY_ID,
    });
  });

  it('reuses an existing open case rather than proposing a second one', () => {
    const outcome = planEnquiryImport(
      input({ existingCase: { finalizedAt: null } })
    );

    expect(outcome).toMatchObject({
      outcome: 'plan',
      reusingCase: true,
    });
  });
});

describe('planEnquiryImport: provenance is never downgraded', () => {
  it('does not overwrite a fact an operator entered', () => {
    const outcome = planEnquiryImport(
      input({
        existingCase: { finalizedAt: null },
        existingFacts: [
          storedFact('postcode', 'customer_stated'),
          storedFact('access_constraints', 'operator_entered'),
        ],
      })
    );
    if (outcome.outcome !== 'plan') throw new Error('expected a plan');

    const keys = outcome.facts.map((fact) => fact.fact_key);
    expect(keys).not.toContain('postcode');
    expect(keys).not.toContain('access_constraints');
    expect(outcome.conflicts.map((conflict) => conflict.factKey).sort()).toEqual([
      'access_constraints',
      'postcode',
    ]);
  });

  it('leaves an already-imported annotation alone', () => {
    const outcome = planEnquiryImport(
      input({
        existingCase: { finalizedAt: null },
        existingFacts: [storedFact('postcode', 'imported_historical')],
      })
    );
    if (outcome.outcome !== 'plan') throw new Error('expected a plan');

    expect(outcome.facts.map((fact) => fact.fact_key)).not.toContain(
      'postcode'
    );
    expect(outcome.conflicts).toEqual([]);
  });
});

describe('planEnquiryImport: media references', () => {
  it('records inbound attachments as references and claims no observation', () => {
    const outcome = planEnquiryImport(
      input({
        mediaReferences: [
          { id: 'message-1', created_at: '2026-01-25T10:00:00+00:00' },
        ],
      })
    );
    if (outcome.outcome !== 'plan') throw new Error('expected a plan');

    expect(outcome.media).toEqual([
      {
        sourceRecordId: 'message-1',
        observedAt: '2026-01-25T10:00:00.000Z',
        quality: 'high_confidence_mapping',
        qualityReasons: [
          'a canonical inbound media reference; no image observation is claimed',
        ],
      },
    ]);
  });

  it('never writes an image_observed fact, because none was analysed', () => {
    const outcome = planEnquiryImport(
      input({
        mediaReferences: [
          { id: 'message-1', created_at: '2026-01-25T10:00:00+00:00' },
        ],
      })
    );
    if (outcome.outcome !== 'plan') throw new Error('expected a plan');

    const all = [...outcome.facts];
    expect(all.some((fact) => fact.provenance === 'image_observed')).toBe(false);
  });

  it('marks a reference with no usable timestamp as partial', () => {
    const outcome = planEnquiryImport(
      input({
        mediaReferences: [{ id: 'message-1', created_at: '2026-01-25' }],
      })
    );
    if (outcome.outcome !== 'plan') throw new Error('expected a plan');

    expect(outcome.media[0]?.quality).toBe('partial');
    expect(outcome.media[0]?.observedAt).toBeNull();
  });
});

describe('report-only adapters', () => {
  it('refuses to treat a conversation as a job', () => {
    expect(planLegacyConversation('conversation-1')).toEqual({
      outcome: 'skip',
      sourceKind: 'legacy_conversation',
      sourceRecordId: 'conversation-1',
      ref: 'legacy_conversation:conversation-1',
      reason: 'requires_enquiry_segmentation',
      quality: 'unusable',
    });
  });

  it('refuses to treat a deal value as a quote', () => {
    const outcome = planDeal({
      id: 'deal-1',
      value: 420,
      status: 'won',
    });

    expect(outcome).toMatchObject({
      outcome: 'skip',
      sourceKind: 'deal',
      reason: 'source_semantics_unproven',
      quality: 'unusable',
    });
  });
});