import { describe, expect, it } from 'vitest';

import type { HistoricalCaseFact } from '@/lib/historical-cases/model';

import { VectorMemoryError, assertNoMonetaryLeakage } from './model';
import {
  buildCaseSemanticInput,
  buildImageObservationSemanticInput,
  imageObservationRecordsFromAnalysis,
  imageObservationRecordsFromSnapshot,
  sha256Hex,
  type ImageObservationRecord,
  type SemanticCaseSource,
} from './semantic-input';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function capturedFact(
  fact_key: string,
  value:
    | { text: string }
    | { number: number }
    | { integer: number }
    | { boolean: boolean },
  provenance = 'operator_entered'
): HistoricalCaseFact {
  return {
    id: `fact-${fact_key}`,
    account_id: 'acct-1',
    case_id: 'case-1',
    fact_key: fact_key as HistoricalCaseFact['fact_key'],
    value_source: 'captured',
    value_text: 'text' in value ? value.text : null,
    value_number: 'number' in value ? value.number : null,
    value_integer: 'integer' in value ? value.integer : null,
    value_boolean: 'boolean' in value ? value.boolean : null,
    value_timestamp: null,
    provenance: provenance as HistoricalCaseFact['provenance'],
    source_message_id: null,
    source_media_id: null,
    observed_at: null,
    recorded_by_user_id: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

function source(
  overrides: Partial<SemanticCaseSource> = {}
): SemanticCaseSource {
  return {
    case_id: 'case-1',
    account_id: 'acct-1',
    case_state: 'finalized',
    source_kind: 'live_enquiry',
    evidence_quality_tier: 'A',
    learning_eligibility: 'included',
    completed_at: '2026-01-05T10:00:00Z',
    finalized_at: '2026-01-05T11:00:00Z',
    enquiry: {
      item_descriptions: ['three seater sofa', 'armchair', 'dining table'],
      waste_type: 'general household waste',
      property_type: 'flat',
      floor: 'third floor',
      lift_available: false,
      parking: 'on street, no driveway',
      access_constraints: ['narrow staircase', 'rear entry only'],
      estimated_volume: 'about one skip',
      heavy_special_items: ['piano safe'],
    },
    facts: [
      capturedFact('service_type', { text: 'house clearance' }),
      capturedFact('item_count', { integer: 5 }),
      capturedFact('estimated_load_units', { number: 1 }),
      capturedFact('actual_load_units', { number: 2 }, 'confirmed_outcome'),
      capturedFact('carry_distance_metres', { integer: 40 }),
      capturedFact('dismantling_required', { boolean: true }),
      capturedFact('actual_dismantling_required', { boolean: false }),
      capturedFact('crew_count', { integer: 2 }),
      capturedFact('estimated_labour_minutes', { integer: 120 }),
      capturedFact('actual_labour_minutes', { integer: 95 }, 'system_derived'),
    ],
    source_entity: 'historical_case_snapshot',
    source_reference: 'snap-1',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Case semantic input
// ---------------------------------------------------------------------------

describe('buildCaseSemanticInput', () => {
  it('includes the structured items, quantities and waste category', () => {
    const out = buildCaseSemanticInput(source());
    expect(out.kind).toBe('case_text');
    expect(out.text).toContain(
      'job items: armchair; dining table; three seater sofa'
    );
    expect(out.text).toContain('job item count: 5');
    expect(out.text).toContain('job waste type: general household waste');
  });

  it('includes floor, lift, parking, carry distance and access conditions', () => {
    const text = buildCaseSemanticInput(source()).text;
    expect(text).toContain('job floor: third floor');
    expect(text).toContain('job lift available: no');
    expect(text).toContain('job parking: on street, no driveway');
    expect(text).toContain('job carry distance metres: 40');
    expect(text).toContain('job access constraints: narrow staircase; rear entry only');
    expect(text).toContain('job property type: flat');
  });

  it('keeps estimated and actual load as separate statements', () => {
    const text = buildCaseSemanticInput(source()).text;
    expect(text).toContain('job estimated load units: 1');
    expect(text).toContain('job actual load units: 2');
    // They must not collapse into one line.
    expect(text).not.toContain('job load units: 2');
  });

  it('keeps estimated and actual labour as separate statements', () => {
    const text = buildCaseSemanticInput(source()).text;
    expect(text).toContain('job estimated labour minutes: 120');
    expect(text).toContain('job actual labour minutes: 95');
  });

  it('keeps quoted and actual dismantling separate', () => {
    const text = buildCaseSemanticInput(source()).text;
    expect(text).toContain('job dismantling required when estimated: yes');
    expect(text).toContain('job dismantling required on the day: no');
  });

  it('uses section labels that do not themselves trip the leakage guard', () => {
    // Every label WACRM emits is reviewed code, so a label containing a
    // commercial word would make every affected job permanently
    // un-embeddable. Asserted so a future label cannot reintroduce it.
    for (const label of [
      'job service',
      'job items',
      'job item count',
      'job heavy or special items',
      'job estimated volume',
      'job estimated load units',
      'job actual load units',
      'job waste type',
      'job property type',
      'job floor',
      'job lift available',
      'job parking',
      'job access constraints',
      'job carry distance metres',
      'job dismantling required when estimated',
      'job dismantling required on the day',
      'job crew size',
      'job estimated labour minutes',
      'job actual labour minutes',
      'job scope change',
    ]) {
      expect(() => assertNoMonetaryLeakage(label, 'a label')).not.toThrow();
    }
  });

  it('leaves an unknown field absent rather than recording it as a negative', () => {
    const out = buildCaseSemanticInput(
      source({
        enquiry: { item_descriptions: ['sofa'], waste_type: 'household waste' },
        facts: [capturedFact('service_type', { text: 'clearance' })],
      })
    );
    expect(out.text).toContain('job items: sofa');
    expect(out.text).not.toContain('job floor');
    expect(out.text).not.toContain('job lift available');
    expect(out.text).not.toContain('job carry distance');
    // "no" would mean the lift was known not to exist.
    expect(out.text).not.toMatch(/lift available: no\b/);
  });

  it('is deterministic for the same input', () => {
    const a = buildCaseSemanticInput(source());
    const b = buildCaseSemanticInput(source());
    expect(a.text).toBe(b.text);
    expect(a.content_hash).toBe(b.content_hash);
  });

  it('produces the same hash regardless of fact or item ordering', () => {
    const reordered = source();
    reordered.facts = [...reordered.facts].reverse();
    reordered.enquiry = {
      ...reordered.enquiry,
      item_descriptions: ['dining table', 'three seater sofa', 'armchair'],
    };
    const a = buildCaseSemanticInput(source());
    const b = buildCaseSemanticInput(reordered);
    expect(b.text).toBe(a.text);
    expect(b.content_hash).toBe(a.content_hash);
  });

  it('changes the hash when operational content changes', () => {
    const a = buildCaseSemanticInput(source());
    const changed = source();
    changed.facts = [
      ...source().facts.filter((f) => f.fact_key !== 'actual_load_units'),
      capturedFact('actual_load_units', { number: 3 }, 'confirmed_outcome'),
    ];
    const b = buildCaseSemanticInput(changed);
    expect(b.content_hash).not.toBe(a.content_hash);
  });

  it('uses a stable semantic input version', () => {
    expect(buildCaseSemanticInput(source()).semantic_input_version).toBe(
      'case-text-v1'
    );
  });

  it('refuses a case with nothing to describe', () => {
    expect(() =>
      buildCaseSemanticInput(
        source({ enquiry: null, facts: [], case_state: 'open' })
      )
    ).toThrow(VectorMemoryError);
  });

  // -------------------------------------------------------------------------
  // Price-leakage protection
  // -------------------------------------------------------------------------

  it('excludes every monetary fact even when one is recorded', () => {
    const withMoney = source();
    withMoney.facts = [
      ...withMoney.facts,
      capturedFact('ai_suggested_amount', { number: 420 }, 'ai_suggested'),
      capturedFact('human_approved_amount', { number: 450 }),
      capturedFact('customer_facing_quote_amount', { number: 500 }),
      capturedFact(
        'final_amount_collected',
        { number: 475 },
        'confirmed_outcome'
      ),
      capturedFact('quote_adjustment_amount', { number: -25 }),
    ];
    const text = buildCaseSemanticInput(withMoney).text;
    expect(text).not.toContain('420');
    expect(text).not.toContain('450');
    expect(text).not.toContain('500');
    expect(text).not.toContain('475');
    expect(text).not.toContain('25');
    expect(text).not.toMatch(/amount|price|quote|cost|paid|invoice/i);
  });

  it('excludes the final collected amount specifically', () => {
    const withMoney = source();
    withMoney.facts = [
      ...withMoney.facts,
      capturedFact(
        'final_amount_collected',
        { number: 1875.55 },
        'confirmed_outcome'
      ),
    ];
    const out = buildCaseSemanticInput(withMoney);
    expect(out.text).not.toContain('1875');
    expect(out.text).not.toContain('1875.55');
  });

  it('excludes the customer decision (quote_decision)', () => {
    const withDecision = source();
    withDecision.facts = [
      ...withDecision.facts,
      capturedFact('quote_decision', { text: 'rejected_price' }),
    ];
    const out = buildCaseSemanticInput(withDecision);
    expect(out.text).not.toContain('rejected_price');
    expect(out.text).not.toMatch(/reject/i);
  });

  it('excludes customer identifiers, address and postcode', () => {
    const identifying = source();
    identifying.enquiry = {
      ...identifying.enquiry,
      customer_intent:
        'Priya Raman said move to 14 Oakfield Road, SW1A 1AA, paid 300 last time',
      postcode: 'SW1A 1AA',
      address: '14 Oakfield Road',
    } as SemanticCaseSource['enquiry'];
    const out = buildCaseSemanticInput(identifying);
    expect(out.text).not.toContain('Priya');
    expect(out.text).not.toContain('Oakfield');
    expect(out.text).not.toContain('SW1A');
    expect(out.text).not.toContain('customer_intent');
  });

  it('excludes free-text operator notes and travel distance', () => {
    const noisy = source();
    noisy.facts = [
      ...noisy.facts,
      capturedFact('final_job_notes', {
        text: 'customer complained the quote was too dear',
      }),
      capturedFact('travel_distance_km', { number: 34 }),
      capturedFact('travel_time_minutes', { integer: 55 }),
    ];
    const out = buildCaseSemanticInput(noisy);
    expect(out.text).not.toContain('complained');
    expect(out.text).not.toContain('dear');
    expect(out.text).not.toContain('34');
    expect(out.text).not.toContain('55');
  });

  it('includes a closed-vocabulary scope-change descriptor', () => {
    const scoped = source();
    scoped.facts = [
      ...scoped.facts,
      capturedFact('scope_change_type', { text: 'more_waste_than_expected' }),
    ];
    expect(buildCaseSemanticInput(scoped).text).toContain(
      'job scope change: more_waste_than_expected'
    );
  });

  it('omits a scope change that means "nothing changed"', () => {
    const scoped = source();
    scoped.facts = [
      ...scoped.facts,
      capturedFact('scope_change_type', { text: 'no_material_change' }),
    ];
    expect(buildCaseSemanticInput(scoped).text).not.toContain('job scope change');
  });

  it('refuses semantic input containing a monetary token', () => {
    const leaky = source();
    leaky.enquiry = {
      ...leaky.enquiry,
      item_descriptions: ['sofa', 'customer rejected the price'],
    };
    expect(() => buildCaseSemanticInput(leaky)).toThrow(/monetary/i);
  });

  it('refuses semantic input containing a currency amount', () => {
    const leaky = source();
    leaky.enquiry = {
      ...leaky.enquiry,
      estimated_volume: 'about £450 worth of waste',
    };
    expect(() => buildCaseSemanticInput(leaky)).toThrow(/monetary/i);
  });

  it('counts signals so a near-empty case cannot be embedded', () => {
    const thin = buildCaseSemanticInput(
      source({
        enquiry: { item_descriptions: ['sofa'] },
        facts: [],
      })
    );
    expect(thin.signal_count).toBe(1);
  });

  it('records the source entity and reference for traceability', () => {
    const out = buildCaseSemanticInput(source());
    expect(out.source_entity).toBe('historical_case_snapshot');
    expect(out.source_reference).toBe('snap-1');
  });
});

// ---------------------------------------------------------------------------
// Image observation text
// ---------------------------------------------------------------------------

function observation(
  overrides: Partial<ImageObservationRecord> = {}
): ImageObservationRecord {
  return {
    category: 'three seater sofa',
    count: 1,
    uncertainty: 'observed',
    volume_min: 2,
    volume_max: 3,
    dismantling: 'not_indicated',
    heavy: 'not_indicated',
    note: null,
    ...overrides,
  };
}

describe('buildImageObservationSemanticInput', () => {
  it('is deterministic and order-independent', () => {
    const a = buildImageObservationSemanticInput([
      observation(),
      observation({ category: 'refrigerator', count: 2 }),
    ]);
    const b = buildImageObservationSemanticInput([
      observation({ category: 'refrigerator', count: 2 }),
      observation(),
    ]);
    expect(a.text).toBe(b.text);
    expect(a.content_hash).toBe(b.content_hash);
  });

  it('is named image_observation_text and never native_image', () => {
    const out = buildImageObservationSemanticInput([observation()]);
    expect(out.kind).toBe('image_observation_text');
    expect(out.semantic_input_version).toBe('image-observation-text-v1');
  });

  it('includes category, approximate count and relative volume', () => {
    const text = buildImageObservationSemanticInput([observation()]).text;
    expect(text).toContain('observed three seater sofa');
    expect(text).toContain('about 1');
    expect(text).toContain('relative volume 2 to 3');
  });

  it('preserves ambiguity instead of resolving it', () => {
    const text = buildImageObservationSemanticInput([
      observation({ uncertainty: 'ambiguous', count: null }),
    ]).text;
    expect(text).toContain('uncertain');
    const unconfirmed = buildImageObservationSemanticInput([
      observation({ uncertainty: 'unknown' }),
    ]).text;
    expect(unconfirmed).toContain('unconfirmed');
  });

  it('records dismantling and heavy-handling indicators when indicated', () => {
    const text = buildImageObservationSemanticInput([
      observation({ dismantling: 'indicated', heavy: 'indicated' }),
    ]).text;
    expect(text).toContain('needs dismantling');
    expect(text).toContain('needs heavy handling');
  });

  it('omits an unknown tristate rather than calling it absent', () => {
    const text = buildImageObservationSemanticInput([
      observation({ dismantling: 'unknown', heavy: 'not_indicated' }),
    ]).text;
    expect(text).not.toContain('needs dismantling');
    expect(text).not.toContain('needs heavy handling');
  });

  it('contains no storage path, signed URL, message id or media id', () => {
    const records = imageObservationRecordsFromSnapshot({
      observations: [
        {
          fact_key: 'item_descriptions',
          value: 'sofa',
          source_message_id: 'msg-123',
          source_media_id: 'acct-1/inbound/2026/01/01/photo.jpg',
          observed_at: '2026-01-01T00:00:00Z',
        },
      ],
    });
    const out = buildImageObservationSemanticInput(records);
    expect(out.text).not.toContain('msg-123');
    expect(out.text).not.toContain('acct-1/inbound');
    expect(out.text).not.toContain('photo.jpg');
    expect(out.text).not.toContain('http');
    expect(out.text).toContain('observed items described');
  });

  it('contains no price or weight', () => {
    const out = buildImageObservationSemanticInput([observation()]);
    expect(out.text).not.toMatch(/price|cost|charge|kg|weight|tonne/i);
  });

  it('refuses observation input that carries a monetary token', () => {
    expect(() =>
      buildImageObservationSemanticInput([
        observation({ note: 'probably about £400 of furniture' }),
      ])
    ).toThrow(/monetary/i);
  });

  it('refuses an empty observation set', () => {
    expect(() => buildImageObservationSemanticInput([])).toThrow(
      VectorMemoryError
    );
  });

  it('records a low-quality flag from a live analysis result', () => {
    const records = imageObservationRecordsFromAnalysis({
      observations: [
        {
          observation_id: 'obs-1',
          kind: 'furniture',
          label: 'sofa',
          confidence: 0.9,
          basis: 'observed',
          approximate_count: { value: 1, confidence: 0.8 },
          volume_range: null,
          dismantling: 'unknown',
          heavy_handling: 'unknown',
          hazards: [],
          sources: [
            {
              ordinal: 1,
              source_message_id: 'msg-1',
              source_media_id: 'acct-1/inbound/a.jpg',
            },
          ],
          notes: null,
        },
      ],
      ambiguous_items: [],
      image_quality: [{ kind: 'blurred', detail: 'dark', sources: [] }],
      estimated_volume_range: null,
      need_more_photos: true,
      follow_up_questions: [],
      notes: [],
    });
    const text = buildImageObservationSemanticInput(records).text;
    expect(text).toContain('image quality: blurred');
    // Source refs are metadata, never embedded words.
    expect(text).not.toContain('msg-1');
    expect(text).not.toContain('a.jpg');
  });
});

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

describe('sha256Hex', () => {
  it('is a lowercase 64-character hex digest', () => {
    expect(sha256Hex('hello')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable and content-dependent', () => {
    expect(sha256Hex('hello')).toBe(sha256Hex('hello'));
    expect(sha256Hex('hello')).not.toBe(sha256Hex('hello '));
  });
});
