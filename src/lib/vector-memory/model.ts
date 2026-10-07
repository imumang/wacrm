/**
 * Objective 03 — the vector-memory domain model.
 *
 * This module owns the vocabularies, the version tags, the eligibility
 * policy, and the two invariants that make a store of vectors safe:
 *
 *  1. **Price leakage is prevented by construction and then checked.**
 *     `buildCaseSemanticInput` only ever copies from an explicit
 *     allowlist of operational business fields, and
 *     `assertNoMonetaryLeakage` re-reads the finished text and refuses
 *     it if anything resembling money, a currency, or a commercial
 *     acceptance label appears. The first layer makes leakage
 *     unlikely; the second makes it impossible to ship silently. Either
 *     alone would be weaker than the pair.
 *
 *  2. **Vectors from different models are never interchangeable.**
 *     A stored vector is identified by (provider, embedding model,
 *     model version, dimensions). Those four values are the
 *     compatibility group, and they are recorded on every row, so
 *     objective 04 can never compare a `text-embedding-3-large`
 *     vector with a `text-embedding-3-small` one just because they
 *     happen to be in the same table.
 *
 * The vocabularies here are mirrored by migration 053 and are
 * deliberately identical in the values they accept.
 */

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/**
 * What a stored vector represents.
 *
 * These are three different things and conflating any pair of them is
 * the failure this union exists to prevent:
 *
 * - `case_text` — a text embedding of the canonical business
 *   description of one historical job. "This job was two sofas on the
 *   third floor of a walk-up with no lift."
 * - `image_observation_text` — a text embedding derived from *validated
 *   structured visual observations*. The vision model described what it
 *   saw in a photograph; WACRM serialised that description; a text
 *   model embedded the words. **This is not a native image embedding.**
 *   It is a description of an image, in words, made by another model.
 * - `native_image` — a true visual vector computed from the pixels
 *   themselves. It measures visual similarity directly and shares no
 *   coordinate system with either of the above.
 *
 * The middle and the last are often confused, and the confusion is
 * expensive: text-derived observations and pixel-derived vectors rank
 * differently, fail differently, and mean different things. Objective
 * 04 must be able to tell them apart, so they are two names rather
 * than one name with a flag.
 */
export const VECTOR_EMBEDDING_KINDS = [
  'case_text',
  'image_observation_text',
  'native_image',
] as const;

export type VectorEmbeddingKind = (typeof VECTOR_EMBEDDING_KINDS)[number];

/** The kinds this objective can actually produce. */
export const GENERATABLE_VECTOR_EMBEDDING_KINDS = [
  'case_text',
  'image_observation_text',
] as const satisfies readonly VectorEmbeddingKind[];

export type GeneratableVectorEmbeddingKind =
  (typeof GENERATABLE_VECTOR_EMBEDDING_KINDS)[number];

/**
 * Liveness of a stored vector.
 *
 * - `current` — participates in active retrieval.
 * - `stale` — the source content, the semantic input version, or the
 *   model changed and a newer row replaced it. Retained, because a
 *   retrieval result recorded last month has to stay explainable.
 * - `superseded` — explicitly replaced, with `superseded_by` naming the
 *   replacement.
 * - `withheld` — the source case is excluded from learning. Present
 *   and auditable, never retrievable.
 *
 * Vectors are never deleted to express any of these. Deletion happens
 * only through the case or account cascade, i.e. only when somebody
 * decided the source data itself is gone.
 */
export const VECTOR_EMBEDDING_STATES = [
  'current',
  'stale',
  'superseded',
  'withheld',
] as const;

export type VectorEmbeddingState = (typeof VECTOR_EMBEDDING_STATES)[number];

/** Which canonical record a semantic input was derived from. */
export const VECTOR_EMBEDDING_SOURCE_ENTITIES = [
  'historical_case',
  'historical_case_snapshot',
] as const;

export type VectorEmbeddingSourceEntity =
  (typeof VECTOR_EMBEDDING_SOURCE_ENTITIES)[number];

/** Which historical case `embedding_kind` a vector belongs to. */
export const VECTOR_EMBEDDING_SOURCES = ['historical_case'] as const;

