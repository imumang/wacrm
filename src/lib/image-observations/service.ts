/**
 * The image-observation service.
 *
 * Two capabilities, and the reasoning behind both:
 *
 *  1. `recordValidatedImageAnalysis` — persist a VALIDATED
 *     `analyze_images` output as a canonical, source-traceable,
 *     per-image record. Idempotent on the analysis request's content.
 *
 *  2. `recordImageAnalysisFailure` — record that an analysis produced
 *     nothing usable, for observability, with a safe closed-vocabulary
 *     reason and no provider output.
 *
 * Deliberately absent, and belonging to later objectives: similarity
 * search, ranking, weights, quote calculation, confidence, and any
 * automatic invocation. Nothing here runs on its own.
 *
 * ## Why persistence is NOT inside `analyze_images`
 *
 * `analyze_images` is produced by `defineReadTool`, so it is
 * `access: 'read'` with `side_effects: 'none'`. That is not a
 * convention: it is the guarantee that the AI layer cannot write to the
 * business, it is what the tool registry asserts, and it is what makes
 * the read-tool audit trail meaningful (a metadata-only row per
 * invocation, with no input, no output, no media reference and no
 * image content). Writing an observation from inside the tool would
 * turn a read into a writer and put a database write on a path whose
 * entire safety argument is that it has none.
 *
 * So this is pattern (A) from the design brief: the analyzer and the
 * tool produce a validated result, and a SEPARATE, EXPLICIT service
 * persists it. The caller — a future orchestrator (objective 16) or an
 * operator action — decides to keep an analysis. Nothing keeps one
 * automatically, and no image is ever analysed without an explicit
 * request.
 *
 * It also keeps the paid call and the write separately auditable. The
 * `ai_tool_call_audit` row and the `ai_usage_log` row describe the call;
 * the canonical run describes what WACRM decided to KEEP. Collapsing
 * them would make the record of what was observed only as durable as
 * the decision to observe it.
 *
 * The reads a consumer needs — `getAnalysisForMedia`,
 * `listImageAnalysisRunsForCase`, `getCurrentAnalysis` — live in
 * `repository.ts` and are re-exported from this module's `index.ts`
 * alongside the writes, rather than wrapped here. A wrapper that adds
 * no check is a place for a check to be forgotten.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  IMAGE_ANALYSIS_SCHEMA_VERSION,
  VISION_PROMPT_VERSION,
} from '@/lib/ai/image-analysis';
import type {
  AnalyzeImagesOutput,
  AnalyzedImageRef,
} from '@/lib/ai/tools/analyze-images';

import {
  ImageObservationError,
  projectCanonicalImageAnalysis,
  type CanonicalImageAnalysis,
  type ImageAnalysisFailureReason,
  type ImageAnalysisMediaCandidate,
  type ImageAnalysisRun,
  type ImageAnalysisRunStatus,
} from './model';
import {
  recordFailedImageAnalysis,
  recordImageAnalysis,
  supersedeImageAnalysisRun,
  type RecordImageAnalysisResult,
} from './repository';

// Re-exported so a caller has ONE import surface for the domain while
// the implementation stays in the repository layer. Re-export rather
// than wrap: a wrapper that adds no check is a place for a check to be
// forgotten.
export { supersedeImageAnalysisRun };

export interface RecordValidatedImageAnalysisArgs {
  accountId: string;
  /**
   * The `analyze_images` OUTPUT, never the raw provider answer.
   *
   * Typed as the tool's own output on purpose: this service may only be
   * handed something that already passed `parseImageAnalysisResult`. It
   * cannot validate a provider answer, and does not need to — that is the
   * tool's job and the tool already did it. The consequence is that there
   * is no code path here by which unvalidated model output reaches
   * storage.
   */
  output: AnalyzeImagesOutput;
  /** The account's configured provider. Version metadata, not a secret. */
  provider: string;
  /** The account's configured model. Version metadata, not a secret. */
  model: string;
  /**
   * The canonical `messages` rows the analysed media came from.
   *
   * Required because an `AnalyzedImageRef` carries no message timestamp,
   * and the per-image record needs one. Taking the message ROWS rather
   * than a timestamp means the caller cannot assert it.
   */
  candidates: readonly ImageAnalysisMediaCandidate[];
  historicalCaseId?: string | null;
  correlationId?: string | null;
  startedAt?: string;
  completedAt?: string;
}

/**
 * Persist a validated analysis, idempotently.
 *
 * Idempotency is by CONTENT, not by "have I seen this before": the
 * request fingerprint is a hash over the analysed media's canonical
 * identities plus the analyzer, provider, model, observation schema and
 * prompt version. So:
 *
 *   - the same media under the same model is the same request, and
 *     recording it twice is a no-op that returns the first run;
 *   - the same media under a DIFFERENT model, a different observation
 *     schema, or a different prompt is a DIFFERENT request and gets its
 *     own run — which is what makes a deliberate re-analysis
 *     representable rather than an overwrite;
 *   - the same visual content arriving in two different messages is two
 *     requests, because they are two different source photographs as far
 *     as WACRM is concerned.
 *
 * Deterministic identity only. Two visually similar photographs are never
 * treated as duplicates: that needs perceptual comparison and a business
 * decision about item identity, and this objective has neither.
 */
