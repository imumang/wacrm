/**
 * Objective 08 — the structured image-observation schema and its validator.
 *
 * An image analysis is a set of *observations*, not facts. Every numeric
 * value here is bounded by a confidence and every count is explicitly
 * approximate. The schema has no price, cost, or weight field, and the
 * validator rejects unknown keys, so a provider cannot smuggle one in
 * (see `FORBIDDEN_FIELD_WORDS`).
 *
 * Volume is expressed in `relative_volume_units` on purpose. A cubic-yard
 * or cubic-metre figure would be a conversion this layer is not allowed to
 * make: load-size definitions and disposal volumes are unresolved business
 * inputs (Objective 16), and the quote engine does not exist. The unit is
 * therefore an abstract scale that a future pricing rule, not a vision
 * model, gets to interpret.
 *
 * Validation is strict and total. A provider result that does not match
 * this shape exactly is rejected with `ImageAnalysisValidationError`, which
 * the tool surfaces as a structured error. Nothing is coerced, defaulted
 * into meaning, or silently dropped except bounded free text, which is
 * truncated at the limits declared in `limits.ts`.
 */

import { IMAGE_ANALYSIS_LIMITS, type ImageAnalysisLimits } from './limits';
import type { ImageSourceRef } from './analyzer';

/**
 * The version tag of THIS observation contract.
 *
 * It names the shape `parseImageAnalysisResult` accepts: the key
 * allowlists below, the tristate vocabulary, `relative_volume_units`,
 * and the rule that a pricing or weight key is rejected. Persisted
 * observations carry it, so a stored analysis can never masquerade as
 * an equivalent one produced under a different contract.
 *
 * Bump it when the accepted shape changes meaning. A wording change to
 * the vision prompt is a SEPARATE tag (`VISION_PROMPT_VERSION`), because
 * a prompt rewrite produces a different analysis at the same model even
 * though the contract is unchanged.
 */
export const IMAGE_ANALYSIS_SCHEMA_VERSION = 'image-observation-v1';

export const IMAGE_OBSERVATION_KINDS = [
  'furniture',
  'appliance',
  'bags_or_boxes',
  'loose_mixed_waste',
  'garden_waste',
  'construction_waste',
  'bulky_or_heavy',
  'ambiguous_item',
] as const;

export type ImageObservationKind = (typeof IMAGE_OBSERVATION_KINDS)[number];

export const INDICATOR_TRISTATE = [
  'indicated',
  'not_indicated',
  'unknown',
] as const;

/**
 * `unknown` is the honest default: absence of a visible signal is not
 * evidence of absence.
 */
export type IndicatorTristate = (typeof INDICATOR_TRISTATE)[number];

export const IMAGE_QUALITY_ISSUE_KINDS = [
  'blurred',
  'too_dark',
  'low_resolution',
  'obstructed',
  'partial_view',
  'unreadable',
] as const;

export type ImageQualityIssueKind = (typeof IMAGE_QUALITY_ISSUE_KINDS)[number];

/**
 * An abstract volume span. Not cubic yards, not kilograms, not a price
 * input on its own.
 */
export interface RelativeVolumeRange {
  unit: 'relative_volume_units';
  min: number;
  max: number;
  confidence: number;
}

export interface ApproximateCount {
  value: number;
  confidence: number;
}

export interface ImageObservation {
  /** Assigned here, never by the provider. Stable within one result. */
  observation_id: string;
  kind: ImageObservationKind;
  label: string;
  /** How much the visual evidence supports this observation, 0..1. */
  confidence: number;
  /**
   * `observed` only when the item is actually visible in a source image.
   * Anything uncertain must be `ambiguous` (or reported under
   * `ambiguous_items`), which is what stops a guess becoming a fact.
   */
  basis: 'observed' | 'ambiguous';
  approximate_count: ApproximateCount | null;
  volume_range: RelativeVolumeRange | null;
  dismantling: IndicatorTristate;
  heavy_handling: IndicatorTristate;
  hazards: readonly string[];
  sources: readonly ImageSourceRef[];
  notes: string | null;
}

export interface AmbiguousImageItem {
  description: string;
  confidence: number;
  sources: readonly ImageSourceRef[];
}

export interface ImageQualityObservation {
  kind: ImageQualityIssueKind;
  detail: string | null;
  sources: readonly ImageSourceRef[];
}

