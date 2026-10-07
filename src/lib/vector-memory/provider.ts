/**
 * Objective 03 — the provider-neutral embedding layer.
 *
 * One boundary, one provider path, three explicit modalities.
 *
 * The boundary exists so that the *vector store* never learns which
 * company produced a vector and the *semantic builders* never learn
 * that a network call is involved. What is deliberately NOT here:
 *
 * - A second API client. `src/lib/ai/embeddings.ts` is already the one
 *   embeddings client in WACRM, used by the knowledge base; this module
 *   calls it and adds nothing to it.
 * - A second credential. The key is `ai_configs.embeddings_api_key`,
 *   decrypted through `loadEmbeddingsKey`, exactly as the knowledge-base
 *   ingest path does.
 * - A native image implementation. There is nothing to implement: the
 *   approved provider architecture has no image-embedding endpoint. See
 *   `NATIVE_IMAGE_EMBEDDING_SUPPORT`.
 *
 * Every generated vector is returned together with the compatibility
 * group it belongs to, so it cannot be stored without them and cannot
 * be compared across groups later.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { loadEmbeddingsKey } from '@/lib/ai/config';
import { embedTextsWithUsage } from '@/lib/ai/embeddings';
import type { AiUsage } from '@/lib/ai/types';
import { logAiUsage } from '@/lib/ai/usage';

import {
  NATIVE_IMAGE_EMBEDDING_SUPPORT,
  VECTOR_EMBEDDING_DIMENSIONS,
  VECTOR_EMBEDDING_MODEL,
  VECTOR_EMBEDDING_MODEL_VERSION,
  VECTOR_EMBEDDING_PROVIDER,
  VectorMemoryError,
  type GeneratedCaseEmbedding,
  type GeneratableVectorEmbeddingKind,
} from './model';
import { sha256Hex } from './semantic-input';

export interface GenerateEmbeddingArgs {
  accountId: string;
  kind: GeneratableVectorEmbeddingKind;
  text: string;
  semanticInputVersion: string;
  /** Caller cancellation. Composed with the request timeout. */
  signal?: AbortSignal;
  /**
   * Correlation id for the usage log. The bounded generation operation
   * generates one id per run so a batch's spend can be traced back to
   * the run that caused it.
   */
  correlationId?: string;
}

export interface GenerateEmbeddingsArgs {
  accountId: string;
  kind: GeneratableVectorEmbeddingKind;
  /** Must be non-empty; each entry is embedded independently. */
  texts: readonly string[];
  semanticInputVersion: string;
  signal?: AbortSignal;
  correlationId?: string;
}

/**
 * Generate one embedding.
 *
 * Fails with `unavailable` when the account has no usable embeddings
 * key — a normal, supported state. Anthropic-only accounts land here
 * too, because Anthropic has no embeddings endpoint; that is reported
 * as "not configured for embeddings" rather than as a provider error,
 * because it is exactly that.
 */
export async function generateEmbedding(
  db: SupabaseClient,
  args: GenerateEmbeddingArgs
): Promise<GeneratedCaseEmbedding> {
  const [result] = await generateEmbeddings(db, {
    accountId: args.accountId,
    kind: args.kind,
    texts: [args.text],
    semanticInputVersion: args.semanticInputVersion,
    signal: args.signal,
    correlationId: args.correlationId,
  });
  if (!result) {
    throw new VectorMemoryError(
      'database_error',
      'The embedding provider returned no vector for a non-empty input'
    );
  }
  return result;
}

/**
 * Generate a batch of embeddings of one kind.
 *
 * Batching exists because the provider accepts an array, not because
 * this function wants to be clever: one request per bounded operation
 * is one round trip and one usage row.
 *
 * Usage is recorded in the existing `ai_usage_log` trail with mode
 * `embeddings`. Fire-and-forget: accounting must never be able to fail
 * a generation run, and `logAiUsage` already swallows its own write
 * errors.
 */
