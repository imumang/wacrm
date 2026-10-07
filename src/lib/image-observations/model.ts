/**
 * The canonical image-observation model.
 *
 * `analyze_images` returns validated observations to its caller and
 * stores nothing, because it is a read tool (`access: 'read'`,
 * `side_effects: 'none'`) and turning a read into a writer would break
 * the contract the whole tool layer is built on. What was missing was
 * the canonical place those observations belong, so a historical case
 * with several materially different photographs could not be
 * represented and re-analysing a photograph was indistinguishable from
 * analysing it for the first time.
 *
 * This module is that place. Four rules shaped it:
 *
 *  1. **The validated contract is reused, not reinvented.** A
 *     persisted payload is the object `parseImageAnalysisResult`
 *     produced, projected through `ANALYSIS_RESULT_BINDINGS` so every
 *     stored row declares which result key it came from. The two
 *     things that are NOT provider output — a locally assigned
 *     `observation_id` and the `sources` array — become the row's own
 *     identity and its own source rows. Nothing here adds a field,
 *     renames one, or widens the vocabulary.
 *
 *  2. **An observation is stored once, whatever it references.** A
 *     provider may legitimately say "the same sofa appears in photos 1
 *     and 3". Duplicating the observation per source would inflate
 *     every count downstream, so sources are a separate set of rows
 *     and one observation with three sources is one observation.
 *
 *  3. **Identity is content, not identity.** The fingerprint is a
 *     hash over the analysed media's canonical identities, and the
 *     result hash is a hash over what was observed. Two visually
 *     similar photographs are never treated as duplicates: WACRM has
 *     no perceptual comparison here and inventing one would need a
 *     business decision about what counts as "the same item".
 *
 *  4. **A row that could not have been written cannot be read back.**
 *     Every parser here is strict and total, mirroring
 *     `parseImageAnalysisResult` and `parseCaseEmbedding`. A
 *     half-defaulted observation in the domain layer would be worse
 *     than an error, because downstream retrieval would believe it.
 *
 * Pure module: no database client, no provider, no credentials.
 */

import { createHash } from 'node:crypto';

import type {
  AnalyzerImage,
  AmbiguousImageItem,
  ImageObservation,
  ImageObservationKind,
  ImageQualityIssueKind,
  ImageQualityObservation,
  IndicatorTristate,
} from '@/lib/ai/image-analysis';
import {
  parsePersistedImageFinding,
  type AnalysisResultBinding,
  type ImageSourceRef,
} from '@/lib/ai/image-analysis';

/**
 * The three kinds of validated finding, kept distinct.
 *
 * The distinction is the point, not a detail. "A three-seat sofa" and
 * "an unidentifiable object" and "this photo is too dark" answer
 * different questions, and collapsing them would let an ambiguity read
 * as an observation — which is exactly how a guess becomes a fact in a
 * learning dataset.
 */
export const IMAGE_ANALYSIS_FINDING_KINDS = [
  'observation',
  'ambiguous_item',
  'image_quality',
] as const;

export type ImageAnalysisFindingKind =
  (typeof IMAGE_ANALYSIS_FINDING_KINDS)[number];

/**
 * Why an analysis exists, and what a non-successful one was.
 *
 * A failure is recorded for observability, never as evidence: it
 * carries a closed-vocabulary reason and no result hash, and the
 * database refuses an observation under any status but `succeeded`.
 */
export const IMAGE_ANALYSIS_RUN_STATUSES = [
  'succeeded',
  'provider_unavailable',
  'timed_out',
  'cancelled',
  'validation_failed',
] as const;

export type ImageAnalysisRunStatus =
  (typeof IMAGE_ANALYSIS_RUN_STATUSES)[number];

/**
 * Safe, closed-vocabulary failure reasons.
 *
 * Deliberately not free text: a provider error message can echo
 * request content, and this row is durable. The mapping from the tool's
 * error codes to these tokens is `imageAnalysisFailureReason` below, so
 * the translation is one reviewable function rather than a convention.
 */
