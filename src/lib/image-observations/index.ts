/**
 * The narrow image-observation domain.
 *
 * Canonical, account-scoped, source-traceable persistence of validated
 * `analyze_images` observations. See `docs/image-analysis.md` and
 * `docs/vector-memory.md`.
 *
 * Four modules, in dependency order:
 *
 * - `model.ts` — the vocabularies, the projection from a validated tool
 *   output to a persistable record, the deterministic fingerprints, and
 *   the strict row parsers. Pure.
 * - `repository.ts` — account-scoped storage. Every function is
 *   specific; there is no generic query and no caller-supplied filter.
 * - `service.ts` — the write capabilities, and the reasoning for why
 *   persistence lives outside the read tool.
 *
 * What is deliberately NOT exported as capability: any way to search,
 * rank, or compare these observations. Retrieval is objective 04, and
 * this domain must not be usable to bypass it.
 */

export {
  IMAGE_ANALYSIS_FAILURE_REASONS,
  IMAGE_ANALYSIS_FINDING_KINDS,
  IMAGE_ANALYSIS_HASH_PATTERN,
  IMAGE_ANALYSIS_MAX_CORRELATION_CHARS,
  IMAGE_ANALYSIS_MAX_MODEL_CHARS,
  IMAGE_ANALYSIS_MAX_VERSION_CHARS,
  IMAGE_ANALYSIS_RUN_STATES,
  IMAGE_ANALYSIS_RUN_STATUSES,
  IMAGE_OBSERVATION_MAX_DETAIL_CHARS,
  IMAGE_OBSERVATION_MAX_LABEL_CHARS,
  IMAGE_OBSERVATION_MAX_REF_CHARS,
  ImageObservationError,
  buildImageAnalysisResultHash,
  buildImageAnalysisSourceFingerprint,
  imageAnalysisFailureReason,
  imageAnalysisFailureStatus,
  isImageAnalysisFailureReason,
  isImageAnalysisFindingKind,
  isImageAnalysisRunState,
  isImageAnalysisRunStatus,
  projectCanonicalImageAnalysis,
  requireNonEmptyId,
  type CanonicalImageAnalysis,
  type CanonicalImageAnalysisResult,
  type ImageAnalysisAggregate,
  type ImageAnalysisFailureReason,
  type ImageAnalysisFindingKind,
  type ImageAnalysisMediaCandidate,
  type ImageAnalysisObservation,
  type ImageAnalysisObservationSource,
  type ImageAnalysisRun,
  type ImageAnalysisRunImage,
  type ImageAnalysisRunState,
  type ImageAnalysisRunStatus,
  type ImageAnalysisSourceImage,
  type PersistedAmbiguousItemPayload,
  type PersistedImageFinding,
  type PersistedImageObservationPayload,
  type PersistedImageQualityPayload,
  type ProjectCanonicalImageAnalysisArgs,
} from './model';

export {
  IMAGE_ANALYSIS_OBSERVATION_COLUMNS,
  IMAGE_ANALYSIS_OBSERVATION_SOURCE_COLUMNS,
  IMAGE_ANALYSIS_RUN_COLUMNS,
  IMAGE_ANALYSIS_RUN_IMAGE_COLUMNS,
  assertAnalysisSourceTraceability,
  findImageAnalysisRun,
  getAnalysisForMedia,
  getCurrentAnalysis,
  listImageAnalysisRunsForCase,
  listRunImages,
  listRunObservations,
  loadImageAnalysisAggregate,
  parseImageAnalysisRun,
  recordFailedImageAnalysis,
  recordImageAnalysis,
  supersedeImageAnalysisRun,
  type FindImageAnalysisRunArgs,
  type RecordImageAnalysisArgs,
  type RecordImageAnalysisResult,
} from './repository';

export {
  recordImageAnalysisFailure,
  recordValidatedImageAnalysis,
  type RecordValidatedImageAnalysisArgs,
} from './service';

// The two version tags are re-exported from the image-analysis layer
// itself rather than the service, so a consumer cannot record an
// observation under a version it chose locally.
export {
  IMAGE_ANALYSIS_SCHEMA_VERSION,
  VISION_PROMPT_VERSION,
} from '@/lib/ai/image-analysis';