export interface ImageAnalysisResult {
  observations: readonly ImageObservation[];
  ambiguous_items: readonly AmbiguousImageItem[];
  image_quality: readonly ImageQualityObservation[];
  estimated_volume_range: RelativeVolumeRange | null;
  need_more_photos: boolean;
  follow_up_questions: readonly string[];
  notes: readonly string[];
}

/**
 * Which validated finding kind each top-level result list produces.
 *
 * The validator's own name for these lists is `observations`,
 * `ambiguous_items` and `image_quality`; the canonical persistence layer
 * calls all three "findings" because all three are validated findings
 * about photographs, and only one of them is an observation *about an
 * item*. The mapping lives here, beside the schemas it mirrors, so the
 * two vocabularies cannot drift apart in a consumer.
 *
 * `sources` is deliberately not part of any payload: source references
 * become their own canonical rows, because one observation may
 * legitimately reference several photographs and must be stored once
 * rather than duplicated per source. `observation_id` is likewise
 * excluded — it is a locally assigned label, and the persisted row has
 * its own identity.
 */
export const ANALYSIS_RESULT_BINDINGS = Object.freeze({
  observations: 'observation',
  ambiguous_items: 'ambiguous_item',
  image_quality: 'image_quality',
} as const);

/** The persisted kind a validated result list projects onto. */
export type AnalysisResultBinding =
  (typeof ANALYSIS_RESULT_BINDINGS)[keyof typeof ANALYSIS_RESULT_BINDINGS];

/**
 * Re-validate a persisted payload against THIS contract.
 *
 * The canonical store reuses the validated shape rather than inventing a
 * second schema, and this is what makes that claim enforceable: a stored
 * row is read back through `parseImageAnalysisResult`, not through a
 * looser reader. A payload that would not have been accepted here is
 * refused on the way out, so a row that could not have been written
 * cannot be read back.
 *
 * `images` supplies the canonical source refs, exactly as the validator
 * received them at analysis time: a persisted observation's `sources`
 * are the join rows, not embedded in the payload, so the ordinals are
 * resolved against the run's own image set by the caller.
 */
export function parsePersistedImageFinding(
  value: unknown,
  findingKind: AnalysisResultBinding,
  images: readonly ImageSourceRef[]
): ImageAnalysisResult {
  // A finding is re-validated as a single-element result of its own
  // kind. The other two lists stay empty, so an ambiguity can never be
  // read as an observation and vice versa.
  return parseImageAnalysisResult(
    {
      observations: [],
      ambiguous_items: [],
      image_quality: [],
      need_more_photos: true,
      [ANALYSIS_RESULT_LISTS[findingKind]]: [withSources(value, images)],
    },
    images
  );
}

const ANALYSIS_RESULT_LISTS: Readonly<Record<AnalysisResultBinding, string>> =
  Object.freeze({
    observation: 'observations',
    ambiguous_item: 'ambiguous_items',
    image_quality: 'image_quality',
  });

/**
 * Attach the run's own source refs to a stored payload for validation.
 *
 * The payload deliberately does not carry `sources` — they are canonical
 * rows — so the validator, which requires every finding to reference at
 * least one analysed image, would otherwise reject a correctly stored
 * observation. Passing the resolved refs here re-supplies exactly the
 * information the payload intentionally omits.
 */
function withSources(
  value: unknown,
  images: readonly ImageSourceRef[]
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ImageAnalysisValidationError(
      'invalid_shape',
      'a persisted image finding payload must be an object'
    );
  }
  const ordinals = new Set<number>();
  for (const image of images) {
    ordinals.add(image.ordinal);
  }
  if (ordinals.size === 0) {
    throw new ImageAnalysisValidationError(
      'invalid_shape',
      'a persisted image finding cannot be validated without its source images'
    );
  }
  return {
    ...(value as Record<string, unknown>),
    source_indexes: [...ordinals].sort((left, right) => left - right),
  };
}

/**
 * The payload persisted for ONE observation, ambiguity, or quality
 * entry.
 *
 * This is the existing validated contract, minus the two things that
 * are not provider output and do not belong in a stored observation:
 * the locally assigned `observation_id` (which becomes the row's own
 * identity) and `sources` (which become their own canonical rows, so
 * that one observation spanning several photographs is stored once
 * rather than duplicated).
 *
 * It is NOT a second schema. It is the same object the provider
 * produced, projected through `parseImageAnalysisResult`'s own output,
 * and it is re-validated on the way back out by
 * `parseImageAnalysisObservation` in the persistence layer.
 */
