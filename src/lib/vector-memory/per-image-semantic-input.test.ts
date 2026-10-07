/**
 * Per-image observation semantic-input tests.
 *
 * The per-image builder is the most tempting place in this codebase to
 * leak metadata: a per-image record has an ordinal, a message id and a
 * storage object path sitting right next to it, and every one of them
 * would be easy to serialise "just for traceability".
 *
 * These tests exist because each of those would be a real defect:
 *
 *   - an ordinal or message id in the TEXT makes the embedding a function
 *     of which message happened to carry the photograph, so the same
 *     picture forwarded twice would not match itself;
 *   - a storage object path is a needless identifier in a semantic
 *     vector, and it would poison the content hash the moment the
 *     uploader's naming changed;
 *   - price or weight in the text would rank comparables by price, which
 *     is the feedback loop `assertNoMonetaryLeakage` exists to prevent;
 *   - and labelling any of this `native_image` would claim visual-vector
 *     provenance WACRM does not have.
 */

import { describe, expect, it } from 'vitest';

import type {
  ImageAnalysisAggregate,
  ValidatedPersistedImageFinding,
} from '@/lib/image-observations/model';
import { validatePersistedFindings } from '@/lib/image-observations/model';
import {
  NATIVE_IMAGE_EMBEDDING_SUPPORT,
  VECTOR_EMBEDDING_KINDS,
  VectorMemoryError,
} from './model';
import type { ImageObservationRecord } from './semantic-input';
import {
  PER_IMAGE_OBSERVATION_TEXT_SEMANTIC_INPUT_VERSION,
  buildPerImageObservationSemanticInput,
  perImageSemanticSources,
} from './per-image-semantic-input';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const MEDIA = (name: string) => `account-${ACCOUNT}/inbound/${name}`;

const SOFA: ImageObservationRecord = {
  category: 'three-seat sofa',
  count: 1,
  uncertainty: 'observed',
  volume_min: null,
  volume_max: null,
  dismantling: 'indicated',
  heavy: 'unknown',
  note: null,
};

function source(ordinal: number, name: string) {
  return {
    ordinal,
    source_media_id: MEDIA(name),
    source_message_id: `m${ordinal}`,
  };
}