// ---------------------------------------------------------------------------
// Model / version pinning
// ---------------------------------------------------------------------------

/**
 * The registered text-embedding model.
 *
 * Reuses the knowledge base's provider, key and client
 * (`src/lib/ai/embeddings.ts`, `ai_configs.embeddings_api_key`), so
 * this objective adds a *second consumer* of an existing embedding
 * path, not a second embedding path. Anthropic has no embeddings
 * endpoint, so an Anthropic-only account gets `unavailable` from the
 * provider resolver — the same supported state as an account with no
 * embeddings key at all.
 *
 * `model_version` is WACRM's own pin rather than the provider's model
 * id. It exists so a future change of provider-side model (same name,
 * different weights) is a distinct compatibility group even though the
 * string `text-embedding-3-small` did not change. Mirrors
 * `public.case_embedding_registered_model` in migration 053.
 */
export const VECTOR_EMBEDDING_PROVIDER = 'openai' as const;
export const VECTOR_EMBEDDING_MODEL = 'text-embedding-3-small';
export const VECTOR_EMBEDDING_MODEL_VERSION = 'text-embedding-3-small-1536-v1';
export const VECTOR_EMBEDDING_DIMENSIONS = 1536;

/**
 * Semantic input versions.
 *
 * A version tag on the *builder*, separate from the model version,
 * because the two change for different reasons: a model upgrade means
 * new coordinates, while a builder change means the same coordinates
 * now describe something slightly different. Bumping either one
 * re-embeds; conflating them would make an innocuous wording change
 * look like a model change and vice versa.
 *
 * Both builders are pure functions of their input, so the same case
 * state under the same version always produces byte-identical text and
 * therefore the same content hash.
 */
export const CASE_TEXT_SEMANTIC_INPUT_VERSION = 'case-text-v1';
export const IMAGE_OBSERVATION_TEXT_SEMANTIC_INPUT_VERSION =
  'image-observation-text-v1';

/**
 * Native image embeddings: explicitly unsupported.
 *
 * Audit of the approved provider architecture found no native image
 * embedding capability that can be reached safely from WACRM's
 * controlled media boundary:
 *
 * - The configured chat/vision models are used for vision *description*
 *   through `analyze_images`, which returns validated structured
 *   observations. That is not an embedding endpoint.
 * - `src/lib/ai/embeddings.ts` is a text-only `/v1/embeddings` client.
 * - There is no second provider in `ai_configs`, and adding one purely
 *   to complete a checklist would mean a new credential, a new data
 *   processor for customer photographs, and a new review surface —
 *   none of which this objective is allowed to decide on its own.
 *
 * So `native_image` is a registered kind that nothing can currently
 * produce, and this function is what a caller reaches instead. The
 * alternative — embedding the observation text and labelling it
 * `native_image` — is the one thing that must not happen: it would
 * create a dataset that claims visual-vector provenance it does not
 * have, and objective 04 would rank against a fiction.
 */
export const NATIVE_IMAGE_EMBEDDING_SUPPORT = {
  supported: false as const,
  reason:
    'No approved provider in the current WACRM AI architecture exposes a native image embedding endpoint for the controlled media boundary. Use image_observation_text (a text embedding of validated visual observations) and never label it native_image.',
};

// ---------------------------------------------------------------------------
// Price-leakage protection
// ---------------------------------------------------------------------------

/**
 * Canonical case facts that describe money or a commercial decision.
 *
 * Listed so the semantic builder can assert it never reads them, and so
 * a reviewer can see the exclusion in one place rather than inferring
 * it from a missing `if`. Mirrors the commercial keys in
 * `src/lib/historical-cases/outcome.ts`.
 */
export const MONETARY_CASE_FACT_KEYS = [
  'ai_suggested_amount',
  'human_approved_amount',
  'customer_facing_quote_amount',
  'final_amount_collected',
  'quote_adjustment_amount',
  'quote_decision',
  'quote_adjustment_reason',
] as const;

