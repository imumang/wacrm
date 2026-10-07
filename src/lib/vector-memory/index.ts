/**
 * Objective 03 — the narrow vector-memory domain.
 *
 * Four modules, in dependency order:
 *
 * - `model.ts` — vocabularies, version pins, the model registry, the
 *   price-leakage guard, and the eligibility policy. Pure.
 * - `semantic-input.ts` — the deterministic builders that turn canonical
 *   business data into the exact text that gets embedded, plus the
 *   content hash. Pure.
 * - `provider.ts` — the provider-neutral embedding boundary. The only
 *   module that knows a network call is involved.
 * - `repository.ts` / `service.ts` — account-scoped storage, and the
 *   bounded/idempotent operations over it.
 *
 * What is deliberately NOT exported as capability: any way to run a
 * similarity query. Objective 04 owns retrieval and ranking, and this
 * objective cannot be used to bypass it, because there is no function
 * here that takes a query vector and returns neighbours.
 */

export {
  CASE_TEXT_SEMANTIC_INPUT_VERSION,
  CONTENT_HASH_PATTERN,
  GENERATABLE_VECTOR_EMBEDDING_KINDS,
  IMAGE_OBSERVATION_TEXT_SEMANTIC_INPUT_VERSION,
  MONETARY_CASE_FACT_KEYS,
  NATIVE_IMAGE_EMBEDDING_SUPPORT,
  VECTOR_EMBEDDING_DIMENSIONS,
  VECTOR_EMBEDDING_KINDS,
  VECTOR_EMBEDDING_MODEL,
  VECTOR_EMBEDDING_MODEL_VERSION,
  VECTOR_EMBEDDING_PROVIDER,
  VECTOR_EMBEDDING_SOURCES,
  VECTOR_EMBEDDING_SOURCE_ENTITIES,
  VECTOR_EMBEDDING_STATES,
  VECTOR_MEMORY_BATCH_DEFAULT_LIMIT,
  VECTOR_MEMORY_BATCH_MAX_LIMIT,
  VECTOR_MEMORY_BATCH_MIN_LIMIT,
  VECTOR_MEMORY_MAX_SEMANTIC_INPUT_CHARS,
  VECTOR_MEMORY_MIN_SEMANTIC_SIGNALS,
  VectorMemoryError,
  assertNoMonetaryLeakage,
  boundedBatchLimit,
  evaluateVectorMemoryEligibility,
  isGeneratableVectorEmbeddingKind,
  isMonetaryCaseFactKey,
  isVectorEmbeddingKind,
  isVectorEmbeddingSourceEntity,
  isVectorEmbeddingState,
  parseCaseEmbedding,
  type CaseEmbedding,
  type CaseEmbeddingRetrievalEntry,
  type GeneratedCaseEmbedding,
  type GeneratableVectorEmbeddingKind,
  type VectorEmbeddingKind,
  type VectorEmbeddingSourceEntity,
  type VectorEmbeddingState,
  type VectorMemoryEligibilityDecision,
} from './model';

export {
  SEMANTIC_CASE_FACT_KEYS,
  SEMANTIC_ENQUIRY_FIELDS,
  buildCaseSemanticInput,
  buildImageObservationSemanticInput,
  imageObservationRecordsFromAnalysis,
  imageObservationRecordsFromSnapshot,
  sha256Hex,
  type ImageObservationRecord,
  type SemanticCaseSource,
  type SemanticEnquiryFacts,
  type SemanticInput,
} from './semantic-input';

export {
  buildPerImageObservationSemanticInput,
  perImageSemanticSources,
  PER_IMAGE_OBSERVATION_TEXT_SEMANTIC_INPUT_VERSION,
  type PerImageObservationSource,
  type PerImageSemanticInput,
} from './per-image-semantic-input';

export {
  generateEmbedding,
  generateEmbeddings,
  generateNativeImageEmbedding,
  type GenerateEmbeddingArgs,
  type GenerateEmbeddingsArgs,
} from './provider';

export {
  CASE_EMBEDDING_COLUMNS,
  CaseEmbeddingRepositoryError,
  countEmbeddingCoverage,
  findCaseEmbeddingByIdentity,
  listCurrentEmbeddings,
  listEmbeddingEligibleCases,
  loadCurrentEmbedding,
  markEmbeddingStale,
  storeCaseEmbedding,
  type EmbeddingCandidateCase,
  type StoreCaseEmbeddingArgs,
} from './repository';

export {
  VECTOR_MEMORY_OPERATION_MODES,
  buildPerImageObservationInputs,
  buildTransientQueryEmbedding,
  ensureCaseTextEmbedding,
  ensureImageObservationEmbedding,
  runCaseEmbeddingOperation,
  type CaseEmbeddingOperationResult,
  type CaseEmbeddingOutcome,
  type PerImageObservationEmbeddingSource,
  type RunCaseEmbeddingOperationArgs,
  type TransientQuerySource,
  type VectorMemoryOperationMode,
} from './service';
