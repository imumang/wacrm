/**
 * Objective 08 — the production `ImageAnalyzer` adapter.
 *
 * This module is the *only* place in WACRM that puts image bytes in front
 * of a model. It is deliberately thin and deliberately dumb: it owns the
 * provider wire format, the credential, and the timeout, and it does
 * almost no thinking. It does not validate, repair, default, or reshape
 * the model's answer — it hands the parsed provider JSON straight to the
 * caller, and `result.ts` decides whether that answer is acceptable.
 *
 * Provider choice: the two providers WACRM already supports
 * (`openai`, `anthropic`) with the account's *existing* decrypted BYO key
 * and its *configured* model. No new provider, no new dependency, no new
 * key column, and no second AI configuration system. The vision model is
 * therefore whatever the operator configured for chat; both shipped
 * defaults are vision-capable, and a model that is not will fail as an
 * ordinary, safe provider error rather than silently producing nothing.
 *
 * Properties this adapter guarantees:
 *
 * - It receives bytes and never a URL. Images are inlined as base64 data
 *   URIs / base64 blocks, so there is no fetch of a caller- or
 *   model-supplied location and therefore no SSRF surface here.
 * - It has no Supabase client, no storage client, and no account id. All
 *   scoping happened upstream in `media.ts`.
 * - It respects cancellation. The `signal` on the request is combined
 *   with a local deadline and both reach `fetch`.
 * - It never lets provider detail escape. Errors are rethrown as
 *   `AiError`; the tool layer converts them into a generic
 *   `unavailable`. The operator log gets the provider `code`/`status`
 *   only — never the response body, the request body, or the key.
 * - `id` is a constant. The tool records it in `analyzer_id`, so it must
 *   not leak a provider, a model version, or an endpoint.
 */

import { AiError, type AiConfig, type AiUsage } from '../types';
import {
  normalizeUsage,
  providerHttpError,
  toNetworkError,
} from '../providers/shared';
import {
  ANTHROPIC_API_VERSION,
  ANTHROPIC_MESSAGES_URL,
} from '../providers/anthropic';
import { OPENAI_CHAT_COMPLETIONS_URL } from '../providers/openai';
import { IMAGE_ANALYZER_TIMEOUT_MS, type SupportedImageMimeType } from './limits';
import {
  buildVisionSystemPrompt,
  buildVisionUserText,
  IMAGE_ANALYSIS_MAX_OUTPUT_TOKENS,
} from './vision-prompt';
import type {
  ImageAnalysisRequest,
  ImageAnalyzer,
} from './analyzer';

/**
 * Provider-neutral analyzer id recorded in `analyzer_id`. A constant by
 * design: the account's provider and model are configuration, and putting
 * either into a tool output would leak it into places that do not need it.
 */
export const VISION_ANALYZER_ID = 'configured_vision_model';

export interface VisionAnalyzerArgs {
  /** Decrypted per-account config; `provider`, `model`, `apiKey` are used. */
  config: AiConfig;
  /**
   * Called once per successful provider call with the normalized token
   * usage, so the caller can write it to `ai_usage_log`. Fire-and-forget
   * by contract: accounting must never fail the analysis. Called before
   * the result is returned, and also when the result later fails
   * validation, because the tokens were spent either way.
   */
  onUsage?: (usage: AiUsage) => void;
  /** Safe metadata for the operator log. Never receives content. */
  observability?: {
    accountId: string;
    conversationId: string | null;
    correlationId: string;
  };
  /** Overridable for tests. Defaults to `IMAGE_ANALYZER_TIMEOUT_MS`. */
  timeoutMs?: number;
}