describe('buildPerImageObservationSemanticInput', () => {
  it('is deterministic for the same observations', () => {
    const args = { source: source(1, 'a.jpg'), records: [SOFA] };
    const first = buildPerImageObservationSemanticInput(args);
    const second = buildPerImageObservationSemanticInput(args);

    expect(first.text).toBe(second.text);
    expect(first.content_hash).toBe(second.content_hash);
    expect(first.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.semantic_input_version).toBe(
      PER_IMAGE_OBSERVATION_TEXT_SEMANTIC_INPUT_VERSION
    );
  });

  it('describes the observation and nothing else', () => {
    const semantic = buildPerImageObservationSemanticInput({
      source: source(1, 'a.jpg'),
      records: [SOFA],
    });
    expect(semantic.text).toBe(
      'observed three-seat sofa about 1 needs dismantling'
    );
  });

  it('produces a different vector for different observations of the same image', () => {
    const base = buildPerImageObservationSemanticInput({
      source: source(1, 'a.jpg'),
      records: [SOFA],
    });
    const other = buildPerImageObservationSemanticInput({
      source: source(1, 'a.jpg'),
      records: [{ ...SOFA, category: 'garden waste' }],
    });
    expect(other.content_hash).not.toBe(base.content_hash);
  });

  it('keeps ambiguity separate from a confident observation', () => {
    const semantic = buildPerImageObservationSemanticInput({
      source: source(1, 'a.jpg'),
      records: [
        SOFA,
        {
          category: 'an unidentifiable white object',
          count: null,
          uncertainty: 'ambiguous',
          volume_min: null,
          volume_max: null,
          dismantling: 'unknown',
          heavy: 'unknown',
          note: null,
        },
      ],
    });
    // "We think there may be a fridge" must never be flattened into the
    // confident set just by being serialised next to it.
    expect(semantic.text).toContain('uncertain');
    expect(semantic.text.split('\n')).toHaveLength(2);
  });

  it('records low-quality imagery as its own observation', () => {
    // "these photos were dark" is exactly the signal objective 04 needs in
    // order not to trust a visual match derived from them.
    const semantic = buildPerImageObservationSemanticInput({
      source: source(1, 'a.jpg'),
      records: [
        {
          category: 'image quality: too_dark',
          count: null,
          uncertainty: 'observed',
          volume_min: null,
          volume_max: null,
          dismantling: 'unknown',
          heavy: 'unknown',
          note: 'flash glare',
        },
      ],
    });
    expect(semantic.text).toContain('image quality: too_dark');
  });

  it('never emits a storage path, a URL or a message id into the text', () => {
    const semantic = buildPerImageObservationSemanticInput({
      source: source(3, 'customer-photo.jpg'),
      records: [SOFA],
    });
    const text = semantic.text;

    expect(text).not.toContain('account-');
    expect(text).not.toContain('inbound');
    expect(text).not.toContain('storage');
    expect(text).not.toContain('chat-media');
    expect(text).not.toContain('https');
    expect(text).not.toContain('.jpg');
    expect(text).not.toContain('m1');
    expect(text).not.toContain('m3');
    // Not the ordinal either: the photograph's position in a set is an
    // artifact of the call, not a property of what it shows.
    expect(text).not.toContain('3');
  });

  it('keeps the source reference on the returned shape, not in the text', () => {
    const semantic = buildPerImageObservationSemanticInput({
      source: source(2, 'a.jpg'),
      records: [SOFA],
    });
    // The stable reference and the ordinal are row metadata, available to
    // whoever stores a vector, and absent from the words.
    expect(semantic.source_reference).toBe(MEDIA('a.jpg'));
    expect(semantic.ordinal).toBe(2);
    expect(semantic.text).not.toContain(MEDIA('a.jpg'));
  });

  it('refuses to embed a monetary token', () => {
    expect(() =>
      buildPerImageObservationSemanticInput({
        source: source(1, 'a.jpg'),
        records: [{ ...SOFA, note: 'customer rejected the price of 450' }],
      })
    ).toThrow(VectorMemoryError);
  });

  it('refuses to embed a currency symbol', () => {
    expect(() =>
      buildPerImageObservationSemanticInput({
        source: source(1, 'a.jpg'),
        records: [{ ...SOFA, note: '£450 for the sofa' }],
      })
    ).toThrow(/monetary or commercial token/);
  });

  it('refuses an empty description rather than emitting a placeholder', () => {
    // A placeholder matches everything, which is worse than no vector.
    expect(() =>
      buildPerImageObservationSemanticInput({
        source: source(1, 'a.jpg'),
        records: [],
      })
    ).toThrow(/no validated observations of this photograph/);
  });

  it('is image_observation_text and never native_image', () => {
    const semantic = buildPerImageObservationSemanticInput({
      source: source(1, 'a.jpg'),
      records: [SOFA],
    });
    expect(semantic.kind).toBe('image_observation_text');
    expect(semantic.kind).not.toBe('native_image');

    // And the vocabulary still keeps the three kinds apart, with
    // `native_image` registered but unsupported.
    expect(VECTOR_EMBEDDING_KINDS).toContain('image_observation_text');
    expect(VECTOR_EMBEDDING_KINDS).toContain('native_image');
    expect(NATIVE_IMAGE_EMBEDDING_SUPPORT.supported).toBe(false);
  });

  it('uses a semantic input version distinct from the case-level builder', () => {
    // Two representations of the same evidence must not be mixed into one
    // another's neighbourhood, so they carry different version tags.
    expect(PER_IMAGE_OBSERVATION_TEXT_SEMANTIC_INPUT_VERSION).toBe(
      'per-image-observation-text-v1'
    );
    expect(PER_IMAGE_OBSERVATION_TEXT_SEMANTIC_INPUT_VERSION).not.toBe(
      'image-observation-text-v1'
    );
  });
});

// ---------------------------------------------------------------------------
// Projection from a canonical aggregate
// ---------------------------------------------------------------------------

function finding(
  overrides: Partial<ValidatedPersistedImageFinding> &
    Pick<ValidatedPersistedImageFinding, 'finding' | 'source_ordinals'>
): ValidatedPersistedImageFinding {
  return {
    observation_id: 'obs-1',
    finding_kind: 'observation',
    ordinal_in_result: 1,
    ...overrides,
  };
}