/**
 * Patterns that would mean a monetary value or a commercial label has
 * entered embedding input.
 *
 * Two families, both deliberately fail-closed:
 *
 * - Money-shaped tokens: a currency symbol or code next to a number, or
 *   a money word anywhere. An embedding whose text says "cost" is
 *   describing a price, whatever else it says.
 * - Commercial decision words on their own ("accepted", "rejected",
 *   "customer declined"), which are the pricing labels this dataset is
 *   most at risk of learning from by accident.
 *
 * The builders already construct text from an allowlist, so a match
 * here means a field somebody typed free text contained one of these —
 * e.g. an operator wrote "customer rejected the price" into an item
 * description. That must fail loudly and be cleaned at the source,
 * because the alternative is a vector whose nearest neighbours are
 * selected partly by price.
 */
const MONETARY_PATTERNS: readonly RegExp[] = [
  /[£$€₹]/,
  /\b(?:gbp|usd|eur|inr|brl|rs\.?|inr)\b/i,
  /\b\d[\d,.]*\s*(?:pounds?|euros?|dollars?|rupees?|reais?|kroner?)\b/i,
  /\b(?:pounds?|euros?|dollars?|rupees?|reais?)\s*\d/i,
  /\b(?:price[ds]?|pricing|cost(?:s|ed|ing)?|charg(?:e[ds]?|ing|ed)|quot(?:e[ds]?|ing)|amount|amounts|paid|payment|payments|invoice|invoices|bill(?:s|ed|ing)?|budget|rate|fee|fees|expensive|cheap(?:ly)?|dear|afford(?:able)?|discount|markup|surcharge|premium)\b/i,
  /\b(?:accept(?:ed|s)?|reject(?:ed|s)?|declin(?:e[ds]?|ing)|agreed?\s+to\s+pay|went\s+silent|ghosted)\b/i,
];

/**
 * Refuse semantic input that carries money or a commercial decision.
 *
 * Throws rather than warns. A vector that cannot be un-leaked after
 * the fact — there is no way to subtract "450" from an embedding — has
 * to be rejected at the point of construction, where an operator can
 * still go and fix the source text.
 */
