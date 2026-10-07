/**
 * Domain tests for the canonical image-observation projection.
 *
 * The projection is the place a validated `analyze_images` output becomes
 * durable, so these tests assert what it must NOT change. A projection
 * that quietly dropped a field, renamed a kind, or absorbed an ordinal
 * into the payload would make every persisted observation a slightly
 * different claim from the one the tool made — which is exactly the drift
 * a training dataset must not have.
 */

import { describe, expect, it } from 'vitest';

import {
  IMAGE_ANALYSIS_SCHEMA_VERSION,
  VISION_PROMPT_VERSION,
  type AnalyzerImage,
} from '@/lib/ai/image-analysis';

import {
  ImageObservationError,
  buildImageAnalysisResultHash,
  buildImageAnalysisSourceFingerprint,
  imageAnalysisFailureReason,
  imageAnalysisFailureStatus,
  projectCanonicalImageAnalysis,
  type ImageAnalysisMediaCandidate,
} from './model';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = 'aaaaaaaa-1111-4111-8111-111111111111';
const MEDIA = (name: string) => `account-${ACCOUNT}/inbound/${name}`;

function candidate(
  messageId: string,
  name: string,
  createdAt = '2026-05-01T10:00:00.000Z'
): ImageAnalysisMediaCandidate {
  return {
    message_id: messageId,
    created_at: createdAt,
    sender_type: 'customer',
    content_type: 'image',
    media_url: `https://project.supabase.co/storage/v1/object/public/chat-media/${MEDIA(
      name
    )}`,
    media_type: 'image/jpeg',
  };
}

function analyzerImage(
  ordinal: number,
  messageId: string,
  name: string,
  byteLength = 2048
): AnalyzerImage {
  return {
    source: {
      ordinal,
      source_message_id: messageId,
      source_media_id: MEDIA(name),
    },
    mime_type: 'image/jpeg',
    byte_length: byteLength,
    bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
  };
}

const SOFA = {
  observation_id: 'obs-1',
  kind: 'furniture' as const,
  label: 'three-seat sofa',
  confidence: 0.82,
  basis: 'observed' as const,
  approximate_count: { value: 1, confidence: 0.9 },
  volume_range: null,
  dismantling: 'indicated' as const,
  heavy_handling: 'unknown' as const,
  hazards: [],
  sources: [{ ordinal: 1, source_message_id: 'm1', source_media_id: MEDIA('a.jpg') }],
  notes: null,
};

function project(overrides: Partial<Parameters<typeof projectCanonicalImageAnalysis>[0]> = {}) {
  const base = {
    conversation_id: CONVERSATION,
    analyzer_id: 'configured_vision_model',
    provider: 'openai',
    model: 'gpt-5.4-mini',
    analysis_schema_version: IMAGE_ANALYSIS_SCHEMA_VERSION,
    prompt_version: VISION_PROMPT_VERSION,
    images: [analyzerImage(1, 'm1', 'a.jpg')],
    candidates: [candidate('m1', 'a.jpg')],
    result: {
      observations: [SOFA],
      ambiguous_items: [],
      image_quality: [],
      estimated_volume_range: null,
      need_more_photos: false,
      follow_up_questions: [],
      notes: [],
    },
  };
  return projectCanonicalImageAnalysis({ ...base, ...overrides });
}