export interface PersistedImageObservationPayload {
  kind: ImageObservationKind;
  label: string;
  confidence: number;
  basis: 'observed' | 'ambiguous';
  approximate_count: ApproximateCount | null;
  volume_range: RelativeVolumeRange | null;
  dismantling: IndicatorTristate;
  heavy_handling: IndicatorTristate;
  hazards: readonly string[];
  notes: string | null;
}

export interface PersistedAmbiguousItemPayload {
  description: string;
  confidence: number;
}

export interface PersistedImageQualityPayload {
  kind: ImageQualityIssueKind;
  detail: string | null;
}

export class ImageAnalysisValidationError extends Error {
  readonly reason: 'invalid_shape' | 'forbidden_field' | 'out_of_range';

  constructor(reason: ImageAnalysisValidationError['reason'], message: string) {
    super(message);
    this.name = 'ImageAnalysisValidationError';
    this.reason = reason;
  }
}

/**
 * Words that must never appear in a provider observation key.
 *
 * The validator already rejects unknown keys, so this is belt-and-braces
 * with a better error: it names the actual problem (a provider tried to
 * return pricing or weight) instead of "unexpected field", which is the
 * distinction an operator or the future quote-engine author needs to see.
 */
const FORBIDDEN_FIELD_WORDS = new Set([
  'price',
  'prices',
  'pricing',
  'cost',
  'costs',
  'charge',
  'charges',
  'fee',
  'fees',
  'amount',
  'quote',
  'quotes',
  'weight',
  'weights',
  'kg',
  'kgs',
  'kilo',
  'kilos',
  'kilogram',
  'kilograms',
  'tonne',
  'tonnes',
  'ton',
  'tons',
  'pounds',
  'gbp',
  'currency',
]);

const OBSERVATION_KEYS = new Set([
  'kind',
  'label',
  'confidence',
  'basis',
  'approximate_count',
  'volume_range',
  'dismantling',
  'heavy_handling',
  'hazards',
  'source_indexes',
  'notes',
]);

const AMBIGUOUS_ITEM_KEYS = new Set([
  'description',
  'confidence',
  'source_indexes',
]);

const IMAGE_QUALITY_KEYS = new Set(['kind', 'detail', 'source_indexes']);

const RESULT_KEYS = new Set([
  'observations',
  'ambiguous_items',
  'image_quality',
  'estimated_volume_range',
  'need_more_photos',
  'follow_up_questions',
  'notes',
]);

type JsonObject = Record<string, unknown>;

/**
 * Validate an untyped provider result against the observation schema.
 *
 * `images` is the canonical, ordered source list the call analysed. A
 * provider addresses images by 1-based index into it, and every source
 * reference in the output is resolved here from WACRM's own records — a
 * provider cannot name a message, a path, or a URL.
 */
export function parseImageAnalysisResult(
  value: unknown,
  images: readonly ImageSourceRef[],
  limits: ImageAnalysisLimits = IMAGE_ANALYSIS_LIMITS
): ImageAnalysisResult {
  const root = requireObject(value, 'result');
  assertAllowedKeys(root, RESULT_KEYS, 'result');

  const rawObservations =
    optionalArray(root.observations, 'observations') ?? [];
  if (rawObservations.length > limits.max_observations) {
    fail(
      'out_of_range',
      `observations exceeds the limit of ${limits.max_observations}`
    );
  }

  const observations = rawObservations.map((entry, index) =>
    parseObservation(entry, index, images, limits)
  );

  const rawAmbiguous =
    optionalArray(root.ambiguous_items, 'ambiguous_items') ?? [];
  if (rawAmbiguous.length > limits.max_ambiguous_items) {
    fail(
      'out_of_range',
      `ambiguous_items exceeds the limit of ${limits.max_ambiguous_items}`
    );
  }
  const ambiguous_items = rawAmbiguous.map((entry, index) =>
    parseAmbiguousItem(entry, index, images, limits)
  );

  const rawQuality = optionalArray(root.image_quality, 'image_quality') ?? [];
  if (rawQuality.length > limits.max_image_quality_observations) {
    fail(
      'out_of_range',
      `image_quality exceeds the limit of ${limits.max_image_quality_observations}`
    );
  }
  const image_quality = rawQuality.map((entry, index) =>
    parseImageQuality(entry, index, images, limits)
  );

  const estimated_volume_range =
    root.estimated_volume_range === undefined ||
    root.estimated_volume_range === null
      ? null
      : parseVolumeRange(root.estimated_volume_range, 'estimated_volume_range');

  const need_more_photos = readBoolean(
    root.need_more_photos,
    'need_more_photos'
  );

  const follow_up_questions = readBoundedStrings(
    optionalArray(root.follow_up_questions, 'follow_up_questions') ?? [],
    'follow_up_questions',
    limits.max_follow_up_questions,
    limits.max_question_chars
  );

  const notes = readBoundedStrings(
    optionalArray(root.notes, 'notes') ?? [],
    'notes',
    limits.max_notes,
    limits.max_note_chars
  );

  return {
    observations,
    ambiguous_items,
    image_quality,
    estimated_volume_range,
    need_more_photos,
    follow_up_questions,
    notes,
  };
}