interface OpenAiVisionResponse {
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface AnthropicVisionResponse {
  content?: { type?: string; text?: string }[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * Build a production vision analyzer from an account's AI configuration.
 *
 * Returns `null` when the provider is one WACRM does not support for
 * vision, so a caller cannot accidentally construct an adapter that would
 * guess at an endpoint.
 */
export function createVisionImageAnalyzer(
  args: VisionAnalyzerArgs
): ImageAnalyzer | null {
  const { config } = args;
  if (config.provider !== 'openai' && config.provider !== 'anthropic') {
    return null;
  }
  const model = config.model.trim();
  if (!model || !config.apiKey) return null;

  const timeoutMs = args.timeoutMs ?? IMAGE_ANALYZER_TIMEOUT_MS;
  const observability = args.observability;
  const onUsage = args.onUsage;

  return {
    id: VISION_ANALYZER_ID,
    async analyze(request: ImageAnalysisRequest): Promise<unknown> {
      if (request.images.length === 0) {
        throw new AiError('Image analysis received no images.', {
          code: 'no_images',
          status: 400,
        });
      }
      // Already cancelled: never spend the caller's tokens on it.
      if (request.signal?.aborted) {
        throw new AiError('Image analysis was cancelled.', {
          code: 'cancelled',
          status: 499,
        });
      }

      const startedAt = Date.now();
      const imageCount = request.images.length;
      const systemPrompt = buildVisionSystemPrompt();
      const userText = buildVisionUserText({
        imageCount,
        context: request.context,
      });

      try {
        const call =
          config.provider === 'openai'
            ? await callOpenAi({
                apiKey: config.apiKey,
                model,
                systemPrompt,
                userText,
                request,
                timeoutMs,
              })
            : await callAnthropic({
                apiKey: config.apiKey,
                model,
                systemPrompt,
                userText,
                request,
                timeoutMs,
              });

        if (call.usage) onUsage?.(call.usage);
        logVisionCall(observability, {
          provider: config.provider,
          model,
          image_count: imageCount,
          duration_ms: Date.now() - startedAt,
          outcome: 'success',
          prompt_tokens: call.usage?.promptTokens ?? 0,
          completion_tokens: call.usage?.completionTokens ?? 0,
          total_tokens: call.usage?.totalTokens ?? 0,
        });
        // The raw, unvalidated provider answer. Validation is the caller's
        // job and is deliberately not weakened here.
        return call.result;
      } catch (error) {
        const failure =
          error instanceof AiError
            ? error
            : toNetworkError(error);
        logVisionCall(observability, {
          provider: config.provider,
          model,
          image_count: imageCount,
          duration_ms: Date.now() - startedAt,
          outcome: 'error',
          // code/status only: the provider's message is not logged and not
          // returned, because it can echo request content.
          error_code: failure.code,
          error_status: failure.status,
        });
        throw failure;
      }
    },
  };
}

// ============================================================
// Provider wire formats
// ============================================================

interface VisionCallArgs {
  apiKey: string;
  model: string;
  systemPrompt: string;
  userText: string;
  request: ImageAnalysisRequest;
  timeoutMs: number;
}

interface VisionCall {
  result: unknown;
  usage: AiUsage | null;
}

/**
 * OpenAI Chat Completions with an inline image part per photograph.
 *
 * `response_format: json_object` is requested so the provider itself is
 * nudged toward JSON, but it is not trusted: the answer still goes to the
 * strict validator, and a `finish_reason` of `length` is treated as a
 * failure rather than parsed as a short document.
 */
async function callOpenAi(args: VisionCallArgs): Promise<VisionCall> {
  const content: unknown[] = [
    { type: 'text', text: args.userText },
    ...args.request.images.map((image) => ({
      type: 'image_url',
      image_url: { url: toDataUri(image.mime_type, image.bytes) },
    })),
  ];

  const deadline = withDeadline(args.request.signal, args.timeoutMs);
  let res: Response;
  try {
    res = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: args.model,
        messages: [
          { role: 'system', content: args.systemPrompt },
          { role: 'user', content },
        ],
        max_completion_tokens: IMAGE_ANALYSIS_MAX_OUTPUT_TOKENS,
        response_format: { type: 'json_object' },
      }),
      signal: deadline.signal,
    });
  } catch (err) {
    throw toNetworkError(err);
  } finally {
    deadline.dispose();
  }

  if (!res.ok) throw await providerHttpError('OpenAI', res);

  const data = (await res.json().catch(() => null)) as
    | OpenAiVisionResponse
    | null;
  const choice = data?.choices?.[0];
  if (choice?.finish_reason === 'length') {
    throw new AiError(
      'OpenAI truncated the image analysis before completing it.',
      { code: 'truncated_output' }
    );
  }
  const text = choice?.message?.content;
  if (!isUsableText(text)) {
    throw new AiError('OpenAI returned an empty image analysis.', {
      code: 'empty_response',
    });
  }
  return {
    result: parseProviderJson(text),
    usage: normalizeUsage({
      prompt: data?.usage?.prompt_tokens,
      completion: data?.usage?.completion_tokens,
      total: data?.usage?.total_tokens,
    }),
  };
}