export const IMAGE_ANALYSIS_FAILURE_REASONS = [
  'account_not_configured',
  'provider_error',
  'provider_timeout',
  'caller_cancelled',
  'invalid_provider_result',
] as const;

export type ImageAnalysisFailureReason =
  (typeof IMAGE_ANALYSIS_FAILURE_REASONS)[number];

/**
 * Lifecycle, mirroring `case_embeddings.state` (migration 053).
 *
 * `withheld` is not `deleted`: an operator who excludes a case by
 * mistake can undo it by including the case again, rather than by
 * re-running a paid vision call. Deletion happens only through the
 * source/case/conversation/account cascade.
 */
export const IMAGE_ANALYSIS_RUN_STATES = [
  'current',
  'superseded',
  'withheld',
] as const;

export type ImageAnalysisRunState =
  (typeof IMAGE_ANALYSIS_RUN_STATES)[number];

/** Bounds mirroring the CHECK constraints in migration 054. */
export const IMAGE_OBSERVATION_MAX_LABEL_CHARS = 120;
export const IMAGE_OBSERVATION_MAX_DETAIL_CHARS = 400;
export const IMAGE_OBSERVATION_MAX_REF_CHARS = 64;
export const IMAGE_ANALYSIS_MAX_MEDIA_REF_CHARS = 200;
export const IMAGE_ANALYSIS_MAX_VERSION_CHARS = 64;
export const IMAGE_ANALYSIS_MAX_MODEL_CHARS = 200;
export const IMAGE_ANALYSIS_MAX_CORRELATION_CHARS = 200;
export const IMAGE_ANALYSIS_MAX_PAYLOAD_BYTES = 8_192;

/** A SHA-256 content hash, lowercase hex. */
export const IMAGE_ANALYSIS_HASH_PATTERN = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ImageObservationErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'forbidden'
  | 'conflict'
  | 'unavailable'
  | 'database_error';

/**
 * One error type for this domain.
 *
 * `not_found` and `forbidden` are deliberately hard to tell apart at
 * the call site on purpose: an unknown conversation and another
 * account's conversation produce the same answer, so this cannot be
 * used to probe a tenant.
 */
export class ImageObservationError extends Error {
  readonly code: ImageObservationErrorCode;

