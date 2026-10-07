import { describe, expect, it } from 'vitest';

import {
  HISTORICAL_CASE_AI_FORBIDDEN_KEYS,
  HISTORICAL_CASE_EXPLICIT_REJECTION_DECISIONS,
  HISTORICAL_CASE_JOB_OUTCOMES,
  HISTORICAL_CASE_LOST_DECISIONS,
  HISTORICAL_CASE_RULE_VERSION,
  HISTORICAL_CASE_SCOPE_CHANGE_TYPES,
  HistoricalCaseValidationError,
  classifyHistoricalCaseEvidence,
  historicalCaseFactKind,
  historicalCaseLearningPopulation,
  isExplicitRejectionDecision,
  isHumanQuoteKey,
  parseHistoricalCase,
  parseHistoricalCaseFactInput,
  parseLearningEligibility,
  summarizeHistoricalCaseEvidence,
  type HistoricalCaseEvidenceInput,
  type HistoricalCaseFact,
  type HistoricalCaseFactValueKind,
} from './model';

const ACCOUNT = 'account-1';

function fact(
  overrides: Partial<HistoricalCaseFact> &
    Pick<HistoricalCaseFact, 'fact_key' | 'provenance'>
): HistoricalCaseFact {
  return {
    id: `fact-${overrides.fact_key}`,
    account_id: ACCOUNT,
    case_id: 'case-1',
    value_source: 'captured',
    value_text: null,
    value_number: null,
    value_integer: null,
    value_boolean: null,
    value_timestamp: null,
    source_message_id: null,
    source_media_id: null,
    observed_at: null,
    recorded_by_user_id: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function evidence(
  facts: HistoricalCaseFact[],
  options: {
    enquiryOutcome?: HistoricalCaseEvidenceInput['enquiryOutcome'];
    completedAt?: string | null;
  } = {}
): HistoricalCaseEvidenceInput {
  return {
    enquiryOutcome: options.enquiryOutcome ?? null,
    completedAt: options.completedAt ?? null,
    facts,
  };
}

describe('historical case fact vocabulary', () => {
  it('keeps canonical annotation keys separate from captured values', () => {
    expect(historicalCaseFactKind('postcode')).toBe('text');
    expect(historicalCaseFactKind('crew_count')).toBe('integer');
    expect(historicalCaseFactKind('actual_disposal_weight_kg')).toBe('number');
    expect(historicalCaseFactKind('dismantling_required')).toBe('boolean');
    expect(historicalCaseFactKind('not_a_fact')).toBeNull();
  });

  it('refuses to duplicate a fact that already exists on the enquiry', () => {
    expect(() =>
      parseHistoricalCaseFactInput({
        fact_key: 'postcode',
        provenance: 'customer_stated',
        value_text: '01310-100',
      })
    ).toThrow(/already exists on the enquiry/);
  });

  it('records the provenance of a canonical fact without a value', () => {
    const parsed = parseHistoricalCaseFactInput({
      fact_key: 'postcode',
      provenance: 'customer_stated',
    });
    expect(parsed.value_source).toBe('canonical');
    expect(parsed.value_text).toBeNull();
  });

  it('requires exactly one value of the declared kind', () => {
    expect(() =>
      parseHistoricalCaseFactInput({
        fact_key: 'crew_count',
        provenance: 'operator_entered',
        value_integer: 2,
        value_text: 'two',
      })
    ).toThrow(/exactly one value/);

    expect(() =>
      parseHistoricalCaseFactInput({
        fact_key: 'crew_count',
        provenance: 'operator_entered',
        value_text: 'two',
      })
    ).toThrow(/not a text fact/);

    expect(() =>
      parseHistoricalCaseFactInput({
        fact_key: 'crew_count',
        provenance: 'operator_entered',
      })
    ).toThrow(/exactly one value/);
  });

  it('treats quote_decision as a closed vocabulary', () => {
    expect(
      parseHistoricalCaseFactInput({
        fact_key: 'quote_decision',
        provenance: 'customer_stated',
        value_text: 'accepted',
      }).value_text
    ).toBe('accepted');

    expect(() =>
      parseHistoricalCaseFactInput({
        fact_key: 'quote_decision',
        provenance: 'customer_stated',
        value_text: 'maybe later',
      })
    ).toThrow(/quote_decision must be one of/);
  });

  it('rejects an unknown fact key', () => {
    expect(() =>
      parseHistoricalCaseFactInput({
        fact_key: 'vibes',
        provenance: 'operator_entered',
        value_text: 'good',
      })
    ).toThrow(HistoricalCaseValidationError);
  });

  it('requires a source image for an image-observed fact', () => {
    expect(() =>
      parseHistoricalCaseFactInput({
        fact_key: 'dismantling_required',
        value_source: 'captured',
        provenance: 'image_observed',
        value_boolean: true,
      })
    ).toThrow(/must name the message and media/);

    expect(
      parseHistoricalCaseFactInput({
        fact_key: 'dismantling_required',
        provenance: 'image_observed',
        value_boolean: true,
        source_message_id: 'message-1',
        source_media_id: 'media-1',
      }).provenance
    ).toBe('image_observed');
  });
});

describe('AI feedback-loop protection', () => {
  it('forbids ai_suggested on every outcome, quote and decision fact', () => {
    for (const key of HISTORICAL_CASE_AI_FORBIDDEN_KEYS) {
      const kind = historicalCaseFactKind(key);
      expect(kind, `${key} must have a declared kind`).not.toBeNull();
      expect(() =>
        parseHistoricalCaseFactInput({
          fact_key: key,
          provenance: 'ai_suggested',
          ...valueForKey(
            key,
            kind as HistoricalCaseFactValueKind
          ),
        })
      ).toThrow(/cannot carry ai_suggested provenance/);
    }
  });

  it('requires ai_suggested_amount to be an AI suggestion', () => {
    expect(() =>
      parseHistoricalCaseFactInput({
        fact_key: 'ai_suggested_amount',
        provenance: 'operator_entered',
        value_number: 420,
      })
    ).toThrow(/must carry ai_suggested provenance/);

    expect(
      parseHistoricalCaseFactInput({
        fact_key: 'ai_suggested_amount',
        provenance: 'ai_suggested',
        value_number: 420,
      }).provenance
    ).toBe('ai_suggested');
  });

  it('only allows confirmed_outcome on post-job facts', () => {
    expect(() =>
      parseHistoricalCaseFactInput({
        fact_key: 'crew_count',
        provenance: 'confirmed_outcome',
        value_integer: 2,
      })
    ).toThrow(/not a post-job fact/);

    expect(
      parseHistoricalCaseFactInput({
        fact_key: 'final_amount_collected',
        provenance: 'confirmed_outcome',
        value_number: 380,
      }).provenance
    ).toBe('confirmed_outcome');
  });

  it('does not let an AI-only case reach a trustworthy tier', () => {
    const classification = classifyHistoricalCaseEvidence(
      evidence([
        fact({
          fact_key: 'ai_suggested_amount',
          provenance: 'ai_suggested',
          value_number: 400,
        }),
      ])
    );

    expect(classification.tier).toBe('E');
    expect(HISTORICAL_CASE_AI_FORBIDDEN_KEYS).toContain(
      'final_amount_collected'
    );
  });

  it('treats a human-issued quote as something a person did', () => {
    expect(isHumanQuoteKey('customer_facing_quote_amount')).toBe(true);
    expect(isHumanQuoteKey('human_approved_amount')).toBe(true);
    expect(isHumanQuoteKey('ai_suggested_amount')).toBe(false);
  });
});

describe('evidence-quality classification', () => {
  it('leaves a case with no recorded facts unclassified', () => {
    const classification = classifyHistoricalCaseEvidence(evidence([]));
    expect(classification.tier).toBeNull();
    expect(classification.reasons).toContain(
      'no learning facts have been recorded'
    );
    expect(classification.rule_version).toBe(HISTORICAL_CASE_RULE_VERSION);
  });

  it('leaves a case with only descriptive facts unclassified', () => {
    const classification = classifyHistoricalCaseEvidence(
      evidence([
        fact({
          fact_key: 'service_type',
          provenance: 'customer_stated',
          value_text: 'house_clearance',
        }),
      ])
    );
    expect(classification.tier).toBeNull();
    expect(classification.reasons).toContain(
      'no price, decision or outcome evidence has been recorded yet'
    );
  });

  it('classifies a human quote with no decision as tier D while the job runs', () => {
    const classification = classifyHistoricalCaseEvidence(
      evidence([
        fact({
          fact_key: 'customer_facing_quote_amount',
          provenance: 'operator_entered',
          value_number: 400,
        }),
      ])
    );
    expect(classification.tier).toBe('D');
  });

  it('classifies a completed job with a confirmed final amount as tier A', () => {
    const classification = classifyHistoricalCaseEvidence(
      evidence(
        [
          fact({
            fact_key: 'customer_facing_quote_amount',
            provenance: 'operator_entered',
            value_number: 400,
          }),
          fact({
            fact_key: 'final_amount_collected',
            provenance: 'confirmed_outcome',
            value_number: 380,
          }),
        ],
        { completedAt: '2026-02-02T10:00:00.000Z', enquiryOutcome: 'completed' }
      )
    );
    expect(classification.tier).toBe('A');
  });

  it('classifies an accepted quote with an incomplete outcome as tier B', () => {
    const classification = classifyHistoricalCaseEvidence(
      evidence([
        fact({
          fact_key: 'customer_facing_quote_amount',
          provenance: 'operator_entered',
          value_number: 400,
        }),
        fact({
          fact_key: 'quote_decision',
          provenance: 'customer_stated',
          value_text: 'accepted',
        }),
      ])
    );
    expect(classification.tier).toBe('B');
  });

  it('classifies acceptance without a captured final amount as tier C', () => {
    const classification = classifyHistoricalCaseEvidence(
      evidence(
        [
          fact({
            fact_key: 'human_approved_amount',
            provenance: 'operator_entered',
            value_number: 400,
          }),
          fact({
            fact_key: 'quote_decision',
            provenance: 'customer_stated',
            value_text: 'accepted',
          }),
        ],
        { completedAt: '2026-02-02T10:00:00.000Z' }
      )
    );
    expect(classification.tier).toBe('C');
  });

  it('classifies a human quote with no decision as tier D', () => {
    const classification = classifyHistoricalCaseEvidence(
      evidence([
        fact({
          fact_key: 'human_approved_amount',
          provenance: 'operator_entered',
          value_number: 400,
        }),
      ])
    );
    expect(classification.tier).toBe('D');
  });

  it('classifies AI-only evidence as tier E', () => {
    const classification = classifyHistoricalCaseEvidence(
      evidence([
        fact({
          fact_key: 'ai_suggested_amount',
          provenance: 'ai_suggested',
          value_number: 395,
        }),
        fact({
          fact_key: 'service_type',
          provenance: 'customer_stated',
          value_text: 'house_clearance',
        }),
      ])
    );
    expect(classification.tier).toBe('E');
  });

  it('only reaches tier E when an AI amount actually exists', () => {
    const classification = classifyHistoricalCaseEvidence(
      evidence([
        fact({
          fact_key: 'crew_count',
          provenance: 'operator_entered',
          value_integer: 2,
        }),
        fact({
          fact_key: 'actual_load_units',
          provenance: 'confirmed_outcome',
          value_number: 6,
        }),
      ])
    );
    // A confirmed outcome with no human quote is still stronger than a
    // suggestion, but it is not a tier the ladder can honestly name.
    expect(classification.tier).toBe('E');
  });

  it('classifies a rejected or cancelled enquiry as tier F', () => {
    const rejected = classifyHistoricalCaseEvidence(
      evidence([
        fact({
          fact_key: 'customer_facing_quote_amount',
          provenance: 'operator_entered',
          value_number: 400,
        }),
        fact({
          fact_key: 'quote_decision',
          provenance: 'customer_stated',
          value_text: 'rejected',
        }),
      ])
    );
    expect(rejected.tier).toBe('F');

    const cancelled = classifyHistoricalCaseEvidence(
      evidence(
        [
          fact({
            fact_key: 'customer_facing_quote_amount',
            provenance: 'operator_entered',
            value_number: 400,
          }),
        ],
        { enquiryOutcome: 'cancelled' }
      )
    );
    expect(cancelled.tier).toBe('F');
  });

  it('places every lost decision at F without conflating them', () => {
    const classifications = HISTORICAL_CASE_LOST_DECISIONS.map((decision) =>
      classifyHistoricalCaseEvidence(
        evidence([
          fact({
            fact_key: 'customer_facing_quote_amount',
            provenance: 'operator_entered',
            value_number: 400,
          }),
          fact({
            fact_key: 'quote_decision',
            provenance: 'operator_entered',
            value_text: decision,
          }),
        ])
      )
    );

    for (const classification of classifications) {
      expect(classification.tier).toBe('F');
      expect(classification.quote_decision).not.toBeNull();
    }

    // Each carries its own reason, so a lost-business analysis reading
    // only `evidence_reasons` can still tell them apart.
    const reasonSets = classifications.map((c) => c.reasons.join(' | '));
    expect(new Set(reasonSets).size).toBe(
      HISTORICAL_CASE_LOST_DECISIONS.length
    );
  });

  it('never treats a lost quote as a completed-job price', () => {
    for (const decision of HISTORICAL_CASE_LOST_DECISIONS) {
      const classification = classifyHistoricalCaseEvidence(
        evidence([
          fact({
            fact_key: 'customer_facing_quote_amount',
            provenance: 'operator_entered',
            value_number: 400,
          }),
          fact({
            fact_key: 'quote_decision',
            provenance: 'operator_entered',
            value_text: decision,
          }),
        ])
      );
      // Even when the enquiry is somehow marked completed, a lost
      // decision is decided before the tier ladder runs.
      expect(classification.tier).toBe('F');
      expect(
        historicalCaseLearningPopulation({
          learningEligibility: 'pending',
          classification,
        })
      ).not.toBe('completed_trusted_price_outcome');
    }
  });

  it('refuses to classify conflicting evidence', () => {
    const classification = classifyHistoricalCaseEvidence(
      evidence(
        [
          fact({
            fact_key: 'final_amount_collected',
            provenance: 'confirmed_outcome',
            value_number: 380,
          }),
        ],
        { enquiryOutcome: 'cancelled' }
      )
    );
    expect(classification.tier).toBeNull();
    expect(classification.reasons).toContain(
      'the enquiry is cancelled but a confirmed outcome is recorded'
    );
  });

  it('does not promote an AI-suggested amount to a collected final amount', () => {
    const summary = summarizeHistoricalCaseEvidence(
      evidence([
        fact({
          fact_key: 'ai_suggested_amount',
          provenance: 'ai_suggested',
          value_number: 400,
        }),
      ])
    );
    expect(summary.aiSuggestedAmounts).toEqual([400]);
    expect(summary.finalAmountsCollected).toEqual([]);
    expect(summary.humanQuoteAmounts).toEqual([]);
  });

  it('is deterministic for the same evidence', () => {
    const facts = [
      fact({
        fact_key: 'customer_facing_quote_amount',
        provenance: 'operator_entered',
        value_number: 400,
      }),
    ];
    expect(classifyHistoricalCaseEvidence(evidence(facts))).toEqual(
      classifyHistoricalCaseEvidence(evidence(facts))
    );
  });
});

describe('outcome capture vocabulary', () => {
  it('treats arrival and departure as timestamps, not text', () => {
    expect(historicalCaseFactKind('arrival_at')).toBe('timestamp');
    expect(historicalCaseFactKind('departed_at')).toBe('timestamp');

    const parsed = parseHistoricalCaseFactInput({
      fact_key: 'arrival_at',
      provenance: 'confirmed_outcome',
      value_timestamp: '2026-03-01T09:00:00+00:00',
    });
    expect(parsed.value_timestamp).toBe('2026-03-01T09:00:00+00:00');
  });

  it('refuses a timestamp that is a string, a number or a local time', () => {
    for (const value of [
      '09:00',
      '2026-03-01T09:00:00',
      1_774_000_000_000,
    ]) {
      expect(() =>
        parseHistoricalCaseFactInput({
          fact_key: 'departed_at',
          provenance: 'confirmed_outcome',
          value_timestamp: value,
        })
      ).toThrow(/timestamp/);
    }
  });

  it('keeps the operational outcome a closed vocabulary', () => {
    for (const value of HISTORICAL_CASE_JOB_OUTCOMES) {
      expect(
        parseHistoricalCaseFactInput({
          fact_key: 'final_operational_outcome',
          provenance: 'operator_entered',
          value_text: value,
        }).value_text
      ).toBe(value);
    }
    expect(() =>
      parseHistoricalCaseFactInput({
        fact_key: 'final_operational_outcome',
        provenance: 'operator_entered',
        value_text: 'mostly done',
      })
    ).toThrow(/final_operational_outcome must be one of/);
  });

  it('keeps the scope change a closed vocabulary', () => {
    for (const value of HISTORICAL_CASE_SCOPE_CHANGE_TYPES) {
      expect(
        parseHistoricalCaseFactInput({
          fact_key: 'scope_change_type',
          provenance: 'operator_entered',
          value_text: value,
        }).value_text
      ).toBe(value);
    }
    expect(() =>
      parseHistoricalCaseFactInput({
        fact_key: 'scope_change_type',
        provenance: 'operator_entered',
        value_text: 'a bit harder',
      })
    ).toThrow(/scope_change_type must be one of/);
  });

  it('splits no_response out of an explicit rejection', () => {
    expect(HISTORICAL_CASE_EXPLICIT_REJECTION_DECISIONS).not.toContain(
      'no_response'
    );
    expect(HISTORICAL_CASE_LOST_DECISIONS).toContain('no_response');
    expect(isExplicitRejectionDecision('no_response')).toBe(false);
    expect(isExplicitRejectionDecision('rejected_price')).toBe(true);
    expect(isExplicitRejectionDecision('found_better_price')).toBe(true);
  });
});

describe('learning populations', () => {
  function populationFor(
    facts: HistoricalCaseFact[],
    overrides: {
      enquiryOutcome?: 'completed' | 'cancelled' | null;
      completedAt?: string | null;
      eligibility?: 'pending' | 'included' | 'excluded';
    } = {}
  ) {
    const classification = classifyHistoricalCaseEvidence({
      enquiryOutcome: overrides.enquiryOutcome ?? null,
      completedAt: overrides.completedAt ?? null,
      facts,
    });
    return historicalCaseLearningPopulation({
      learningEligibility: overrides.eligibility ?? 'pending',
      classification,
    });
  }

  it('separates a trusted price outcome from everything else', () => {
    expect(
      populationFor(
        [
          fact({
            fact_key: 'final_amount_collected',
            provenance: 'confirmed_outcome',
            value_number: 385,
          }),
        ],
        { completedAt: '2026-03-01T11:30:00.000Z' }
      )
    ).toBe('completed_trusted_price_outcome');
  });

  it('keeps an accepted quote out of the completed populations', () => {
    expect(
      populationFor([
        fact({
          fact_key: 'quote_decision',
          provenance: 'operator_entered',
          value_text: 'accepted',
        }),
      ])
    ).toBe('accepted_quote_outcome_pending');

    expect(
      populationFor(
        [
          fact({
            fact_key: 'quote_decision',
            provenance: 'operator_entered',
            value_text: 'accepted',
          }),
        ],
        { completedAt: '2026-03-01T11:30:00.000Z' }
      )
    ).toBe('completed_outcome_without_final_amount');
  });

  it('keeps rejections, silence and other losses apart', () => {
    const forDecision = (value: string) =>
      populationFor([
        fact({
          fact_key: 'quote_decision',
          provenance: 'operator_entered',
          value_text: value,
        }),
      ]);

    expect(forDecision('rejected_price')).toBe('explicitly_rejected_quote');
    expect(forDecision('found_better_price')).toBe('explicitly_rejected_quote');
    expect(forDecision('no_response')).toBe('no_response_quote');
    expect(forDecision('cancelled_by_customer')).toBe('other_lost_quote');
  });

  it('never lets an exclusion be recovered by filtering on evidence', () => {
    expect(
      populationFor(
        [
          fact({
            fact_key: 'final_amount_collected',
            provenance: 'confirmed_outcome',
            value_number: 385,
          }),
        ],
        {
          completedAt: '2026-03-01T11:30:00.000Z',
          eligibility: 'excluded',
        }
      )
    ).toBe('excluded');
  });

  it('files an AI-only case apart from a real one', () => {
    expect(
      populationFor([
        fact({
          fact_key: 'ai_suggested_amount',
          provenance: 'ai_suggested',
          value_number: 380,
        }),
      ])
    ).toBe('ai_suggestion_only');
  });

  it('files an unplaced case as unclassified, not as a low tier', () => {
    expect(populationFor([])).toBe('unclassified');
  });
});

describe('learning eligibility', () => {
  it('requires a reason for an exclusion', () => {
    expect(() =>
      parseLearningEligibility({
        eligibility: 'excluded',
        reason: null,
        basis: 'operator',
      })
    ).toThrow(/must say why/);
  });

  it('rejects a reason on a case that is not excluded', () => {
    expect(() =>
      parseLearningEligibility({
        eligibility: 'included',
        reason: 'test_data',
        basis: 'operator',
      })
    ).toThrow(/Only an excluded case/);
  });

  it('accepts an include decision', () => {
    expect(
      parseLearningEligibility({
        eligibility: 'included',
        reason: null,
        basis: 'operator',
      })
    ).toEqual({ eligibility: 'included', reason: null, basis: 'operator' });
  });
});

describe('historical case parsing', () => {
  const base = {
    id: 'case-1',
    account_id: ACCOUNT,
    enquiry_id: 'enquiry-1',
    conversation_id: 'conversation-1',
    contact_id: 'contact-1',
    source_kind: 'live_enquiry',
    case_state: 'open',
    completed_at: null,
    evidence_quality_tier: null,
    evidence_rule_version: null,
    evidence_reasons: [],
    evidence_classified_at: null,
    learning_eligibility: 'pending',
    learning_exclusion_reason: null,
    learning_eligibility_basis: null,
    finalized_at: null,
    created_by_user_id: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };

  it('accepts an untouched case', () => {
    expect(parseHistoricalCase(base).learning_eligibility).toBe('pending');
  });

  it('accepts an explicitly unclassified case', () => {
    const parsed = parseHistoricalCase({
      ...base,
      evidence_quality_tier: null,
      evidence_rule_version: HISTORICAL_CASE_RULE_VERSION,
      evidence_classified_at: '2026-01-02T00:00:00.000Z',
      evidence_reasons: ['no learning facts have been recorded'],
    });
    expect(parsed.evidence_quality_tier).toBeNull();
    expect(parsed.evidence_classified_at).toBe('2026-01-02T00:00:00.000Z');
  });

  it('rejects an unknown tier', () => {
    expect(() =>
      parseHistoricalCase({ ...base, evidence_quality_tier: 'G' })
    ).toThrow(/Invalid evidence tier/);
  });

  it('rejects a finalized case with no finalization timestamp', () => {
    expect(() =>
      parseHistoricalCase({ ...base, case_state: 'finalized' })
    ).toThrow(/finalized_at/);
  });

  it('rejects an exclusion with no reason', () => {
    expect(() =>
      parseHistoricalCase({ ...base, learning_eligibility: 'excluded' })
    ).toThrow(/learning_exclusion_reason is required/);
  });

  it('rejects a classification timestamp with no rule version', () => {
    expect(() =>
      parseHistoricalCase({
        ...base,
        evidence_classified_at: '2026-01-02T00:00:00.000Z',
      })
    ).toThrow(/must be set together/);
  });
});

function valueForKey(
  key: string,
  kind: HistoricalCaseFactValueKind
): Record<string, unknown> {
  if (kind === 'boolean') return { value_boolean: true };
  if (kind === 'integer') return { value_integer: 1 };
  if (kind === 'number') return { value_number: 1 };
  if (kind === 'timestamp') return { value_timestamp: '2026-03-01T09:00:00Z' };
  if (key === 'quote_decision') return { value_text: 'accepted' };
  if (key === 'final_operational_outcome') {
    return { value_text: 'completed' };
  }
  if (key === 'scope_change_type') {
    return { value_text: 'no_material_change' };
  }
  return { value_text: 'test' };
}