describe('projectCanonicalImageAnalysis', () => {
  it('reuses the validated observation contract unchanged', () => {
    const analysis = project();
    const finding = analysis.findings[0];

    expect(finding?.finding_kind).toBe('observation');
    // The payload is the validated observation with exactly two fields
    // removed: the locally assigned `observation_id` (which becomes the
    // row's own `finding_ref` and database identity) and `sources` (which
    // become canonical join rows).
    expect(finding?.payload).toEqual({
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
    });
    expect(Object.keys(finding?.payload ?? {})).not.toContain('observation_id');
    expect(Object.keys(finding?.payload ?? {})).not.toContain('sources');
  });

  it('keeps the three finding kinds distinct rather than collapsing them', () => {
    const analysis = project({
      images: [analyzerImage(1, 'm1', 'a.jpg')],
      candidates: [candidate('m1', 'a.jpg')],
      result: {
        observations: [SOFA],
        ambiguous_items: [
          {
            description: 'an unidentifiable white object',
            confidence: 0.3,
            sources: [{ ordinal: 1, source_message_id: 'm1', source_media_id: MEDIA('a.jpg') }],
          },
        ],
        image_quality: [
          {
            kind: 'too_dark' as const,
            detail: 'flash glare',
            sources: [{ ordinal: 1, source_message_id: 'm1', source_media_id: MEDIA('a.jpg') }],
          },
        ],
        estimated_volume_range: null,
        need_more_photos: true,
        follow_up_questions: ['What is the white object?'],
        notes: [],
      },
    });

    expect(analysis.findings.map((finding) => finding.finding_kind)).toEqual([
      'observation',
      'ambiguous_item',
      'image_quality',
    ]);

    const ambiguity = analysis.findings[1];
    // An ambiguity has no `kind` and no `basis`: it is not an observation
    // about an item, and letting it carry one would let "we could not
    // tell" read as "we saw this".
    expect(ambiguity?.kind).toBeNull();
    expect(ambiguity?.basis).toBeNull();
    expect(ambiguity?.payload).toEqual({
      description: 'an unidentifiable white object',
      confidence: 0.3,
    });

    const quality = analysis.findings[2];
    // Quality reports a problem with a photograph, so it has no label and
    // no confidence — those belong to observations about items.
    expect(quality?.label).toBeNull();
    expect(quality?.confidence).toBeNull();
    expect(quality?.payload).toEqual({ kind: 'too_dark', detail: 'flash glare' });

    // Distinct identity prefixes, so a quality report can never collide
    // with an observation's `obs-1`.
    expect(analysis.findings.map((finding) => finding.finding_ref)).toEqual([
      'obs-1',
      'ambiguous-1',
      'quality-1',
    ]);
  });

  it('stores an observation with several sources once, not once per source', () => {
    const analysis = project({
      images: [
        analyzerImage(1, 'm1', 'a.jpg'),
        analyzerImage(2, 'm2', 'b.jpg'),
        analyzerImage(3, 'm3', 'c.jpg'),
      ],
      candidates: [
        candidate('m1', 'a.jpg'),
        candidate('m2', 'b.jpg'),
        candidate('m3', 'c.jpg'),
      ],
      result: {
        observations: [
          {
            ...SOFA,
            // "The same sofa appears in photos 1 and 3" — one observation
            // referencing two photographs.
            sources: [
              { ordinal: 1, source_message_id: 'm1', source_media_id: MEDIA('a.jpg') },
              { ordinal: 3, source_message_id: 'm3', source_media_id: MEDIA('c.jpg') },
            ],
          },
        ],
        ambiguous_items: [],
        image_quality: [],
        estimated_volume_range: null,
        need_more_photos: false,
        follow_up_questions: [],
        notes: [],
      },
    });

    expect(analysis.findings).toHaveLength(1);
    expect(analysis.findings[0]?.source_ordinals).toEqual([1, 3]);
  });

  it('de-duplicates repeated source ordinals', () => {
    const analysis = project({
      result: {
        observations: [
          {
            ...SOFA,
            sources: [
              { ordinal: 1, source_message_id: 'm1', source_media_id: MEDIA('a.jpg') },
              { ordinal: 1, source_message_id: 'm1', source_media_id: MEDIA('a.jpg') },
            ],
          },
        ],
        ambiguous_items: [],
        image_quality: [],
        estimated_volume_range: null,
        need_more_photos: false,
        follow_up_questions: [],
        notes: [],
      },
    });
    expect(analysis.findings[0]?.source_ordinals).toEqual([1]);
  });

  it('refuses an observation that references a photograph not in the analysis', () => {
    expect(() =>
      project({
        result: {
          observations: [
            {
              ...SOFA,
              sources: [
                { ordinal: 1, source_message_id: 'm1', source_media_id: MEDIA('a.jpg') },
                { ordinal: 4, source_message_id: 'm4', source_media_id: MEDIA('d.jpg') },
              ],
            },
          ],
          ambiguous_items: [],
          image_quality: [],
          estimated_volume_range: null,
          need_more_photos: false,
          follow_up_questions: [],
          notes: [],
        },
      })
    ).toThrow(/was not part of this analysis/);
  });

  it('refuses an observation with no source image at all', () => {
    expect(() =>
      project({
        result: {
          observations: [{ ...SOFA, sources: [] }],
          ambiguous_items: [],
          image_quality: [],
          estimated_volume_range: null,
          need_more_photos: false,
          follow_up_questions: [],
          notes: [],
        },
      })
    ).toThrow(/cannot be recorded/);
  });

  it('carries no price and no exact weight anywhere in the record', () => {
    const analysis = project({
      result: {
        observations: [SOFA],
        ambiguous_items: [],
        image_quality: [],
        // A relative span, which the validator accepts. An absolute unit
        // would have been rejected before this projection ever ran.
        estimated_volume_range: {
          unit: 'relative_volume_units' as const,
          min: 1,
          max: 2,
          confidence: 0.6,
        },
        need_more_photos: false,
        follow_up_questions: [],
        notes: [],
      },
    });
    const serialised = JSON.stringify(analysis);
    for (const forbidden of [
      'price',
      'cost',
      'charge',
      'amount',
      'quote',
      'weight',
      'kg',
      'kg)',
      'tonne',
      '£',
      'gbp',
      'currency',
    ]) {
      expect(serialised.toLowerCase()).not.toContain(forbidden);
    }
    expect(
      (analysis.findings[0]?.payload as { volume_range: unknown }).volume_range
    ).toBeNull();
  });

  it('reads direction and timestamp from the canonical message, not the caller', () => {
    const analysis = project({
      images: [analyzerImage(1, 'm1', 'a.jpg')],
      candidates: [
        {
          ...candidate('m1', 'a.jpg', '2026-06-02T09:30:00.000Z'),
          sender_type: 'agent',
        },
      ],
    });
    expect(analysis.images[0]?.direction).toBe('outbound');
    expect(analysis.images[0]?.message_created_at).toBe('2026-06-02T09:30:00.000Z');
  });

  it('refuses a source image that did not come from a canonical message', () => {
    expect(() => project({ candidates: [] })).toThrow(
      /did not come from a canonical message/
    );
  });

  it('refuses an analysis with no images', () => {
    expect(() =>
      project({ images: [], candidates: [], result: {
        observations: [], ambiguous_items: [], image_quality: [],
        estimated_volume_range: null, need_more_photos: true,
        follow_up_questions: [], notes: [],
      } })
    ).toThrow(/resolved no source images/);
  });
});