function aggregate(
  images: Array<{ ordinal: number; name: string; messageId: string }>
): ImageAnalysisAggregate {
  return {
    run: {
      id: 'run-1',
      account_id: ACCOUNT,
      conversation_id: 'conv-1',
      enquiry_id: null,
      historical_case_id: null,
      analyzer_id: 'configured_vision_model',
      provider: 'openai',
      model: 'gpt-5.4-mini',
      analysis_schema_version: 'image-observation-v1',
      prompt_version: 'vision-prompt-v1',
      status: 'succeeded',
      failure_reason: null,
      image_count: images.length,
      correlation_id: null,
      source_fingerprint: null,
      result_content_hash: null,
      state: 'current',
      superseded_by: null,
      started_at: '2026-05-01T10:00:00.000Z',
      completed_at: null,
      created_at: '2026-05-01T10:00:00.000Z',
    },
    images: images.map((image) => ({
      id: `img-${image.ordinal}`,
      account_id: ACCOUNT,
      run_id: 'run-1',
      ordinal: image.ordinal,
      source_message_id: image.messageId,
      source_media_id: MEDIA(image.name),
      mime_type: 'image/jpeg',
      byte_length: 2048,
      direction: 'inbound' as const,
      message_created_at: '2026-05-01T10:00:00.000Z',
      created_at: '2026-05-01T10:00:00.000Z',
    })),
    observations: [],
    sources: [],
  };
}

