import { AiError, type AiUsage } from './types'
import { aiRequestTimeoutMs } from './defaults'
import { providerHttpError, toNetworkError } from './providers/shared'
import { getT } from '@/lib/i18n/translate'

const t = getT('LibErrors')

// ============================================================
// Embeddings (OpenAI-compatible).
//
// Used for the knowledge base's optional semantic-search path: embed
// each chunk at ingest, and embed the query at retrieval. Anthropic has
// no embeddings endpoint, so this is always OpenAI's — the account
// supplies a (possibly separate) embeddings key. 1536-dim
// text-embedding-3-small matches the `vector(1536)` column in
// migration 030.
// ============================================================

const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings'

export const EMBEDDING_MODEL = 'text-embedding-3-small'
export const EMBEDDING_DIMENSIONS = 1536

// OpenAI accepts an array input; keep batches modest so a big re-index
// stays under request-size limits and partial failures are cheap.
const BATCH_SIZE = 96

interface EmbeddingResponse {
  data?: { embedding?: number[]; index?: number }[]
  usage?: { prompt_tokens?: unknown; total_tokens?: unknown }
}

export interface EmbedTextsOptions {
  /**
   * Caller-side cancellation, composed with the request timeout.
   *
   * A bounded embedding operation (objective 03's backfill) must be
   * able to stop when an operator closes the request, without waiting
   * out the full timeout on a batch that is already unwanted.
   */
  signal?: AbortSignal
}

/**
 * One embedding result plus whatever cost metadata the provider gave
 * back.
 *
 * The usage block is returned rather than discarded because objective
 * 03 records embedding spend in the existing `ai_usage_log` trail.
 * `usage` is null when the provider reported nothing usable, which
 * `logAiUsage` already knows how to skip.
 */
export interface EmbedTextsResult {
  vectors: number[][]
  usage: AiUsage | null
}

/** Format a vector for a pgvector column / RPC param: `[0.1,0.2,...]`.
 *  PostgREST casts this text literal to `vector`; a raw JS array does
 *  not cast reliably. */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`
}

/**
 * Compose the per-request timeout with an optional caller signal.
 *
 * Prefers `AbortSignal.any` and falls back to the timeout alone on a
 * runtime that lacks it, which keeps this a timeout rather than an
 * unhandled rejection on older Node builds.
 */
function requestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (!signal) return timeout
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([timeout, signal])
  }
  return timeout
}

/**
 * Embed a list of strings, preserving input order. Batched; throws
 * `AiError` on provider/network failure so callers can decide whether
 * to degrade (retrieval) or surface (ingest).
 */
export async function embedTexts(
  apiKey: string,
  inputs: string[],
): Promise<number[][]> {
  return (await embedTextsWithUsage(apiKey, inputs)).vectors
}

/**
 * `embedTexts` plus the provider's usage block.
 *
 * The same single provider path the knowledge base already uses. This
 * objective adds accounting and cancellation to it, not a second
 * embedding client: there is exactly one embeddings endpoint, one key
 * (`ai_configs.embeddings_api_key`) and one request shape in WACRM.
 */
export async function embedTextsWithUsage(
  apiKey: string,
  inputs: string[],
  options: EmbedTextsOptions = {},
): Promise<EmbedTextsResult> {
  if (inputs.length === 0) return { vectors: [], usage: null }
  const timeoutMs = aiRequestTimeoutMs()
  const out: number[][] = []
  let promptTokens = 0
  let totalTokens = 0

  for (let start = 0; start < inputs.length; start += BATCH_SIZE) {
    const batch = inputs.slice(start, start + BATCH_SIZE)

    let res: Response
    try {
      res = await fetch(OPENAI_EMBEDDINGS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: EMBEDDING_MODEL, input: batch }),
        signal: requestSignal(timeoutMs, options.signal),
      })
    } catch (err) {
      throw toNetworkError(err)
    }

    if (!res.ok) {
      throw await providerHttpError('OpenAI embeddings', res)
    }

    const data = (await res.json().catch(() => null)) as EmbeddingResponse | null
    const rows = data?.data
    if (!rows || rows.length !== batch.length) {
      throw new AiError(t('ai.embeddingsMalformed'), {
        code: 'embeddings_malformed',
      })
    }

    // Sort by index so order matches the input batch regardless of how
    // the provider returns them. Require a real numeric index — defaulting
    // a missing one to 0 would silently misalign chunks with their
    // vectors (chunk N gets chunk M's embedding), so fail loud instead.
    if (rows.some((r) => typeof r.index !== 'number')) {
      throw new AiError(t('ai.embeddingsMissingIndices'), {
        code: 'embeddings_malformed',
      })
    }
    const ordered = [...rows].sort((a, b) => a.index! - b.index!)
    for (const r of ordered) {
      if (!Array.isArray(r.embedding)) {
        throw new AiError(t('ai.embeddingsMissingVector'), {
          code: 'embeddings_malformed',
        })
      }
      out.push(r.embedding)
    }

    // Embeddings spend real money on the account's own key, so the
    // usage block is accumulated across batches rather than kept from
    // the last response only. Tolerant of partial/absent counts for the
    // same reason `normalizeUsage` is.
    promptTokens += nonNegativeInt(data?.usage?.prompt_tokens)
    totalTokens += nonNegativeInt(data?.usage?.total_tokens)
  }

  const usage: AiUsage | null =
    promptTokens === 0 && totalTokens === 0
      ? null
      : {
          promptTokens,
          // An embeddings response has no completion half. Reporting 0
          // rather than prompt+completion keeps `total` equal to what
          // the provider actually billed.
          completionTokens: 0,
          totalTokens,
        }

  return { vectors: out, usage }
}

function nonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0
}
