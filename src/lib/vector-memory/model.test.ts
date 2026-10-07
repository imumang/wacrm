import { describe, expect, it } from 'vitest';

import {
  GENERATABLE_VECTOR_EMBEDDING_KINDS,
  MONETARY_CASE_FACT_KEYS,
  NATIVE_IMAGE_EMBEDDING_SUPPORT,
  VECTOR_EMBEDDING_DIMENSIONS,
  VECTOR_EMBEDDING_KINDS,
  VECTOR_EMBEDDING_MODEL,
  VECTOR_EMBEDDING_MODEL_VERSION,
  VECTOR_EMBEDDING_STATES,
  VECTOR_MEMORY_BATCH_MAX_LIMIT,
  VECTOR_MEMORY_MIN_SEMANTIC_SIGNALS,
  VectorMemoryError,
  assertNoMonetaryLeakage,
  boundedBatchLimit,
  evaluateVectorMemoryEligibility,
  isGeneratableVectorEmbeddingKind,
  isMonetaryCaseFactKey,
  isVectorEmbeddingKind,
  parseCaseEmbedding,
} from './model';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'emb-1',
    account_id: 'acct-1',
    historical_case_id: 'case-1',
    embedding_kind: 'case_text',
    source_entity: 'historical_case',
    source_reference: null,
    semantic_input_version: 'case-text-v1',
    content_hash: 'a'.repeat(64),
    provider: 'openai',
    embedding_model: VECTOR_EMBEDDING_MODEL,
    model_version: VECTOR_EMBEDDING_MODEL_VERSION,
    dimensions: VECTOR_EMBEDDING_DIMENSIONS,
    state: 'current',
    superseded_by: null,
    created_at: '2026-01-01T00:00:00Z',
    refreshed_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

