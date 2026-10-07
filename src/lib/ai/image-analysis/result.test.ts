import { describe, expect, it } from 'vitest';

import type { ImageSourceRef } from './analyzer';
import { IMAGE_ANALYSIS_LIMITS } from './limits';
import {
  ImageAnalysisValidationError,
  parseImageAnalysisResult,
  type ImageAnalysisResult,
} from './result';

const SOURCES: ImageSourceRef[] = [
  {
    ordinal: 1,
    source_message_id: 'message-1',
    source_media_id: 'account-1/inbound/photo-1.jpg',
  },
  {
    ordinal: 2,
    source_message_id: 'message-2',
    source_media_id: 'account-1/inbound/photo-2.jpg',
  },
];

function parse(value: unknown): ImageAnalysisResult {
  return parseImageAnalysisResult(value, SOURCES);
}

function expectInvalid(value: unknown, reason: string): void {
  try {
    parse(value);
  } catch (error) {
    expect(error).toBeInstanceOf(ImageAnalysisValidationError);
    expect((error as ImageAnalysisValidationError).reason).toBe(reason);
    return;
  }
  throw new Error('expected the provider result to be rejected');
}

describe('parseImageAnalysisResult', () => {
  it('accepts a single observed sofa with an approximate count', () => {
    const result = parse({
      observations: [
        {
          kind: 'furniture',
          label: 'three-seat sofa',
          confidence: 0.82,
          approximate_count: { value: 1, confidence: 0.9 },
          source_indexes: [1],
        },
      ],
      need_more_photos: false,
    });

    expect(result.observations).toHaveLength(1);
    const observation = result.observations[0]!;
    expect(observation.observation_id).toBe('obs-1');
    expect(observation.basis).toBe('observed');
    expect(observation.approximate_count).toEqual({
      value: 1,
      confidence: 0.9,
    });
    // Unstated indicators stay explicitly unknown rather than defaulting to
    // a negative claim.
    expect(observation.dismantling).toBe('unknown');
    expect(observation.heavy_handling).toBe('unknown');
    expect(observation.sources).toEqual([SOURCES[0]]);
  });

  it('keeps a mixed-waste clearance as separate typed observations', () => {
    const result = parse({
      observations: [
        {
          kind: 'furniture',
          label: 'armchair',
          confidence: 0.7,
          source_indexes: [1],
        },
        {
          kind: 'loose_mixed_waste',
          label: 'general household waste in bin bags',
          confidence: 0.6,
          approximate_count: { value: 4, confidence: 0.5 },
          source_indexes: [1],
        },
        {
          kind: 'garden_waste',
          label: 'cut hedge trimmings',
          confidence: 0.55,
          source_indexes: [2],
        },
      ],
      need_more_photos: true,
      follow_up_questions: ['Which room is the waste in?'],
    });

    expect(result.observations.map((o) => o.kind)).toEqual([
      'furniture',
      'loose_mixed_waste',
      'garden_waste',
    ]);
    expect(result.need_more_photos).toBe(true);
    expect(result.follow_up_questions).toEqual(['Which room is the waste in?']);
  });

  it('accepts bags and boxes with a relative volume range', () => {
    const result = parse({
      observations: [
        {
          kind: 'bags_or_boxes',
          label: 'sealed removal sacks',
          confidence: 0.75,
          approximate_count: { value: 6, confidence: 0.6 },
          volume_range: { min: 2, max: 4, confidence: 0.5 },
          source_indexes: [1],
        },
      ],
      estimated_volume_range: { min: 2, max: 5, confidence: 0.45 },
      need_more_photos: false,
    });

    expect(result.observations[0]!.volume_range).toEqual({
      unit: 'relative_volume_units',
      min: 2,
      max: 4,
      confidence: 0.5,
    });
    expect(result.estimated_volume_range?.unit).toBe('relative_volume_units');
  });

  it('records poor image quality as a first-class observation', () => {
    const result = parse({
      observations: [
        {
          kind: 'ambiguous_item',
          label: 'dark object on a low-resolution floor',
          confidence: 0.2,
          basis: 'ambiguous',
          source_indexes: [1],
        },
      ],
      image_quality: [
        { kind: 'too_dark', detail: 'room light is off', source_indexes: [1] },
        { kind: 'blurred', source_indexes: [2] },
      ],
      ambiguous_items: [
        {
          description: 'unidentified dark object',
          confidence: 0.2,
          source_indexes: [1],
        },
      ],
      need_more_photos: true,
    });

    expect(result.image_quality.map((q) => q.kind)).toEqual([
      'too_dark',
      'blurred',
    ]);
    expect(result.ambiguous_items[0]!.sources).toEqual([SOURCES[0]]);
    expect(result.observations[0]!.basis).toBe('ambiguous');
  });

  it('captures bulky and heavy handling indicators', () => {
    const result = parse({
      observations: [
        {
          kind: 'bulky_or_heavy',
          label: 'large wardrobe',
          confidence: 0.8,
          heavy_handling: 'indicated',
          dismantling: 'unknown',
          hazards: ['may be glass-fronted'],
          source_indexes: [1],
        },
      ],
      need_more_photos: false,
    });

    const observation = result.observations[0]!;
    expect(observation.heavy_handling).toBe('indicated');
    expect(observation.dismantling).toBe('unknown');
    expect(observation.hazards).toEqual(['may be glass-fronted']);
  });

  it('resolves multi-image sources to canonical message and media ids', () => {
    const result = parse({
      observations: [
        {
          kind: 'furniture',
          label: 'same sofa from a second angle',
          confidence: 0.6,
          source_indexes: [2, 1],
        },
      ],
      need_more_photos: false,
    });

    // Sources are sorted by ordinal and resolved from WACRM's own records;
    // a provider never names a message, path, or URL itself.
    expect(result.observations[0]!.sources).toEqual([SOURCES[0], SOURCES[1]]);
  });

  it('carries no price or weight field on the result', () => {
    const result = parse({
      observations: [
        {
          kind: 'furniture',
          label: 'sofa',
          confidence: 0.8,
          source_indexes: [1],
        },
      ],
      need_more_photos: false,
    });

    expect(JSON.stringify(result)).not.toMatch(/price|weight|cost|quote/i);
  });

  it('rejects a pricing or weight field from a provider', () => {
    expectInvalid(
      {
        observations: [
          {
            kind: 'furniture',
            label: 'sofa',
            confidence: 0.8,
            source_indexes: [1],
            estimated_price: 120,
          },
        ],
        need_more_photos: false,
      },
      'forbidden_field'
    );
    expectInvalid(
      {
        observations: [
          {
            kind: 'furniture',
            label: 'sofa',
            confidence: 0.8,
            source_indexes: [1],
            weightKg: 40,
          },
        ],
        need_more_photos: false,
      },
      'forbidden_field'
    );
  });

  it('rejects an unrecognised field rather than ignoring it', () => {
    expectInvalid(
      {
        observations: [
          {
            kind: 'furniture',
            label: 'sofa',
            confidence: 0.8,
            source_indexes: [1],
            colour: 'grey',
          },
        ],
        need_more_photos: false,
      },
      'invalid_shape'
    );
  });

  it('rejects an absolute volume unit', () => {
    expectInvalid(
      {
        observations: [
          {
            kind: 'furniture',
            label: 'sofa',
            confidence: 0.8,
            source_indexes: [1],
            volume_range: {
              unit: 'cubic_yards',
              min: 1,
              max: 2,
              confidence: 0.5,
            },
          },
        ],
        need_more_photos: false,
      },
      'invalid_shape'
    );
  });

  it('rejects a source index outside the analysed images', () => {
    expectInvalid(
      {
        observations: [
          {
            kind: 'furniture',
            label: 'sofa',
            confidence: 0.8,
            source_indexes: [3],
          },
        ],
        need_more_photos: false,
      },
      'out_of_range'
    );
    expectInvalid(
      {
        observations: [
          {
            kind: 'furniture',
            label: 'sofa',
            confidence: 0.8,
            source_indexes: [],
          },
        ],
        need_more_photos: false,
      },
      'invalid_shape'
    );
  });

  it('rejects out-of-range and malformed values', () => {
    expectInvalid(
      {
        observations: [
          {
            kind: 'furniture',
            label: 'sofa',
            confidence: 1.4,
            source_indexes: [1],
          },
        ],
        need_more_photos: false,
      },
      'out_of_range'
    );
    expectInvalid(
      {
        observations: [
          {
            kind: 'spaceship',
            label: 'sofa',
            confidence: 0.8,
            source_indexes: [1],
          },
        ],
        need_more_photos: false,
      },
      'invalid_shape'
    );
    expectInvalid(
      { observations: [], need_more_photos: 'yes' },
      'invalid_shape'
    );
    expectInvalid('not an object', 'invalid_shape');
    expectInvalid({ observations: [] }, 'invalid_shape');
  });

  it('rejects a result that exceeds a declared limit', () => {
    const observation = {
      kind: 'furniture',
      label: 'item',
      confidence: 0.5,
      source_indexes: [1],
    };
    expectInvalid(
      {
        observations: Array.from(
          { length: IMAGE_ANALYSIS_LIMITS.max_observations + 1 },
          () => observation
        ),
        need_more_photos: false,
      },
      'out_of_range'
    );
  });

  it('truncates bounded free text and drops nothing else', () => {
    const longLabel = 'x'.repeat(IMAGE_ANALYSIS_LIMITS.max_label_chars + 50);
    const result = parse({
      observations: [
        {
          kind: 'furniture',
          label: longLabel,
          confidence: 0.5,
          source_indexes: [1],
        },
      ],
      need_more_photos: false,
    });

    expect(result.observations[0]!.label).toHaveLength(
      IMAGE_ANALYSIS_LIMITS.max_label_chars
    );
  });
});