export async function recordValidatedImageAnalysis(
  db: SupabaseClient,
  args: RecordValidatedImageAnalysisArgs
): Promise<RecordImageAnalysisResult> {
  const analysis = projectCanonicalImageAnalysis({
    conversation_id: args.output.conversation_id,
    enquiry_id: args.output.enquiry_id,
    historical_case_id: args.historicalCaseId ?? null,
    analyzer_id: args.output.analyzer_id,
    provider: args.provider,
    model: args.model,
    analysis_schema_version: IMAGE_ANALYSIS_SCHEMA_VERSION,
    prompt_version: VISION_PROMPT_VERSION,
    correlation_id: args.correlationId ?? null,
    images: toAnalyzerImages(args.output.images),
    candidates: args.candidates,
    result: {
      observations: args.output.observations,
      ambiguous_items: args.output.ambiguous_items,
      image_quality: args.output.image_quality,
      estimated_volume_range: args.output.estimated_volume_range,
      need_more_photos: args.output.need_more_photos,
      follow_up_questions: args.output.follow_up_questions,
      notes: args.output.notes,
    },
  });
  assertAnalysisIsConsistent(analysis, args.output);

  return recordImageAnalysis(db, {
    accountId: args.accountId,
    analysis,
    startedAt: args.startedAt,
    completedAt: args.completedAt,
  });
}

/**
 * Record that an analysis produced nothing usable.
 *
 * For observability, not for evidence. The row carries a
 * closed-vocabulary reason, an image count, and NO result hash — and the
 * database refuses an observation under any status but `succeeded`, so a
 * failure cannot become a learning record even by accident.
 *
 * The reason is a closed token derived by
 * `imageAnalysisFailureReason` from the tool's own error code, so the
 * provider's message never reaches durable storage.
 */
export async function recordImageAnalysisFailure(
  db: SupabaseClient,
  args: {
    accountId: string;
    conversationId: string;
    enquiryId?: string | null;
    historicalCaseId?: string | null;
    analyzerId: string;
    provider: string;
    model: string;
    imageCount?: number;
    correlationId?: string | null;
    failureReason: ImageAnalysisFailureReason;
    status: Exclude<ImageAnalysisRunStatus, 'succeeded'>;
    startedAt?: string;
    completedAt?: string;
  }
): Promise<ImageAnalysisRun> {
  return recordFailedImageAnalysis(db, {
    accountId: args.accountId,
    conversationId: args.conversationId,
    enquiryId: args.enquiryId,
    historicalCaseId: args.historicalCaseId,
    analyzerId: args.analyzerId,
    provider: args.provider,
    model: args.model,
    analysisSchemaVersion: IMAGE_ANALYSIS_SCHEMA_VERSION,
    promptVersion: VISION_PROMPT_VERSION,
    status: args.status,
    failureReason: args.failureReason,
    imageCount: args.imageCount,
    correlationId: args.correlationId,
    startedAt: args.startedAt,
    completedAt: args.completedAt,
  });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Reconstruct the analyzer-image shape the projection expects.
 *
 * Note what is NOT here: image bytes. The projection reads only the
 * canonical source refs and the verified metadata, so an
 * `AnalyzedImageRef` — which deliberately carries no image content — is
 * sufficient. That is what keeps this service from holding a customer's
 * photograph in memory while recording what was said about it.
 */
function toAnalyzerImages(
  images: readonly AnalyzedImageRef[]
): Array<{
  source: { ordinal: number; source_message_id: string; source_media_id: string };
  mime_type: AnalyzedImageRef['mime_type'];
  byte_length: number;
  bytes: Uint8Array;
}> {
  return images.map((image) => ({
    source: {
      ordinal: image.ordinal,
      source_message_id: image.source_message_id,
      source_media_id: image.source_media_id,
    },
    mime_type: image.mime_type,
    byte_length: image.byte_length,
    // Never read. A single shared empty buffer is used precisely because
    // it cannot be mistaken for image content: the projection has no code
    // path that touches it.
    bytes: EMPTY_BYTES,
  }));
}

const EMPTY_BYTES = new Uint8Array(0);

/**
 * Cross-check the output against itself.
 *
 * `parseImageAnalysisResult` already guarantees every observation
 * references an ordinal inside the analysed set, so this is
 * belt-and-braces. It exists because the alternative failure is silent:
 * an observation attributed to a photograph it did not come from is not
 * a crash, it is a wrong answer a future retrieval layer would present
 * as evidence.
 */
function assertAnalysisIsConsistent(
  analysis: CanonicalImageAnalysis,
  output: AnalyzeImagesOutput
): void {
  if (analysis.images.length !== output.images.length) {
    throw new ImageObservationError(
      'invalid_input',
      'The analysis and its image list disagree about how many images were analysed'
    );
  }
  const unattributed = analysis.findings.filter(
    (finding) => finding.source_ordinals.length === 0
  );
  if (unattributed.length > 0) {
    throw new ImageObservationError(
      'invalid_input',
      'An observation could not be attributed to a source image'
    );
  }
}