describe('vector memory vocabularies', () => {
  it('keeps the three modalities as three distinct kinds', () => {
    expect(VECTOR_EMBEDDING_KINDS).toEqual([
      'case_text',
      'image_observation_text',
      'native_image',
    ]);
  });

  it('treats image-observation text as NOT a native image embedding', () => {
    expect(GENERATABLE_VECTOR_EMBEDDING_KINDS).toContain(
      'image_observation_text'
    );
    // The single most important invariant of this objective: nothing can
    // currently produce a real visual vector.
    expect(GENERATABLE_VECTOR_EMBEDDING_KINDS).not.toContain('native_image');
    expect(isGeneratableVectorEmbeddingKind('native_image')).toBe(false);
    expect(isGeneratableVectorEmbeddingKind('image_observation_text')).toBe(
      true
    );
    // Both remain *registered* kinds, so the store can hold a real
    // visual vector if a provider ever supports one.
    expect(isVectorEmbeddingKind('native_image')).toBe(true);
  });

  it('records native image embeddings as explicitly unsupported', () => {
    expect(NATIVE_IMAGE_EMBEDDING_SUPPORT.supported).toBe(false);
    expect(NATIVE_IMAGE_EMBEDDING_SUPPORT.reason).toMatch(/native image/i);
    expect(NATIVE_IMAGE_EMBEDDING_SUPPORT.reason).toMatch(
      /image_observation_text/
    );
  });

  it('exposes a distinct state per lifecycle reason', () => {
    expect(VECTOR_EMBEDDING_STATES).toEqual([
      'current',
      'stale',
      'superseded',
      'withheld',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Price leakage
// ---------------------------------------------------------------------------

describe('assertNoMonetaryLeakage', () => {
  it.each([
    'job items: sofa; £450 worth',
    'job items: sofa, 450 GBP',
    'estimated volume: USD 300',
    'the customer was charged 300',
    'customer rejected the price',
    'the customer accepted our quote',
    'they paid 250 and we invoiced 275',
    'this job cost us too much',
    'the invoice total was 900',
    'total charge: 120',
  ])('refuses monetary or commercial text: %s', (text) => {
    expect(() => assertNoMonetaryLeakage(text, 'a test input')).toThrow(
      VectorMemoryError
    );
  });

  it.each([
    'job items: three seater sofa; armchair',
    'job floor: third floor; no lift available',
    'job actual load units: 2',
    'job carry distance metres: 40',
    'job access constraints: narrow staircase; rear entry only',
    'observed piano safe - upright, needs heavy handling',
  ])('accepts operational text: %s', (text) => {
    expect(() => assertNoMonetaryLeakage(text, 'a test input')).not.toThrow();
  });

  it('names the offending token so the operator can fix the source', () => {
    try {
      assertNoMonetaryLeakage('sofa, charged 300', 'the job description');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(VectorMemoryError);
      expect((error as VectorMemoryError).code).toBe('invalid_input');
      expect((error as Error).message).toContain('charged');
    }
  });

  it('lists the monetary fact keys that must never be read', () => {
    for (const key of [
      'ai_suggested_amount',
      'human_approved_amount',
      'customer_facing_quote_amount',
      'final_amount_collected',
      'quote_adjustment_amount',
      'quote_decision',
      'quote_adjustment_reason',
    ]) {
      expect(isMonetaryCaseFactKey(key)).toBe(true);
      expect(MONETARY_CASE_FACT_KEYS).toContain(
        key as (typeof MONETARY_CASE_FACT_KEYS)[number]
      );
    }
    expect(isMonetaryCaseFactKey('actual_load_units')).toBe(false);
    expect(isMonetaryCaseFactKey('service_type')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

describe('evaluateVectorMemoryEligibility', () => {
  const base = {
    learning_eligibility: 'pending' as const,
    case_state: 'open' as const,
    evidence_quality_tier: null,
  };

  it('rejects an excluded case regardless of its evidence tier', () => {
    const decision = evaluateVectorMemoryEligibility(
      { ...base, learning_eligibility: 'excluded', evidence_quality_tier: 'A' },
      9
    );
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe('excluded_by_operator');
  });

  it('does not require an evidence tier to store semantic memory', () => {
    // Deliberate: a tier describes evidence STRENGTH, not whether a
    // vector is worth having. Requiring tier A would mean only
    // completed jobs with a collected amount could ever be recalled.
    const decision = evaluateVectorMemoryEligibility(base, 4);
    expect(decision.eligible).toBe(true);
    expect(decision.reason).toBe('eligible');
  });

  it('does not require finalization to store semantic memory', () => {
    const open = evaluateVectorMemoryEligibility(base, 4);
    expect(open.eligible).toBe(true);
  });

  it('rejects a case with too little operational description', () => {
    const decision = evaluateVectorMemoryEligibility(
      base,
      VECTOR_MEMORY_MIN_SEMANTIC_SIGNALS - 1
    );
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe('insufficient_semantic_content');
    expect(decision.reasons.join(' ')).toMatch(/at least 2/);
  });

  it('accepts exactly the minimum signal count', () => {
    expect(
      evaluateVectorMemoryEligibility(
        base,
        VECTOR_MEMORY_MIN_SEMANTIC_SIGNALS
      ).eligible
    ).toBe(true);
  });

  it('never changes the tier or the eligibility it evaluated', () => {
    // The policy is a pure function. Generating an embedding must not be
    // able to upgrade a case, and this is where that is enforced in the
    // domain.
    const input = { ...base, evidence_quality_tier: null };
    const before = JSON.stringify(input);
    evaluateVectorMemoryEligibility(input, 5);
    expect(JSON.stringify(input)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Model / version compatibility
// ---------------------------------------------------------------------------

describe('parseCaseEmbedding', () => {
  it('accepts a row from the registered compatibility group', () => {
    const parsed = parseCaseEmbedding(row());
    expect(parsed.dimensions).toBe(1536);
    expect(parsed.model_version).toBe(VECTOR_EMBEDDING_MODEL_VERSION);
  });

  it('rejects a vector from an unregistered model', () => {
    expect(() =>
      parseCaseEmbedding(row({ embedding_model: 'text-embedding-3-large' }))
    ).toThrow(/unregistered model/i);
  });

  it('rejects a vector whose dimensions do not match its model', () => {
    expect(() => parseCaseEmbedding(row({ dimensions: 3072 }))).toThrow(
      /unregistered model/i
    );
  });

  it('rejects a model_version from a different compatibility group', () => {
    expect(() =>
      parseCaseEmbedding(row({ model_version: 'text-embedding-3-small-v2' }))
    ).toThrow(/unregistered model/i);
  });

  it('rejects a non-registered provider', () => {
    expect(() => parseCaseEmbedding(row({ provider: 'anthropic' }))).toThrow(
      /unregistered model/i
    );
  });

  it('rejects a content hash that is not a sha-256 hex digest', () => {
    expect(() => parseCaseEmbedding(row({ content_hash: 'NOTAHASH' }))).toThrow(
      /content_hash/i
    );
    expect(() =>
      parseCaseEmbedding(row({ content_hash: 'A'.repeat(64) }))
    ).toThrow(/content_hash/i);
  });

  it('rejects an unknown embedding kind', () => {
    expect(() =>
      parseCaseEmbedding(row({ embedding_kind: 'image_embedding' }))
    ).toThrow(/embedding_kind/i);
  });

  it('rejects an unknown state', () => {
    expect(() => parseCaseEmbedding(row({ state: 'archived' }))).toThrow(
      /state/i
    );
  });

  it('accepts a withheld row so it can be reported, not silently dropped', () => {
    expect(parseCaseEmbedding(row({ state: 'withheld' })).state).toBe('withheld');
  });
});

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

describe('boundedBatchLimit', () => {
  it('defaults when absent', () => {
    expect(boundedBatchLimit()).toBeGreaterThan(0);
  });

  it('clamps to the maximum', () => {
    expect(boundedBatchLimit(10_000)).toBe(VECTOR_MEMORY_BATCH_MAX_LIMIT);
  });

  it('refuses zero and negatives', () => {
    expect(() => boundedBatchLimit(0)).toThrow(VectorMemoryError);
    expect(() => boundedBatchLimit(-1)).toThrow(VectorMemoryError);
  });

  it('refuses a fractional limit', () => {
    expect(() => boundedBatchLimit(2.5)).toThrow(/whole number/i);
  });
});
