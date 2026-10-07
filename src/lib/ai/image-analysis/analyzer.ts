/**
 * Objective 08 — the provider-neutral image analyzer boundary.
 *
 * `ImageAnalyzer` is the only seam a future vision provider has to
 * implement. It receives already-retrieved bytes and a small, explicitly
 * labelled slice of enquiry context, and returns an untyped value that
 * `result.ts` validates into the WACRM observation schema.
 *
 * Deliberate properties of this boundary:
 *
 * - No provider SDK, model name, prompt, or API key appears here. A
 *   provider adapter is a separate module that owns all of that, so the
 *   business layer stays usable without a vision provider installed.
 * - The analyzer is never given storage credentials, a Supabase client, or
 *   a URL. It gets bytes. It cannot fetch anything itself, which is what
 *   removes the SSRF surface from the provider side entirely.
 * - The return type is `unknown`. A provider is not trusted to have
 *   produced a valid observation set; validation is a separate, tested
 *   step, and an invalid response is a first-class error.
 * - Supplied enquiry context is passed separately from the images and is
 *   tagged `origin: 'customer_statement'`. It is what the customer said,
 *   not what a photograph shows, and the schema keeps the two apart.
 *
 * `getConfiguredImageAnalyzer()` resolves the analyzer **per account**,
 * because WACRM's provider, model, and credential all live on the
 * account's own `ai_configs` row. There is no deployment-wide analyzer and
 * no ambient credential: an account with no usable AI configuration gets
 * `null`, which is a supported, safe production state — the tool reports
 * `unavailable` before reading any media and no observation is invented.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { ToolError } from '@/lib/ai/tools/contract';
import { loadAiConfig } from '../config';
import { logAiUsage } from '../usage';
import { createVisionImageAnalyzer } from './vision-analyzer';
import type { SupportedImageMimeType } from './limits';

/**
 * Canonical, non-secret pointer back to the WACRM records an image came
 * from: the message row and the account-scoped storage object path
 * (`account-<id>/inbound/…`). Both are what an operator needs, and neither
 * is a credential — the `chat-media` bucket is public by design
 * (migration 023) and no signed or temporary URL is ever produced here.
 */
export interface ImageSourceRef {
  /** 1-based position in the analysis request. Providers reference images by this. */
  ordinal: number;
  source_message_id: string;
  source_media_id: string;
}

export interface AnalyzerImage {
  source: ImageSourceRef;
  mime_type: SupportedImageMimeType;
  byte_length: number;
  /** Raw image bytes. Never serialised into tool output, audit, or logs. */
  bytes: Uint8Array;
}

/**
 * Enquiry facts as the customer stated them.
 *
 * Passed for disambiguation only. A provider must not turn a stated fact
 * into a visual observation, and must not infer a property, floor, or
 * access detail that no photograph shows.
 */
export interface ImageAnalysisContext {
  origin: 'customer_statement';
  enquiry_id: string;
  item_descriptions: readonly string[];
  waste_type: string | null;
  estimated_volume: string | null;
  heavy_special_items: readonly string[];
  access_constraints: readonly string[];
  property_type: string | null;
  floor: string | null;
  lift_available: boolean | null;
  parking: string | null;
}

export interface ImageAnalysisRequest {
  images: readonly AnalyzerImage[];
  /** `null` when the caller opted out of context. */
  context: ImageAnalysisContext | null;
  signal?: AbortSignal;
}

export interface ImageAnalyzer {
  /**
   * Stable, provider-neutral identifier recorded in the tool output. It
   * must not contain a model version, endpoint, or any credential.
   */
  readonly id: string;
  analyze(request: ImageAnalysisRequest): Promise<unknown>;
}

/**
 * What the production resolver needs in order to build an analyzer.
 *
 * Every field is server-side trusted state. `db` is the caller's own
 * client — never a service-role client this module constructs — and
 * `account_id` came from the tool execution context, not from model
 * input. `conversation_id` is used only to attribute token spend and is
 * only supplied after the tool has verified the conversation belongs to
 * this account.
 */
export interface ImageAnalyzerResolverArgs {
  db: SupabaseClient;
  account_id: string;
  conversation_id: string | null;
  correlation_id: string;
  signal?: AbortSignal;
}

export type ImageAnalyzerResolver = (
  args: ImageAnalyzerResolverArgs
) => Promise<ImageAnalyzer | null>;

/**
 * The configured production analyzer for one account, or `null`.
 *
 * Resolution reuses the existing per-account AI configuration: the same
 * `ai_configs` row, the same decrypted BYO key, the same provider and
 * model, and the same `is_active` master switch as draft and auto-reply.
 * There is no second key column, no second settings screen, and no
 * deployment-wide default that could quietly analyse a customer's photos
 * with somebody else's credential.
 *
 * Returning `null` is a normal, safe outcome and covers: no `ai_configs`
 * row, AI switched off for the account, no stored key, an undecryptable
 * key (logged, never surfaced), and a provider WACRM does not support for
 * vision. In every one of those cases `analyze_images` fails with a
 * structured, non-retryable `unavailable` before any media is read.
 *
 * A configuration read that fails for a transient reason is reported
 * differently — a retryable `unavailable` — so "the account has no AI
 * setup" and "the database hiccupped" stay distinguishable.
 */
export async function getConfiguredImageAnalyzer(
  args: ImageAnalyzerResolverArgs
): Promise<ImageAnalyzer | null> {
  let config;
  try {
    config = await loadAiConfig(args.db, args.account_id);
  } catch {
    // Deliberately does not log the underlying error: it can carry schema
    // or connection detail. Mirrors the breadcrumbs left by
    // `loadAiConfig` / `loadEmbeddingsKey` for a mis-set ENCRYPTION_KEY.
    console.error(
      '[image-analysis] account AI configuration could not be read — image analysis is unavailable for this account.',
      { account_id: args.account_id, correlation_id: args.correlation_id },
    );
    throw new ToolError(
      'unavailable',
      'Image analysis configuration could not be read',
      { retryable: true },
    );
  }
  if (!config) return null;

  return createVisionImageAnalyzer({
    config,
    observability: {
      accountId: args.account_id,
      conversationId: args.conversation_id,
      correlationId: args.correlation_id,
    },
    // Fire-and-forget: token accounting must never be able to fail an
    // analysis, and `logAiUsage` swallows its own write errors. The mode
    // is `image_analysis`, widened onto `ai_usage_log.mode` by migration
    // 048 so vision spend lands in the existing cost trail.
    onUsage: (usage) => {
      void logAiUsage(args.db, {
        accountId: args.account_id,
        conversationId: args.conversation_id,
        mode: 'image_analysis',
        provider: config.provider,
        model: config.model,
        usage,
      });
    },
  });
}