export function assertNoMonetaryLeakage(
  text: string,
  context: string
): void {
  for (const pattern of MONETARY_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      throw new VectorMemoryError(
        'invalid_input',
        `Refusing to embed ${context}: it contains a monetary or commercial token ("${match[0]}"). Embedding input must describe the job, never its price or the customer's decision about it.`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

/** Bounds mirroring the CHECK constraints in migration 053. */
export const VECTOR_MEMORY_MAX_SOURCE_REFERENCE_LENGTH = 200;
export const VECTOR_MEMORY_MAX_VERSION_LENGTH = 64;

export interface VectorMemoryEligibilityCase {
  learning_eligibility: 'pending' | 'included' | 'excluded';
  case_state: 'open' | 'finalized';
  evidence_quality_tier: string | null;
}

/**
 * A case needs enough operational description to produce a vector that
 * can match anything.
 *
 * Two independent signals, because one is easy to fake: a case that
 * says only "sofas" and a case that says only "second floor" are both
 * near-useless comparables, but a case that says both is a real job.
 *
 * This is a *sufficiency* floor for storage, not a quality judgement.
 * Deliberately NOT a tier requirement — see the note on the function
 * below.
 */
export const VECTOR_MEMORY_MIN_SEMANTIC_SIGNALS = 2;

export interface VectorMemoryEligibilityDecision {
  eligible: boolean;
  /** Short, machine-friendly reason. Safe to store and to display. */
  reason:
    | 'eligible'
    | 'excluded_by_operator'
    | 'insufficient_semantic_content';
  reasons: string[];
}

export function evaluateVectorMemoryEligibility(
  testCase: VectorMemoryEligibilityCase,
  semanticSignalCount: number
): VectorMemoryEligibilityDecision {
  if (testCase.learning_eligibility === 'excluded') {
    return {
      eligible: false,
      reason: 'excluded_by_operator',
      reasons: [
        'the case is excluded from learning; its embeddings are withheld from retrieval',
      ],
    };
  }

  if (semanticSignalCount < VECTOR_MEMORY_MIN_SEMANTIC_SIGNALS) {
    return {
      eligible: false,
      reason: 'insufficient_semantic_content',
      reasons: [
        `the case provides ${semanticSignalCount} operational signal(s); at least ${VECTOR_MEMORY_MIN_SEMANTIC_SIGNALS} are needed before a vector would match anything`,
      ],
    };
  }

  return { eligible: true, reason: 'eligible', reasons: [] };
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Batch bounds for the generation operation. */
export const VECTOR_MEMORY_BATCH_MIN_LIMIT = 1;
export const VECTOR_MEMORY_BATCH_DEFAULT_LIMIT = 10;
export const VECTOR_MEMORY_BATCH_MAX_LIMIT = 100;

/** Longest semantic text handed to the provider for one source. */
export const VECTOR_MEMORY_MAX_SEMANTIC_INPUT_CHARS = 8_000;

/** A SHA-256 content hash, lowercase hex. */
export const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface CaseEmbedding {
  id: string;
  account_id: string;
  historical_case_id: string;
  embedding_kind: VectorEmbeddingKind;
  source_entity: VectorEmbeddingSourceEntity;
  source_reference: string | null;
  semantic_input_version: string;
  content_hash: string;
  provider: string;
  embedding_model: string;
  model_version: string;
  dimensions: number;
  state: VectorEmbeddingState;
  superseded_by: string | null;
  created_at: string;
  refreshed_at: string;
}

/**
 * A loaded current embedding plus the canonical retrieval metadata.
 *
 * Evidence tier and learning eligibility are JOINED, never copied onto
 * the vector row. They are canonical columns on `historical_cases`
 * that legitimately change while a case is open, and a duplicated copy
 * on the vector row would drift — the failure mode where retrieval
 * filters on "this case was tier B" and the case has since been
 * reclassified as A. Retrieval metadata therefore has a defined
 * source, and it is the case row.
 */
export interface CaseEmbeddingRetrievalEntry {
  embedding: CaseEmbedding;
  evidence_quality_tier: string | null;
  learning_eligibility: string;
  case_state: string;
  completed_at: string | null;
}

/**
 * A vector generated but not necessarily stored.
 *
 * Returned by both the persistent path and the transient query path, so
 * objective 04 receives one shape either way and cannot accidentally
 * assume a query vector came from a stored row.
 */
export interface GeneratedCaseEmbedding {
  kind: GeneratableVectorEmbeddingKind;
  vector: number[];
  provider: string;
  embedding_model: string;
  model_version: string;
  dimensions: number;
  /** SHA-256 of the exact text that was embedded. */
  content_hash: string;
  semantic_input_version: string;
  usage: import('@/lib/ai/types').AiUsage | null;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type VectorMemoryErrorCode =
  | 'invalid_input'
  | 'unavailable'
  | 'unsupported'
  | 'not_found'
  | 'database_error';

/**
 * One error type for the whole domain.
 *
 * `unavailable` and `unsupported` are separated on purpose. `unavailable`
 * is "this account has no embeddings key configured" — a state that
 * resolves itself when somebody enters a key. `unsupported` is "this
 * capability does not exist in WACRM at all", which for native image
 * embeddings will still be true next week. Collapsing them would make
 * a permanent architectural fact look like a settings problem, and the
 * operator would keep retrying.
 */
export class VectorMemoryError extends Error {
  readonly code: VectorMemoryErrorCode;

  constructor(code: VectorMemoryErrorCode, message: string) {
    super(message);
    this.name = 'VectorMemoryError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

const KIND_SET = new Set<string>(VECTOR_EMBEDDING_KINDS);
const GENERATABLE_SET = new Set<string>(GENERATABLE_VECTOR_EMBEDDING_KINDS);
const STATE_SET = new Set<string>(VECTOR_EMBEDDING_STATES);
const SOURCE_ENTITY_SET = new Set<string>(VECTOR_EMBEDDING_SOURCE_ENTITIES);
const MONETARY_FACT_SET = new Set<string>(MONETARY_CASE_FACT_KEYS);

export function isVectorEmbeddingKind(
  value: unknown
): value is VectorEmbeddingKind {
  return typeof value === 'string' && KIND_SET.has(value);
}

export function isGeneratableVectorEmbeddingKind(
  value: unknown
): value is GeneratableVectorEmbeddingKind {
  return typeof value === 'string' && GENERATABLE_SET.has(value);
}

export function isVectorEmbeddingState(
  value: unknown
): value is VectorEmbeddingState {
  return typeof value === 'string' && STATE_SET.has(value);
}

export function isVectorEmbeddingSourceEntity(
  value: unknown
): value is VectorEmbeddingSourceEntity {
  return typeof value === 'string' && SOURCE_ENTITY_SET.has(value);
}

export function isMonetaryCaseFactKey(value: string): boolean {
  return MONETARY_FACT_SET.has(value);
}

/**
 * Read and validate a stored embedding row.
 *
 * Total and strict for the same reason `parseHistoricalCase` is: a row
 * that cannot be read back was not written correctly, and quietly
 * returning a half-defaulted object would put a vector with unknown
 * dimensions into a comparison.
 */
export function parseCaseEmbedding(input: unknown): CaseEmbedding {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new VectorMemoryError('database_error', 'case embedding must be an object');
  }
  const row = input as Record<string, unknown>;

  if (!isVectorEmbeddingKind(row.embedding_kind)) {
    throw new VectorMemoryError(
      'database_error',
      `invalid embedding_kind: ${String(row.embedding_kind)}`
    );
  }
  if (!isVectorEmbeddingState(row.state)) {
    throw new VectorMemoryError(
      'database_error',
      `invalid embedding state: ${String(row.state)}`
    );
  }
  if (!isVectorEmbeddingSourceEntity(row.source_entity)) {
    throw new VectorMemoryError(
      'database_error',
      `invalid source_entity: ${String(row.source_entity)}`
    );
  }

  const contentHash = requireString(row.content_hash, 'content_hash');
  if (!CONTENT_HASH_PATTERN.test(contentHash)) {
    throw new VectorMemoryError(
      'database_error',
      'content_hash is not a lowercase sha-256 hex digest'
    );
  }

  const dimensions = requireInteger(row.dimensions, 'dimensions');
  if (
    row.provider !== VECTOR_EMBEDDING_PROVIDER ||
    row.embedding_model !== VECTOR_EMBEDDING_MODEL ||
    row.model_version !== VECTOR_EMBEDDING_MODEL_VERSION ||
    dimensions !== VECTOR_EMBEDDING_DIMENSIONS
  ) {
    throw new VectorMemoryError(
      'database_error',
      'case embedding carries an unregistered model/dimension combination'
    );
  }

  return {
    id: requireString(row.id, 'id'),
    account_id: requireString(row.account_id, 'account_id'),
    historical_case_id: requireString(row.historical_case_id, 'historical_case_id'),
    embedding_kind: row.embedding_kind,
    source_entity: row.source_entity,
    source_reference: nullableString(row.source_reference),
    semantic_input_version: requireString(
      row.semantic_input_version,
      'semantic_input_version'
    ),
    content_hash: contentHash,
    provider: VECTOR_EMBEDDING_PROVIDER,
    embedding_model: VECTOR_EMBEDDING_MODEL,
    model_version: VECTOR_EMBEDDING_MODEL_VERSION,
    dimensions,
    state: row.state,
    superseded_by: nullableString(row.superseded_by),
    created_at: requireString(row.created_at, 'created_at'),
    refreshed_at: requireString(row.refreshed_at, 'refreshed_at'),
  };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new VectorMemoryError(
      'database_error',
      `${field} must be a non-empty string`
    );
  }
  return value;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function requireInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new VectorMemoryError(
      'database_error',
      `${field} must be a whole number`
    );
  }
  return value;
}

/** Clamp a caller-supplied batch size into the domain's bounds. */
export function boundedBatchLimit(limit?: number | null): number {
  if (limit === undefined || limit === null) return VECTOR_MEMORY_BATCH_DEFAULT_LIMIT;
  if (!Number.isInteger(limit)) {
    throw new VectorMemoryError('invalid_input', 'limit must be a whole number');
  }
  if (limit < VECTOR_MEMORY_BATCH_MIN_LIMIT) {
    throw new VectorMemoryError(
      'invalid_input',
      `limit must be at least ${VECTOR_MEMORY_BATCH_MIN_LIMIT}`
    );
  }
  return Math.min(VECTOR_MEMORY_BATCH_MAX_LIMIT, limit);
}