export async function generateEmbeddings(
  db: SupabaseClient,
  args: GenerateEmbeddingsArgs
): Promise<GeneratedCaseEmbedding[]> {
  if (args.texts.length === 0) return [];
  for (const text of args.texts) {
    if (typeof text !== 'string' || text.trim() === '') {
      throw new VectorMemoryError(
        'invalid_input',
        'Refusing to embed empty semantic input'
      );
    }
  }

  const { key, corrupt } = await loadEmbeddingsKey(db, args.accountId);
  if (!key) {
    throw new VectorMemoryError(
      'unavailable',
      corrupt
        ? 'The embeddings key for this account could not be decrypted. Re-enter it in Settings to enable vector memory.'
        : 'This account has no embeddings key configured. Add one in Settings to enable vector memory.'
    );
  }

  const { vectors, usage } = await embedTextsWithUsage(key, [...args.texts], {
    signal: args.signal,
  });

  if (vectors.length !== args.texts.length) {
    throw new VectorMemoryError(
      'database_error',
      'The embedding provider returned a different number of vectors than inputs'
    );
  }

  await recordUsage(db, args.accountId, usage, args.correlationId);

  return vectors.map((vector, index) => {
    assertDimensions(vector);
    return {
      kind: args.kind,
      vector,
      provider: VECTOR_EMBEDDING_PROVIDER,
      embedding_model: VECTOR_EMBEDDING_MODEL,
      model_version: VECTOR_EMBEDDING_MODEL_VERSION,
      dimensions: VECTOR_EMBEDDING_DIMENSIONS,
      content_hash: sha256Hex(args.texts[index] ?? ''),
      semantic_input_version: args.semanticInputVersion,
      usage,
    };
  });
}

/**
 * Native image embeddings: refused, with the reason.
 *
 * The refusal is a thrown typed error rather than a null, because
 * "returns nothing" and "this does not exist" are different answers and
 * a caller that treated them the same would eventually invent a
 * fallback. See `NATIVE_IMAGE_EMBEDDING_SUPPORT`.
 */
export async function generateNativeImageEmbedding(): Promise<never> {
  throw new VectorMemoryError('unsupported', NATIVE_IMAGE_EMBEDDING_SUPPORT.reason);
}

/**
 * Reject a vector whose length is not the registered dimension count.
 *
 * Without this, a provider that quietly changed its output width would
 * produce rows the database CHECK rejects — or, worse if the widths
 * happened to match a future column, rows in the wrong vector space.
 * Failing at generation time names the actual problem.
 */
function assertDimensions(vector: number[]): void {
  if (vector.length !== VECTOR_EMBEDDING_DIMENSIONS) {
    throw new VectorMemoryError(
      'database_error',
      `The embedding provider returned ${vector.length} dimensions; the registered model ${VECTOR_EMBEDDING_MODEL} produces ${VECTOR_EMBEDDING_DIMENSIONS}. Refusing to store a vector that does not match the registered compatibility group.`
    );
  }
}

async function recordUsage(
  db: SupabaseClient,
  accountId: string,
  usage: AiUsage | null,
  correlationId: string | undefined
): Promise<void> {
  if (!usage) return;
  if (correlationId) {
    // The correlation id is not a column on `ai_usage_log`, so it is
    // left to the run-scoped breadcrumb the operation writes. Adding a
    // column for it is the monitoring objective's decision, not this
    // one's.
    console.info(
      `[vector-memory] embedding run ${correlationId}: ${usage.totalTokens} tokens, model ${VECTOR_EMBEDDING_MODEL}`
    );
  }
  await logAiUsage(db, {
    accountId,
    // Vector memory belongs to a case, not to a conversation, and the
    // column is nullable precisely so a non-conversation spend can be
    // attributed to the account.
    conversationId: null,
    mode: 'embeddings',
    provider: VECTOR_EMBEDDING_PROVIDER,
    model: VECTOR_EMBEDDING_MODEL,
    usage,
  });
}
