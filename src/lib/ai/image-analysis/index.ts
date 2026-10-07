/**
 * Objective 08 — image analysis foundation.
 *
 * Exposed as one module surface so the tool layer imports a single path.
 * See `docs/image-analysis.md` for the architecture, the security
 * boundary, and the documented limitations.
 */

export {
  ANALYSIS_MEDIA_BUCKET,
  ANALYZE_IMAGES_DEFAULT_IMAGE_COUNT,
  IMAGE_ANALYZER_TIMEOUT_MS,
  IMAGE_ANALYSIS_LIMITS,
  SUPPORTED_IMAGE_MIME_TYPES,
  normalizeImageMimeType,
  sniffImageMimeType,
  type ImageAnalysisLimits,
  type SupportedImageMimeType,
} from './limits';

export {
  getConfiguredImageAnalyzer,
  type AnalyzerImage,
  type ImageAnalysisContext,
  type ImageAnalysisRequest,
  type ImageAnalyzer,
  type ImageAnalyzerResolver,
  type ImageAnalyzerResolverArgs,
  type ImageSourceRef,
} from './analyzer';

export {
  VISION_ANALYZER_ID,
  createVisionImageAnalyzer,
  parseProviderJson,
  type VisionAnalyzerArgs,
} from './vision-analyzer';

export {
  buildVisionSystemPrompt,
  buildVisionUserText,
  IMAGE_ANALYSIS_MAX_OUTPUT_TOKENS,
  VISION_PROMPT_VERSION,
} from './vision-prompt';

export {
  createSupabaseStorageMediaLoader,
  resolveAnalysisImages,
  resolveMediaObjectPath,
  type AnalysisMediaCandidate,
  type AnalysisMediaClient,
  type AnalysisMediaLoader,
  type AnalysisMediaLoadRequest,
  type DuplicateMediaReference,
  type LoadedAnalysisMedia,
  type MediaReferenceResolution,
  type ResolvedAnalysisImage,
} from './media';

export {
  ANALYSIS_RESULT_BINDINGS,
  ImageAnalysisValidationError,
  IMAGE_ANALYSIS_SCHEMA_VERSION,
  parsePersistedImageFinding,
  type AnalysisResultBinding,
  INDICATOR_TRISTATE,
  IMAGE_OBSERVATION_KINDS,
  IMAGE_QUALITY_ISSUE_KINDS,
  parseImageAnalysisResult,
  type AmbiguousImageItem,
  type ApproximateCount,
  type ImageAnalysisResult,
  type ImageObservation,
  type ImageObservationKind,
  type ImageQualityIssueKind,
  type ImageQualityObservation,
  type IndicatorTristate,
  type PersistedAmbiguousItemPayload,
  type PersistedImageObservationPayload,
  type PersistedImageQualityPayload,
  type RelativeVolumeRange,
} from './result';

export {
  createFakeImageAnalyzer,
  createStubImageAnalyzer,
  type FakeAnalyzerCall,
  type FakeImageAnalyzer,
  type FakeImageAnalyzerOptions,
} from './fake-analyzer';