describe('perImageSemanticSources', () => {
  it('represents one source image independently', () => {
    const record = aggregate([{ ordinal: 1, name: 'a.jpg', messageId: 'm1' }]);
    const sources = perImageSemanticSources(record, [
      finding({
        finding: {
          observation_id: 'obs-1',
          kind: 'furniture',
          label: 'three-seat sofa',
          confidence: 0.82,
          basis: 'observed',
          approximate_count: { value: 1, confidence: 0.9 },
          volume_range: null,
          dismantling: 'indicated',
          heavy_handling: 'unknown',
          hazards: [],
          sources: [],
          notes: null,
        } as ValidatedPersistedImageFinding['finding'],
        source_ordinals: [1],
      }),
    ]);

    expect(sources).toHaveLength(1);
    expect(sources[0]?.source).toEqual({
      ordinal: 1,
      source_media_id: MEDIA('a.jpg'),
      source_message_id: 'm1',
    });
  });

  it('gives a multi-source observation to every photograph it came from', () => {
    const record = aggregate([
      { ordinal: 1, name: 'a.jpg', messageId: 'm1' },
      { ordinal: 2, name: 'b.jpg', messageId: 'm2' },
    ]);
    const sofa = {
      observation_id: 'obs-1',
      kind: 'furniture',
      label: 'three-seat sofa',
      confidence: 0.82,
      basis: 'observed',
      approximate_count: { value: 1, confidence: 0.9 },
      volume_range: null,
      dismantling: 'indicated',
      heavy_handling: 'unknown',
      hazards: [],
      sources: [],
      notes: null,
    } as ValidatedPersistedImageFinding['finding'];

    const sources = perImageSemanticSources(record, [
      finding({ finding: sofa, source_ordinals: [1, 2] }),
    ]);

    // "The same sofa appears in photos 1 and 2": both photographs carry
    // the observation, and it is STORED once.
    expect(sources.map((entry) => entry.source.ordinal)).toEqual([1, 2]);
    expect(sources[0]?.records).toEqual(sources[1]?.records);
    expect(sources[0]?.source.source_media_id).toBe(MEDIA('a.jpg'));
    expect(sources[1]?.source.source_media_id).toBe(MEDIA('b.jpg'));
  });

  it('omits a photograph with no observations rather than emitting an empty one', () => {
    const record = aggregate([
      { ordinal: 1, name: 'a.jpg', messageId: 'm1' },
      { ordinal: 2, name: 'b.jpg', messageId: 'm2' },
    ]);
    const sources = perImageSemanticSources(record, [
      finding({
        finding: {
          observation_id: 'obs-1',
          kind: 'furniture',
          label: 'three-seat sofa',
          confidence: 0.82,
          basis: 'observed',
          approximate_count: null,
          volume_range: null,
          dismantling: 'unknown',
          heavy_handling: 'unknown',
          hazards: [],
          sources: [],
          notes: null,
        } as ValidatedPersistedImageFinding['finding'],
        source_ordinals: [1],
      }),
    ]);
    expect(sources.map((entry) => entry.source.ordinal)).toEqual([1]);
  });

  it('returns each image in ordinal order', () => {
    const record = aggregate([
      { ordinal: 2, name: 'b.jpg', messageId: 'm2' },
      { ordinal: 1, name: 'a.jpg', messageId: 'm1' },
    ]);
    const sources = perImageSemanticSources(record, [
      finding({
        finding: {
          observation_id: 'obs-1',
          kind: 'furniture',
          label: 'sofa',
          confidence: 0.9,
          basis: 'observed',
          approximate_count: null,
          volume_range: null,
          dismantling: 'unknown',
          heavy_handling: 'unknown',
          hazards: [],
          sources: [],
          notes: null,
        } as ValidatedPersistedImageFinding['finding'],
        source_ordinals: [1, 2],
      }),
    ]);
    expect(sources.map((entry) => entry.source.ordinal)).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
// Re-validation through the original contract
// ---------------------------------------------------------------------------

describe('validatePersistedFindings', () => {
  const images = new Map([
    [
      1,
      {
        ordinal: 1,
        source_message_id: 'm1',
        source_media_id: MEDIA('a.jpg'),
        mime_type: 'image/jpeg',
        byte_length: 2048,
        direction: 'inbound' as const,
        message_created_at: '2026-05-01T10:00:00.000Z',
      },
    ],
  ]);

  it('returns a validated observation with its sources resolved', () => {
    const validated = validatePersistedFindings(
      [
        {
          id: 'obs-row-1',
          account_id: ACCOUNT,
          run_id: 'run-1',
          finding_kind: 'observation',
          ordinal_in_result: 1,
          finding_ref: 'obs-1',
          kind: 'furniture',
          label: 'three-seat sofa',
          confidence: 0.82,
          basis: 'observed',
          detail: null,
          payload: {
            kind: 'furniture',
            label: 'three-seat sofa',
            confidence: 0.82,
            basis: 'observed',
            approximate_count: { value: 1, confidence: 0.9 },
            volume_range: null,
            dismantling: 'indicated',
            heavy_handling: 'unknown',
            hazards: [],
            notes: null,
          },
          created_at: '2026-05-01T10:00:00.000Z',
        },
      ],
      new Map([['obs-row-1', [1]]]),
      images
    );

    expect(validated).toHaveLength(1);
    const value = validated[0]?.finding as unknown as {
      label: string;
      sources: unknown[];
    };
    expect(value.label).toBe('three-seat sofa');
    // The sources come from the canonical join rows, not the payload.
    expect(value.sources).toHaveLength(1);
  });

  it('refuses a stored payload the original validator would have rejected', () => {
    // Defence in depth: a row that could not have been written cannot be
    // read back. An unknown key is rejected exactly as it would be at
    // analysis time.
    expect(() =>
      validatePersistedFindings(
        [
          {
            id: 'obs-row-1',
            account_id: ACCOUNT,
            run_id: 'run-1',
            finding_kind: 'observation',
            ordinal_in_result: 1,
            finding_ref: 'obs-1',
            kind: 'furniture',
            label: 'sofa',
            confidence: 0.8,
            basis: 'observed',
            detail: null,
            payload: {
              kind: 'furniture',
              label: 'sofa',
              confidence: 0.8,
              basis: 'observed',
              approximate_count: null,
              volume_range: null,
              dismantling: 'unknown',
              heavy_handling: 'unknown',
              hazards: [],
              notes: null,
              something_unrecognised: true,
            },
            created_at: '2026-05-01T10:00:00.000Z',
          },
        ],
        new Map([['obs-row-1', [1]]]),
        images
      )
    ).toThrow();
  });

  it('skips an observation whose surviving sources cannot be resolved', () => {
    // It cannot happen while the links are intact, and the alternative -
    // inventing an ordinal to satisfy the validator - would manufacture
    // provenance that was never observed.
    const validated = validatePersistedFindings(
      [
        {
          id: 'obs-row-1',
          account_id: ACCOUNT,
          run_id: 'run-1',
          finding_kind: 'observation',
          ordinal_in_result: 1,
          finding_ref: 'obs-1',
          kind: 'furniture',
          label: 'sofa',
          confidence: 0.8,
          basis: 'observed',
          detail: null,
          payload: {
            kind: 'furniture',
            label: 'sofa',
            confidence: 0.8,
            basis: 'observed',
            approximate_count: null,
            volume_range: null,
            dismantling: 'unknown',
            heavy_handling: 'unknown',
            hazards: [],
            notes: null,
          },
          created_at: '2026-05-01T10:00:00.000Z',
        },
      ],
        new Map([['obs-row-1', [7]]]),
        images
    );
    expect(validated).toEqual([]);
  });

  it('skips an observation with no surviving source at all', () => {
    expect(
      validatePersistedFindings(
        [
          {
            id: 'obs-row-1',
            account_id: ACCOUNT,
            run_id: 'run-1',
            finding_kind: 'observation',
            ordinal_in_result: 1,
            finding_ref: 'obs-1',
            kind: null,
            label: null,
            confidence: null,
            basis: null,
            detail: null,
            payload: {},
            created_at: '2026-05-01T10:00:00.000Z',
          },
        ],
        new Map(),
        images
      )
    ).toEqual([]);
  });
});