function parseObservation(
  value: unknown,
  index: number,
  images: readonly ImageSourceRef[],
  limits: ImageAnalysisLimits
): ImageObservation {
  const path = `observations[${index}]`;
  const entry = requireObject(value, path);
  assertAllowedKeys(entry, OBSERVATION_KEYS, path);

  const basis = entry.basis ?? 'observed';
  if (basis !== 'observed' && basis !== 'ambiguous') {
    fail('invalid_shape', `${path}.basis must be observed or ambiguous`);
  }

  return {
    observation_id: `obs-${index + 1}`,
    kind: readEnum(entry.kind, IMAGE_OBSERVATION_KINDS, `${path}.kind`),
    label: readBoundedString(
      entry.label,
      `${path}.label`,
      limits.max_label_chars
    ),
    confidence: readConfidence(entry.confidence, `${path}.confidence`),
    basis,
    approximate_count:
      entry.approximate_count === undefined || entry.approximate_count === null
        ? null
        : parseApproximateCount(
            entry.approximate_count,
            `${path}.approximate_count`
          ),
    volume_range:
      entry.volume_range === undefined || entry.volume_range === null
        ? null
        : parseVolumeRange(entry.volume_range, `${path}.volume_range`),
    dismantling: readTristate(entry.dismantling, `${path}.dismantling`),
    heavy_handling: readTristate(
      entry.heavy_handling,
      `${path}.heavy_handling`
    ),
    hazards: readBoundedStrings(
      optionalArray(entry.hazards, `${path}.hazards`) ?? [],
      `${path}.hazards`,
      limits.max_hazards_per_observation,
      limits.max_note_chars
    ),
    sources: resolveSources(
      entry.source_indexes,
      images,
      `${path}.source_indexes`,
      limits
    ),
    notes: readOptionalBoundedString(
      entry.notes,
      `${path}.notes`,
      limits.max_note_chars
    ),
  };
}

function parseAmbiguousItem(
  value: unknown,
  index: number,
  images: readonly ImageSourceRef[],
  limits: ImageAnalysisLimits
): AmbiguousImageItem {
  const path = `ambiguous_items[${index}]`;
  const entry = requireObject(value, path);
  assertAllowedKeys(entry, AMBIGUOUS_ITEM_KEYS, path);
  return {
    description: readBoundedString(
      entry.description,
      `${path}.description`,
      limits.max_label_chars
    ),
    confidence: readConfidence(entry.confidence, `${path}.confidence`),
    sources: resolveSources(
      entry.source_indexes,
      images,
      `${path}.source_indexes`,
      limits
    ),
  };
}

function parseImageQuality(
  value: unknown,
  index: number,
  images: readonly ImageSourceRef[],
  limits: ImageAnalysisLimits
): ImageQualityObservation {
  const path = `image_quality[${index}]`;
  const entry = requireObject(value, path);
  assertAllowedKeys(entry, IMAGE_QUALITY_KEYS, path);
  return {
    kind: readEnum(entry.kind, IMAGE_QUALITY_ISSUE_KINDS, `${path}.kind`),
    detail: readOptionalBoundedString(
      entry.detail,
      `${path}.detail`,
      limits.max_note_chars
    ),
    sources: resolveSources(
      entry.source_indexes,
      images,
      `${path}.source_indexes`,
      limits
    ),
  };
}

function parseApproximateCount(value: unknown, path: string): ApproximateCount {
  const entry = requireObject(value, path);
  assertAllowedKeys(entry, new Set(['value', 'confidence']), path);
  const count = entry.value;
  if (
    typeof count !== 'number' ||
    !Number.isInteger(count) ||
    count < 0 ||
    count > 1_000
  ) {
    fail('out_of_range', `${path}.value must be a whole number from 0 to 1000`);
  }
  return {
    value: count,
    confidence: readConfidence(entry.confidence, `${path}.confidence`),
  };
}