  constructor(code: ImageObservationErrorCode, message: string) {
    super(message);
    this.name = 'ImageObservationError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * The canonical, account-scoped storage object path for one analysed
 * photograph.
 *
 * Not a URL and not a credential: `chat-media` is a public bucket and
 * WACRM never produces a signed URL, so the object path is what an
 * operator needs to find the attachment again. It is metadata only —
 * nothing in an embedding input may ever contain it, because a path is
 * both a needless identifier and a value that would poison a content
 * hash if it ever changed.
 */
export interface ImageAnalysisSourceImage {
  /** 1-based position in the analysed set, as the provider saw it. */
  ordinal: number;
  source_message_id: string;
  source_media_id: string;
  mime_type: string;
  byte_length: number;
  direction: 'inbound' | 'outbound';
  /** The source message's own timestamp. */
  message_created_at: string;
}

/** A validated finding, ready to be persisted. */
export interface PersistedImageFinding {
  finding_kind: ImageAnalysisFindingKind;
  /** Position within its own kind in the validated result. */
  ordinal_in_result: number;
  /** Stable within a run: `obs-1`, `ambiguous-1`, `quality-1`. */
  finding_ref: string;
  kind: ImageObservationKind | ImageQualityIssueKind | null;
  label: string | null;
  confidence: number | null;
  basis: 'observed' | 'ambiguous' | null;
  detail: string | null;
  /**
   * The validated fields, unchanged. Held as a value rather than
   * re-derived, so what is persisted is provably what the validator
   * accepted.
   */
  payload:
    | PersistedImageObservationPayload
    | PersistedAmbiguousItemPayload
    | PersistedImageQualityPayload;
  /** 1-based ordinals of the images this finding came from. */
  source_ordinals: number[];
}

export interface PersistedImageObservationPayload {
  kind: ImageObservationKind;
  label: string;
  confidence: number;
  basis: 'observed' | 'ambiguous';
  approximate_count: { value: number; confidence: number } | null;
  volume_range: {
    unit: 'relative_volume_units';
    min: number;
    max: number;
    confidence: number;
  } | null;
  dismantling: IndicatorTristate;
  heavy_handling: IndicatorTristate;
  hazards: string[];
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

/**
 * One validated analyzer invocation, fully projected for persistence.
 *
 * Everything here is derived from the validated result plus WACRM's own
 * records. There is no field a provider could fill in freely.
 */
export interface CanonicalImageAnalysis {
  conversation_id: string;
  enquiry_id: string | null;
  historical_case_id: string | null;
  analyzer_id: string;
  provider: string;
  model: string;
  analysis_schema_version: string;
  prompt_version: string;
  correlation_id: string | null;
  images: ImageAnalysisSourceImage[];
  findings: PersistedImageFinding[];
  need_more_photos: boolean;
  follow_up_questions: string[];
  notes: string[];
  /** Run-scoped lifecycle facts, computed by this module. */
  fingerprint: {
    source_fingerprint: string;
    result_content_hash: string;
  };
}

/** A persisted run row. */
export interface ImageAnalysisRun {
  id: string;
  account_id: string;
  conversation_id: string;
  enquiry_id: string | null;
  historical_case_id: string | null;
  analyzer_id: string;
  provider: string;
  model: string;
  analysis_schema_version: string;
  prompt_version: string;
  status: ImageAnalysisRunStatus;
  failure_reason: ImageAnalysisFailureReason | null;
  image_count: number;
  correlation_id: string | null;
  source_fingerprint: string | null;
  result_content_hash: string | null;
  state: ImageAnalysisRunState;
  superseded_by: string | null;
  started_at: string;
  completed_at: string | null;
  created_at: string;
}

/** A persisted per-image record. */
export interface ImageAnalysisRunImage {
  id: string;
  account_id: string;
  run_id: string;
  ordinal: number;
  source_message_id: string;
  source_media_id: string;
  mime_type: string;
  byte_length: number;
  direction: 'inbound' | 'outbound';
  message_created_at: string;
  created_at: string;
}

/** A persisted observation row. */
export interface ImageAnalysisObservation {
  id: string;
  account_id: string;
  run_id: string;
  finding_kind: ImageAnalysisFindingKind;
  ordinal_in_result: number;
  finding_ref: string;
  kind: string | null;
  label: string | null;
  confidence: number | null;
  basis: string | null;
  detail: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

/**
 * A stored observation re-validated through the ORIGINAL contract.
 *
 * This is the payoff of storing `payload` unchanged rather than
 * re-modelling it: the value has been through
 * `parseImageAnalysisResult`, so a consumer receives exactly the
 * `ImageObservation` / `AmbiguousImageItem` / `ImageQualityObservation`
 * the tool produced. A pricing field could not have been written, and a
 * volume unit other than `relative_volume_units` could not have been
 * stored.
 */
export interface ValidatedPersistedImageFinding {
  observation_id: string;
  finding_kind: ImageAnalysisFindingKind;
  ordinal_in_result: number;
  /** The validated finding, with its `sources` resolved from the join rows. */
  finding:
    | ImageObservation
    | AmbiguousImageItem
    | ImageQualityObservation;
  /** Ordinals of the source images this finding came from. */
  source_ordinals: number[];
}

/** One (observation, source image) link. */
export interface ImageAnalysisObservationSource {
  id: string;
  account_id: string;
  observation_id: string;
  run_image_id: string;
  source_ordinal: number;
}

/**
 * A run and everything under it, as the domain reads it.
 *
 * Grouped rather than returned as four arrays because the useful
 * questions are relational: which observations came from photograph
 * three, and which photographs is this case's learning memory derived
 * from.
 */
export interface ImageAnalysisAggregate {
  run: ImageAnalysisRun;
  images: ImageAnalysisRunImage[];
  observations: ImageAnalysisObservation[];
  /** Source links, resolved onto the images they name. */
  sources: Array<ImageAnalysisObservationSource & { source_media_id: string }>;
}

// ---------------------------------------------------------------------------
// Projection: validated result -> persistable plan
// ---------------------------------------------------------------------------

/**
 * Turn a validated `AnalyzeImagesOutput` into the canonical projection.
 *
 * This is the ONLY place a tool output becomes a storable record, and it
 * is a projection rather than a re-interpretation: every payload below
 * is the object `parseImageAnalysisResult` produced, carried across
 * unchanged. Two fields are deliberately dropped:
 *
 *   - `observation_id`, because it is a locally assigned label and the
 *     row's own identity is its `id`;
 *   - `sources`, because each `ImageSourceRef` becomes its own
 *     `image_analysis_observation_sources` row. That is what keeps one
 *     observation spanning three photographs as one observation.
 *
 * `guarantees`, `limits`, `context_window`, `freshness` and
 * `uncertainty` are dropped as well: they describe the CALL, not the
 * analysis, and `ai_tool_call_audit` already owns the call's metadata.
 */
export function projectCanonicalImageAnalysis(
  input: ProjectCanonicalImageAnalysisArgs
): CanonicalImageAnalysis {
  const images = normaliseImages(input.images, input.candidates);
  if (images.length === 0) {
    throw new ImageObservationError(
      'invalid_input',
      'There is nothing to record: this analysis resolved no source images.'
    );
  }
  const byOrdinal = new Map(images.map((image) => [image.ordinal, image]));

  const findings: PersistedImageFinding[] = [
    ...input.result.observations.map((observation, index) =>
      projectObservation(observation, index, byOrdinal)
    ),
    ...input.result.ambiguous_items.map((item, index) =>
      projectAmbiguousItem(item, index, byOrdinal)
    ),
    ...input.result.image_quality.map((entry, index) =>
      projectImageQuality(entry, index, byOrdinal)
    ),
  ];

  const analysis: CanonicalImageAnalysis = {
    conversation_id: input.conversation_id,
    enquiry_id: input.enquiry_id ?? null,
    historical_case_id: input.historical_case_id ?? null,
    analyzer_id: requireBounded(input.analyzer_id, 'analyzer_id', 64),
    provider: requireBounded(input.provider, 'provider', 64),
    model: requireBounded(input.model, 'model', IMAGE_ANALYSIS_MAX_MODEL_CHARS),
    analysis_schema_version: requireBounded(
      input.analysis_schema_version,
      'analysis_schema_version',
      IMAGE_ANALYSIS_MAX_VERSION_CHARS
    ),
    prompt_version: requireBounded(
      input.prompt_version,
      'prompt_version',
      IMAGE_ANALYSIS_MAX_VERSION_CHARS
    ),
    correlation_id:
      input.correlation_id === null || input.correlation_id === undefined
        ? null
        : requireBounded(
            input.correlation_id,
            'correlation_id',
            IMAGE_ANALYSIS_MAX_CORRELATION_CHARS
          ),
    images,
    findings,
    need_more_photos: input.result.need_more_photos,
    follow_up_questions: [...input.result.follow_up_questions],
    notes: [...input.result.notes],
    fingerprint: {
      source_fingerprint: '',
      result_content_hash: '',
    },
  };

  analysis.fingerprint = {
    source_fingerprint: buildImageAnalysisSourceFingerprint(analysis),
    result_content_hash: buildImageAnalysisResultHash(analysis),
  };
  return analysis;
}

export interface ProjectCanonicalImageAnalysisArgs {
  conversation_id: string;
  enquiry_id?: string | null;
  historical_case_id?: string | null;
  analyzer_id: string;
  /** The account's configured provider. Version metadata, not a secret. */
  provider: string;
  /** The account's configured model. Version metadata, not a secret. */
  model: string;
  analysis_schema_version: string;
  prompt_version: string;
  correlation_id?: string | null;
  /**
   * The images as resolved by the media boundary: ordinal, canonical
   * source refs, and the verified MIME type and byte length.
   */
  images: readonly AnalyzerImage[];
  /**
   * The canonical `messages` rows those images came from.
   *
   * Needed because an `AnalyzerImage` carries bytes and a source ref,
   * and nothing else — it does not know which side of the conversation
   * a message was on or when it was sent. Both are read from WACRM's own
   * record here rather than from anything a provider or caller supplied.
   */
  candidates: readonly ImageAnalysisMediaCandidate[];
  /** The validated result. Never the raw provider answer. */
  result: CanonicalImageAnalysisResult;
}

/**
 * The canonical `messages` row behind one analysed image.
 *
 * A structural subset of `AnalysisMediaCandidate`, declared here so this
 * domain states the shape it needs instead of importing the tool layer's
 * internal naming — the tool may be replaced, and the canonical record
 * must not move with it.
 */
export interface ImageAnalysisMediaCandidate {
  message_id: string;
  created_at: string;
  sender_type: string;
  content_type: string;
  media_url: string | null;
  media_type: string | null;
}

/**
 * The subset of `AnalyzeImagesOutput` a projection needs.
 *
 * Declared structurally rather than imported so the persistence layer
 * has no dependency on the tool layer: the tool may be replaced, and
 * the canonical record must not move with it.
 */
export interface CanonicalImageAnalysisResult {
  observations: readonly ImageObservation[];
  ambiguous_items: readonly AmbiguousImageItem[];
  image_quality: readonly ImageQualityObservation[];
  estimated_volume_range: {
    unit: 'relative_volume_units';
    min: number;
    max: number;
    confidence: number;
  } | null;
  need_more_photos: boolean;
  follow_up_questions: readonly string[];
  notes: readonly string[];
}

function projectObservation(
  observation: ImageObservation,
  index: number,
  byOrdinal: ReadonlyMap<number, ImageAnalysisSourceImage>
): PersistedImageFinding {
  return {
    finding_kind: 'observation',
    ordinal_in_result: index + 1,
    finding_ref: observation.observation_id,
    kind: observation.kind,
    label: observation.label,
    confidence: observation.confidence,
    basis: observation.basis,
    detail: null,
    payload: {
      kind: observation.kind,
      label: observation.label,
      confidence: observation.confidence,
      basis: observation.basis,
      approximate_count: observation.approximate_count,
      volume_range: observation.volume_range,
      dismantling: observation.dismantling,
      heavy_handling: observation.heavy_handling,
      hazards: [...observation.hazards],
      notes: observation.notes,
    },
    source_ordinals: resolveOrdinals(observation.sources, byOrdinal),
  };
}

function projectAmbiguousItem(
  item: AmbiguousImageItem,
  index: number,
  byOrdinal: ReadonlyMap<number, ImageAnalysisSourceImage>
): PersistedImageFinding {
  return {
    finding_kind: 'ambiguous_item',
    ordinal_in_result: index + 1,
    // An ambiguity has no provider-assigned identity, so one is minted
    // here with a distinct prefix. The prefix matters: `ambiguous-1`
    // must never collide with an observation's `obs-1`.
    finding_ref: `ambiguous-${index + 1}`,
    kind: null,
    label: item.description,
    confidence: item.confidence,
    basis: null,
    detail: null,
    payload: {
      description: item.description,
      confidence: item.confidence,
    },
    source_ordinals: resolveOrdinals(item.sources, byOrdinal),
  };
}

function projectImageQuality(
  entry: ImageQualityObservation,
  index: number,
  byOrdinal: ReadonlyMap<number, ImageAnalysisSourceImage>
): PersistedImageFinding {
  return {
    finding_kind: 'image_quality',
    ordinal_in_result: index + 1,
    finding_ref: `quality-${index + 1}`,
    kind: entry.kind,
    label: null,
    confidence: null,
    basis: null,
    detail: entry.detail,
    payload: {
      kind: entry.kind,
      detail: entry.detail,
    },
    source_ordinals: resolveOrdinals(entry.sources, byOrdinal),
  };
}

/**
 * Ordinals an observation was derived from.
 *
 * Re-resolved against the run's own image set rather than trusted: a
 * source referencing a photograph that was not analysed is a
 * traceability defect, not something to store.
 */
function resolveOrdinals(
  sources: readonly { ordinal: number }[],
  byOrdinal: ReadonlyMap<number, ImageAnalysisSourceImage>
): number[] {
  if (sources.length === 0) {
    throw new ImageObservationError(
      'invalid_input',
      'An observation without a source image cannot be recorded: it would not be traceable to a photograph.'
    );
  }
  const ordinals: number[] = [];
  for (const source of sources) {
    if (!byOrdinal.has(source.ordinal)) {
      throw new ImageObservationError(
        'invalid_input',
        `An observation references image ordinal ${source.ordinal}, which was not part of this analysis.`
      );
    }
    if (!ordinals.includes(source.ordinal)) ordinals.push(source.ordinal);
  }
  return ordinals.sort((left, right) => left - right);
}

/**
 * Project resolved analyzer images into the per-image record.
 *
 * The direction and the message timestamp come from `candidates`, the
 * canonical `messages` rows the media boundary already resolved and
 * verified — NOT from the analyzer image, because the analyzer is handed
 * bytes and a source ref and knows nothing about which side of the
 * conversation a message was on.
 */
function normaliseImages(
  images: readonly AnalyzerImage[],
  candidates: readonly ImageAnalysisMediaCandidate[]
): ImageAnalysisSourceImage[] {
  const byMessage = new Map<string, ImageAnalysisMediaCandidate>();
  for (const candidate of candidates) {
    byMessage.set(candidate.message_id, candidate);
  }

  return images.map((image) => {
    const byteLength = image.byte_length;
    if (!Number.isInteger(byteLength) || byteLength <= 0) {
      throw new ImageObservationError(
        'invalid_input',
        'A source image must record a positive whole-number byte length.'
      );
    }
    const candidate = byMessage.get(image.source.source_message_id);
    if (!candidate) {
      throw new ImageObservationError(
        'invalid_input',
        'A source image did not come from a canonical message in this analysis.'
      );
    }
    return {
      ordinal: image.source.ordinal,
      source_message_id: image.source.source_message_id,
      source_media_id: image.source.source_media_id,
      mime_type: image.mime_type,
      byte_length: byteLength,
      direction: candidate.sender_type === 'customer' ? 'inbound' : 'outbound',
      message_created_at: candidate.created_at,
    };
  });
}

// ---------------------------------------------------------------------------
// Fingerprints
// ---------------------------------------------------------------------------

/**
 * Deterministic identity of the analysed media set.
 *
 * Hashed over the ordered, canonical identity of each analysed image —
 * ordinal, message, object path, MIME, byte length — plus the
 * conversation and the analyzer/model/schema/prompt that read them.
 *
 * What this deliberately is NOT:
 *
 *   - Not a perceptual hash. Two photographs of the same sofa taken
 *     seconds apart are two images. Deciding they are "the same" needs a
 *     business definition of item identity, which this objective does
 *     not have and must not invent.
 *   - Not a hash of the bytes. WACRM does not compute a content hash of
 *     customer photographs, and adding one would mean reading every
 *     object on every analysis for no benefit the object path does not
 *     already provide: two messages pointing at the same storage object
 *     are byte-identical by construction.
 *
 * The consequence is the property that matters: re-analysing the same
 * media under the same model and contract is recognisable as the same
 * request, and re-analysing it under a different model is not.
 */
export function buildImageAnalysisSourceFingerprint(
  analysis: CanonicalImageAnalysis
): string {
  const material = {
    conversation_id: analysis.conversation_id,
    analyzer_id: analysis.analyzer_id,
    provider: analysis.provider,
    model: analysis.model,
    analysis_schema_version: analysis.analysis_schema_version,
    prompt_version: analysis.prompt_version,
    images: [...analysis.images]
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((image) => ({
        ordinal: image.ordinal,
        source_message_id: image.source_message_id,
        source_media_id: image.source_media_id,
        mime_type: image.mime_type,
        byte_length: image.byte_length,
      })),
  };
  return sha256Hex(JSON.stringify(material));
}

/**
 * Re-validate every stored payload of a run through the ORIGINAL
 * validator.
 *
 * Reading stored observations back through a looser reader would be the
 * one way this design could quietly lose its central guarantee: that the
 * persisted record holds the same contract `analyze_images` produced.
 * Re-using `parsePersistedImageFinding` means a row that could not have
 * been written cannot be read back — a price field, a weight field, an
 * unknown key, an out-of-range confidence and an absolute volume unit are
 * all still rejected on the way out.
 *
 * An observation whose surviving source images cannot cover its recorded
 * ordinals is skipped rather than re-validated against a fabricated
 * image set. It cannot happen while the source links are intact, and the
 * alternative — inventing an ordinal to satisfy the validator — would
 * manufacture provenance that was never observed.
 */
export function validatePersistedFindings(
  observations: readonly ImageAnalysisObservation[],
  sources: ReadonlyMap<string, readonly number[]>,
  images: ReadonlyMap<number, ImageAnalysisSourceImage>
): ValidatedPersistedImageFinding[] {
  const validated: ValidatedPersistedImageFinding[] = [];

  for (const observation of observations) {
    const ordinals = [...(sources.get(observation.id) ?? [])].sort(
      (left, right) => left - right
    );
    if (ordinals.length === 0) continue;

    const refs: ImageSourceRef[] = [];
    let resolved = true;
    for (const ordinal of ordinals) {
      const image = images.get(ordinal);
      if (!image) {
        resolved = false;
        break;
      }
      refs.push({
        ordinal,
        source_message_id: image.source_message_id,
        source_media_id: image.source_media_id,
      });
    }
    if (!resolved) continue;

    const result = parsePersistedImageFinding(
      observation.payload,
      observation.finding_kind as AnalysisResultBinding,
      refs
    );
    const finding =
      observation.finding_kind === 'observation'
        ? result.observations[0]
        : observation.finding_kind === 'ambiguous_item'
          ? result.ambiguous_items[0]
          : result.image_quality[0];
    if (!finding) {
      throw new ImageObservationError(
        'database_error',
        'A stored image observation could not be re-validated against the observation contract it was recorded under.'
      );
    }

    validated.push({
      observation_id: observation.finding_ref,
      finding_kind: observation.finding_kind,
      ordinal_in_result: observation.ordinal_in_result,
      finding,
      source_ordinals: ordinals,
    });
  }

  return validated;
}

/**
 * SHA-256 over the canonical serialisation of what was observed.
 *
 * A pure function of the validated findings, so two runs over the same
 * photographs by the same model can be recognised as having reported
 * the same thing — which is what makes "did this change?" answerable
 * without re-reading the rows.
 *
 * Sources are included as ORDINALS, never as message ids or object
 * paths. Ordinals are part of the observation's meaning within one
 * analysis; a message id is an identifier that would make the hash
 * change for a reason that has nothing to do with what was seen.
 */
export function buildImageAnalysisResultHash(
  analysis: CanonicalImageAnalysis
): string {
  const material = {
    analysis_schema_version: analysis.analysis_schema_version,
    need_more_photos: analysis.need_more_photos,
    follow_up_questions: [...analysis.follow_up_questions].sort(),
    notes: [...analysis.notes].sort(),
    findings: analysis.findings.map((finding) => ({
      finding_kind: finding.finding_kind,
      ordinal_in_result: finding.ordinal_in_result,
      finding_ref: finding.finding_ref,
      payload: finding.payload,
      source_ordinals: [...finding.source_ordinals].sort((l, r) => l - r),
    })),
  };
  return sha256Hex(JSON.stringify(material));
}

/** SHA-256 of the exact text, lowercase hex. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Run lifecycle helpers
// ---------------------------------------------------------------------------

/**
 * Classify a tool error into the closed failure vocabulary.
 *
 * The mapping is here, once, rather than at each call site, because a
 * durable row must not carry a message that can echo provider text. The
 * provider's own wording never reaches storage.
 */
export function imageAnalysisFailureReason(input: {
  code: string;
  message?: string;
}): ImageAnalysisFailureReason {
  const message = input.message ?? '';

  // Ordered from most specific to least. Every branch is matched on the
  // message as well as the code because `analyze_images` reports several
  // distinct situations through the SAME tool error code (`unavailable`),
  // and collapsing them would make "this account has no AI setup" and
  // "the provider rejected the request" indistinguishable in the audit
  // trail — which is exactly the distinction an operator needs.
  if (input.code === 'cancelled' || /cancelled/i.test(message)) {
    return 'caller_cancelled';
  }
  if (/timed out/i.test(message)) return 'provider_timeout';
  if (
    input.code === 'internal' ||
    /invalid result/i.test(message) ||
    /no media|unsupported|not accessible/i.test(message)
  ) {
    return 'invalid_provider_result';
  }
  if (
    input.code === 'forbidden' ||
    /not configured/i.test(message) ||
    /could not be read/i.test(message)
  ) {
    return 'account_not_configured';
  }
  return 'provider_error';
}

/**
 * A non-successful status for a failure reason, so the two cannot disagree.
 *
 * The return type excludes `succeeded` deliberately: a status paired with
 * a `failure_reason` describes a run that produced no observations, and
 * returning the success status here would let a caller record a failure
 * reason on a run the database would then reject.
 */
export function imageAnalysisFailureStatus(
  reason: ImageAnalysisFailureReason
): Exclude<ImageAnalysisRunStatus, 'succeeded'> {
  switch (reason) {
    case 'provider_timeout':
      return 'timed_out';
    case 'caller_cancelled':
      return 'cancelled';
    case 'invalid_provider_result':
      return 'validation_failed';
    default:
      return 'provider_unavailable';
  }
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

const FINDING_KIND_SET = new Set<string>(IMAGE_ANALYSIS_FINDING_KINDS);
const STATUS_SET = new Set<string>(IMAGE_ANALYSIS_RUN_STATUSES);
const FAILURE_REASON_SET = new Set<string>(IMAGE_ANALYSIS_FAILURE_REASONS);
const STATE_SET = new Set<string>(IMAGE_ANALYSIS_RUN_STATES);

export function isImageAnalysisFindingKind(
  value: unknown
): value is ImageAnalysisFindingKind {
  return typeof value === 'string' && FINDING_KIND_SET.has(value);
}

export function isImageAnalysisRunStatus(
  value: unknown
): value is ImageAnalysisRunStatus {
  return typeof value === 'string' && STATUS_SET.has(value);
}

export function isImageAnalysisFailureReason(
  value: unknown
): value is ImageAnalysisFailureReason {
  return typeof value === 'string' && FAILURE_REASON_SET.has(value);
}

export function isImageAnalysisRunState(
  value: unknown
): value is ImageAnalysisRunState {
  return typeof value === 'string' && STATE_SET.has(value);
}

function requireBounded(
  value: string,
  field: string,
  max: number
): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed === '' || trimmed.length > max) {
    throw new ImageObservationError(
      'invalid_input',
      `${field} must be a non-empty string of at most ${max} characters`
    );
  }
  return trimmed;
}

export function requireNonEmptyId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ImageObservationError(
      'invalid_input',
      `${field} must be a non-empty id`
    );
  }
  return value.trim();
}