/**
 * Anthropic Messages with one base64 image block per photograph.
 *
 * Anthropic has no JSON-mode equivalent, so the instruction to return a
 * bare JSON object lives in the system prompt and is backed here by the
 * same truncation guard and the same refusal to parse prose.
 */
async function callAnthropic(args: VisionCallArgs): Promise<VisionCall> {
  // One `image` block per photograph, each carrying its own media type, so
  // the ordinal the model sees matches the ordinal WACRM assigned.
  const content: unknown[] = args.request.images.map((image) => ({
    type: 'image',
    source: {
      type: 'base64',
      media_type: image.mime_type,
      data: toBase64(image.bytes),
    },
  }));
  content.push({ type: 'text', text: args.userText });

  const deadline = withDeadline(args.request.signal, args.timeoutMs);
  let res: Response;
  try {
    res = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: 'POST',
      headers: {
        'x-api-key': args.apiKey,
        'anthropic-version': ANTHROPIC_API_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: args.model,
        system: args.systemPrompt,
        max_tokens: IMAGE_ANALYSIS_MAX_OUTPUT_TOKENS,
        messages: [{ role: 'user', content }],
      }),
      signal: deadline.signal,
    });
  } catch (err) {
    throw toNetworkError(err);
  } finally {
    deadline.dispose();
  }

  if (!res.ok) throw await providerHttpError('Anthropic', res);

  const data = (await res.json().catch(() => null)) as
    | AnthropicVisionResponse
    | null;
  if (data?.stop_reason === 'max_tokens') {
    throw new AiError(
      'Anthropic truncated the image analysis before completing it.',
      { code: 'truncated_output' }
    );
  }
  const text = data?.content
    ?.filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim();
  if (!isUsableText(text)) {
    throw new AiError('Anthropic returned an empty image analysis.', {
      code: 'empty_response',
    });
  }
  // Anthropic reports input/output but no total — normalizeUsage sums.
  return {
    result: parseProviderJson(text),
    usage: normalizeUsage({
      prompt: data?.usage?.input_tokens,
      completion: data?.usage?.output_tokens,
    }),
  };
}

// ============================================================
// Small helpers
// ============================================================

/**
 * Decode the provider's JSON answer.
 *
 * Only two accommodations are made, both purely lexical: surrounding
 * whitespace, and a single wrapping ``` / ```json code fence, because
 * models emit one despite being told not to. Nothing is coerced, defaulted,
 * key-renamed, or dropped — an unknown key or an out-of-range number still
 * reaches `parseImageAnalysisResult` and is rejected there.
 */
export function parseProviderJson(text: string): unknown {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (fenced?.[1]) candidates.push(fenced[1]);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Try the next lexical form.
    }
  }
  throw new AiError('Vision provider output was not valid JSON.', {
    code: 'invalid_json',
  });
}

function isUsableText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function toBase64(bytes: Uint8Array | undefined): string {
  return Buffer.from(bytes ?? new Uint8Array()).toString('base64');
}

function toDataUri(
  mimeType: SupportedImageMimeType,
  bytes: Uint8Array
): string {
  return `data:${mimeType};base64,${toBase64(bytes)}`;
}

/**
 * One signal that aborts on caller cancellation, on the local deadline, or
 * on both. Written out rather than using `AbortSignal.any` so the adapter
 * does not depend on the runtime providing it, and so the timer and the
 * listener are removed deterministically when the call finishes — a
 * leftover timer would keep a Node process alive for nothing.
 */
function withDeadline(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort();

  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    },
  };
}

/**
 * Structured, safe observability for one vision call.
 *
 * Deliberately absent: image bytes, customer message text, enquiry facts,
 * storage paths, signed URLs, the API key, and the provider's own error
 * message. This is the same discipline `media.ts` and `audit.ts` apply —
 * the point is to reconstruct what ran, not what the customer wrote.
 */
function logVisionCall(
  observability: VisionAnalyzerArgs['observability'],
  fields: Record<string, string | number | boolean | null>
): void {
  if (!observability) return;
  console.info('[ai image-analysis] vision call', {
    account_id: observability.accountId,
    conversation_id: observability.conversationId,
    correlation_id: observability.correlationId,
    ...fields,
  });
}