function parseVolumeRange(value: unknown, path: string): RelativeVolumeRange {
  const entry = requireObject(value, path);
  assertAllowedKeys(entry, new Set(['unit', 'min', 'max', 'confidence']), path);
  if (entry.unit !== undefined && entry.unit !== 'relative_volume_units') {
    fail(
      'invalid_shape',
      `${path}.unit must be relative_volume_units; absolute volume units are a business rule, not an observation`
    );
  }
  const min = readNonNegativeNumber(entry.min, `${path}.min`);
  const max = readNonNegativeNumber(entry.max, `${path}.max`);
  if (max < min) {
    fail('out_of_range', `${path}.max must not be lower than ${path}.min`);
  }
  return {
    unit: 'relative_volume_units',
    min,
    max,
    confidence: readConfidence(entry.confidence, `${path}.confidence`),
  };
}

function resolveSources(
  value: unknown,
  images: readonly ImageSourceRef[],
  path: string,
  limits: ImageAnalysisLimits
): ImageSourceRef[] {
  const entries = optionalArray(value, path);
  if (!entries || entries.length === 0) {
    fail('invalid_shape', `${path} must reference at least one analysed image`);
  }
  if (entries.length > limits.max_sources_per_observation) {
    fail(
      'out_of_range',
      `${path} exceeds the limit of ${limits.max_sources_per_observation}`
    );
  }
  const ordinals = new Set<number>();
  for (const entry of entries) {
    if (typeof entry !== 'number' || !Number.isInteger(entry)) {
      fail('invalid_shape', `${path} must contain whole image ordinals`);
    }
    if (entry < 1 || entry > images.length) {
      fail(
        'out_of_range',
        `${path} references an image that was not part of this analysis`
      );
    }
    ordinals.add(entry);
  }
  return [...ordinals]
    .sort((left, right) => left - right)
    .map((ordinal) => images[ordinal - 1] as ImageSourceRef);
}

function requireObject(value: unknown, path: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('invalid_shape', `${path} must be an object`);
  }
  return value as JsonObject;
}

function assertAllowedKeys(
  entry: JsonObject,
  allowed: ReadonlySet<string>,
  path: string
): void {
  for (const key of Object.keys(entry)) {
    const words = keyWords(key);
    if (words.some((word) => FORBIDDEN_FIELD_WORDS.has(word))) {
      fail(
        'forbidden_field',
        `${path}.${key} is not allowed: image analysis never reports pricing or weight`
      );
    }
    if (!allowed.has(key)) {
      fail('invalid_shape', `${path}.${key} is not a recognised field`);
    }
  }
}

function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}

function optionalArray(value: unknown, path: string): unknown[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) {
    fail('invalid_shape', `${path} must be an array`);
  }
  return value;
}

function readEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string
): T {
  if (
    typeof value !== 'string' ||
    !(allowed as readonly string[]).includes(value)
  ) {
    fail('invalid_shape', `${path} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function readTristate(value: unknown, path: string): IndicatorTristate {
  if (value === undefined || value === null) return 'unknown';
  return readEnum(value, INDICATOR_TRISTATE, path);
}

function readBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    fail('invalid_shape', `${path} must be true or false`);
  }
  return value;
}

function readConfidence(value: unknown, path: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    fail('out_of_range', `${path} must be a number from 0 to 1`);
  }
  return value;
}

function readNonNegativeNumber(value: unknown, path: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1_000_000
  ) {
    fail('out_of_range', `${path} must be a number from 0 to 1000000`);
  }
  return value;
}

function readBoundedString(
  value: unknown,
  path: string,
  maxChars: number
): string {
  if (typeof value !== 'string' || value.trim() === '') {
    fail('invalid_shape', `${path} must be a non-empty string`);
  }
  return value.trim().slice(0, maxChars);
}

function readOptionalBoundedString(
  value: unknown,
  path: string,
  maxChars: number
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    fail('invalid_shape', `${path} must be a string`);
  }
  return value.trim().slice(0, maxChars);
}

function readBoundedStrings(
  values: readonly unknown[],
  path: string,
  maxItems: number,
  maxChars: number
): string[] {
  if (values.length > maxItems) {
    fail('out_of_range', `${path} exceeds the limit of ${maxItems}`);
  }
  return values.map((value, index) =>
    readBoundedString(value, `${path}[${index}]`, maxChars)
  );
}

function fail(
  reason: ImageAnalysisValidationError['reason'],
  message: string
): never {
  throw new ImageAnalysisValidationError(reason, message);
}