describe('fingerprints', () => {
  it('is deterministic for the same request and the same result', () => {
    const first = project();
    const second = project();
    expect(first.fingerprint.source_fingerprint).toBe(
      second.fingerprint.source_fingerprint
    );
    expect(first.fingerprint.result_content_hash).toBe(
      second.fingerprint.result_content_hash
    );
  });

  it('changes when the model changes, so a re-analysis is representable', () => {
    const base = project();
    const other = project({ model: 'claude-haiku-4-5-20251001' });
    expect(other.fingerprint.source_fingerprint).not.toBe(
      base.fingerprint.source_fingerprint
    );
  });

  it('changes when the observation schema or prompt version changes', () => {
    const base = project();
    expect(
      project({ analysis_schema_version: 'image-observation-v2' }).fingerprint
        .source_fingerprint
    ).not.toBe(base.fingerprint.source_fingerprint);
    expect(
      project({ prompt_version: 'vision-prompt-v2' }).fingerprint
        .source_fingerprint
    ).not.toBe(base.fingerprint.source_fingerprint);
  });

  it('changes when the analysed media set changes', () => {
    const one = project();
    const two = project({
      images: [analyzerImage(1, 'm1', 'a.jpg'), analyzerImage(2, 'm2', 'b.jpg')],
      candidates: [candidate('m1', 'a.jpg'), candidate('m2', 'b.jpg')],
      result: {
        observations: [{ ...SOFA, sources: [
          { ordinal: 1, source_message_id: 'm1', source_media_id: MEDIA('a.jpg') },
          { ordinal: 2, source_message_id: 'm2', source_media_id: MEDIA('b.jpg') },
        ] }],
        ambiguous_items: [], image_quality: [],
        estimated_volume_range: null, need_more_photos: false,
        follow_up_questions: [], notes: [],
      },
    });
    expect(two.fingerprint.source_fingerprint).not.toBe(
      one.fingerprint.source_fingerprint
    );
  });

  it('does not treat two visually similar photographs as duplicates', () => {
    // The same content arriving in a different message is a different
    // source photograph as far as WACRM is concerned: it has no
    // perceptual comparison, and inventing one would need a business
    // decision about item identity.
    const first = project();
    const forwarded = project({
      images: [analyzerImage(1, 'm9', 'a.jpg')],
      candidates: [candidate('m9', 'a.jpg')],
      result: {
        observations: [{ ...SOFA, sources: [
          { ordinal: 1, source_message_id: 'm9', source_media_id: MEDIA('a.jpg') },
        ] }],
        ambiguous_items: [], image_quality: [],
        estimated_volume_range: null, need_more_photos: false,
        follow_up_questions: [], notes: [],
      },
    });
    expect(forwarded.fingerprint.source_fingerprint).not.toBe(
      first.fingerprint.source_fingerprint
    );
  });

  it('changes the result hash when the observations change but the media does not', () => {
    const base = project();
    const different = project({
      result: {
        observations: [{ ...SOFA, confidence: 0.4 }],
        ambiguous_items: [], image_quality: [],
        estimated_volume_range: null, need_more_photos: false,
        follow_up_questions: [], notes: [],
      },
    });
    expect(different.fingerprint.source_fingerprint).toBe(
      base.fingerprint.source_fingerprint
    );
    expect(different.fingerprint.result_content_hash).not.toBe(
      base.fingerprint.result_content_hash
    );
  });

  it('produces a lowercase sha-256 for both fingerprints', () => {
    const analysis = project();
    for (const hash of [
      analysis.fingerprint.source_fingerprint,
      analysis.fingerprint.result_content_hash,
    ]) {
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('orders the fingerprint material deterministically regardless of input order', () => {
    const ordered = buildImageAnalysisSourceFingerprint(
      project({
        images: [
          analyzerImage(1, 'm1', 'a.jpg'),
          analyzerImage(2, 'm2', 'b.jpg'),
        ],
        candidates: [candidate('m1', 'a.jpg'), candidate('m2', 'b.jpg')],
        result: {
          observations: [{ ...SOFA, sources: [
            { ordinal: 1, source_message_id: 'm1', source_media_id: MEDIA('a.jpg') },
            { ordinal: 2, source_message_id: 'm2', source_media_id: MEDIA('b.jpg') },
          ] }],
          ambiguous_items: [], image_quality: [],
          estimated_volume_range: null, need_more_photos: false,
          follow_up_questions: [], notes: [],
        },
      })
    );
    const shuffled = buildImageAnalysisSourceFingerprint(
      project({
        images: [
          analyzerImage(2, 'm2', 'b.jpg'),
          analyzerImage(1, 'm1', 'a.jpg'),
        ],
        candidates: [candidate('m2', 'b.jpg'), candidate('m1', 'a.jpg')],
        result: {
          observations: [{ ...SOFA, sources: [
            { ordinal: 1, source_message_id: 'm1', source_media_id: MEDIA('a.jpg') },
            { ordinal: 2, source_message_id: 'm2', source_media_id: MEDIA('b.jpg') },
          ] }],
          ambiguous_items: [], image_quality: [],
          estimated_volume_range: null, need_more_photos: false,
          follow_up_questions: [], notes: [],
        },
      })
    );
    expect(shuffled).toBe(ordered);
  });

  it('exposes the hash builders for direct use', () => {
    const analysis = project();
    expect(buildImageAnalysisSourceFingerprint(analysis)).toBe(
      analysis.fingerprint.source_fingerprint
    );
    expect(buildImageAnalysisResultHash(analysis)).toBe(
      analysis.fingerprint.result_content_hash
    );
  });
});

describe('failure classification', () => {
  it('maps every tool failure into the closed vocabulary', () => {
    const reasons = [
      imageAnalysisFailureReason({ code: 'cancelled' }),
      imageAnalysisFailureReason({ code: 'unavailable', message: 'Image analysis timed out' }),
      imageAnalysisFailureReason({ code: 'unavailable', message: 'Image analysis provider failed' }),
      imageAnalysisFailureReason({ code: 'internal' }),
      imageAnalysisFailureReason({ code: 'unknown_code' }),
    ];
    expect(new Set(reasons).size).toBeGreaterThanOrEqual(4);
    for (const reason of reasons) {
      expect(reason).toMatch(/^[a-z_]+$/);
    }
  });

  it('keeps the provider message out of the reason', () => {
    const reason = imageAnalysisFailureReason({
      code: 'unavailable',
      message: 'OpenAI error 400: image too large, key sk-abc123 refused for account 42',
    });
    expect(reason).toBe('provider_error');
    expect(reason).not.toContain('sk-');
    expect(reason).not.toContain('OpenAI');
  });

  it('gives each failure reason its matching run status', () => {
    expect(imageAnalysisFailureStatus('provider_timeout')).toBe('timed_out');
    expect(imageAnalysisFailureStatus('caller_cancelled')).toBe('cancelled');
    expect(imageAnalysisFailureStatus('invalid_provider_result')).toBe(
      'validation_failed'
    );
    expect(imageAnalysisFailureStatus('account_not_configured')).toBe(
      'provider_unavailable'
    );
    expect(imageAnalysisFailureStatus('provider_error')).toBe(
      'provider_unavailable'
    );
  });
});

describe('input hygiene', () => {
  it('rejects an empty analyzer id rather than storing one', () => {
    expect(() => project({ analyzer_id: '   ' })).toThrow(ImageObservationError);
  });

  it('rejects a model longer than the schema bound', () => {
    expect(() => project({ model: 'x'.repeat(500) })).toThrow(
      /at most 200 characters/
    );
  });

  it('trims and accepts a correlation id, and rejects an over-long one', () => {
    expect(project({ correlation_id: '  run-1  ' }).correlation_id).toBe('run-1');
    expect(() => project({ correlation_id: 'x'.repeat(400) })).toThrow(
      /at most 200 characters/
    );
  });
});