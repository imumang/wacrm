import type { SupabaseClient } from '@supabase/supabase-js';

import {
  ANALYZE_IMAGES_DEFAULT_IMAGE_COUNT,
  IMAGE_ANALYSIS_LIMITS,
  IMAGE_ANALYZER_TIMEOUT_MS,
  getConfiguredImageAnalyzer,
  parseImageAnalysisResult,
  resolveAnalysisImages,
  createSupabaseStorageMediaLoader,
  ImageAnalysisValidationError,
  type AmbiguousImageItem,
  type AnalysisMediaCandidate,
  type AnalysisMediaClient,
  type AnalysisMediaLoader,
  type AnalyzerImage,
  type DuplicateMediaReference,
  type ImageAnalysisContext,
  type ImageAnalysisResult,
  type ImageAnalyzer,
  type ImageAnalyzerResolver,
  type ImageObservation,
  type ImageQualityObservation,
  type ImageSourceRef,
  type RelativeVolumeRange,
  type SupportedImageMimeType,
} from '@/lib/ai/image-analysis';
import {
  defineReadTool,
  ToolError,
  type ReadBusinessTool,
  type ToolExecutionContext,
} from './contract';
import { isRecord, loadActiveEnquiry, parseRequiredId } from './shared';

export interface AnalyzeImagesInput {
  conversation_id: string;
  /** Explicit WACRM message ids. Never a URL, path, or provider media id. */
  message_ids?: string[];
  /** Newest images to use when `message_ids` is omitted. */
  image_limit?: number;
  /** Defaults to true. Pass-through of customer-stated enquiry facts. */
  include_context?: boolean;
}

export interface AnalyzedImageRef {
  ordinal: number;
  source_message_id: string;
  source_media_id: string;
  mime_type: SupportedImageMimeType;
  byte_length: number;
  direction: 'inbound' | 'outbound';
  content_type: string;
  created_at: string;
}

export interface AnalyzeImagesOutput {
  conversation_id: string;
  enquiry_id: string | null;
  /** Provider-neutral identifier of the analyzer that produced this. */
  analyzer_id: string;
  images: readonly AnalyzedImageRef[];
  duplicate_media_references: readonly DuplicateMediaReference[];
  observations: readonly ImageObservation[];
  ambiguous_items: readonly AmbiguousImageItem[];
  image_quality: readonly ImageQualityObservation[];
  estimated_volume_range: RelativeVolumeRange | null;
  need_more_photos: boolean;
  follow_up_questions: readonly string[];
  notes: readonly string[];
  /** Customer-stated facts, kept separate from everything observed. */
  supplied_context: ImageAnalysisContext | null;
  uncertainty: {
    has_ambiguous_items: boolean;
    has_image_quality_issues: boolean;
    volume_range_observed: boolean;
    lowest_observation_confidence: number | null;
    /** Duplicate removal is exact-match only; see the module comment. */
    visual_deduplication: 'identical_media_object_only';
    possible_duplicate_photos: boolean;
  };
  /**
   * Stated as data so a consumer cannot mistake an observation for a
   * price. There is no price field anywhere in this schema.
   */
  guarantees: {
    price_calculated: false;
    weight_estimated: false;
    hidden_details_inferred: false;
  };
  limits: {
    max_images: number;
    max_bytes_per_image: number;
    max_total_bytes: number;
    supported_mime_types: readonly string[];
  };
  context_window: {
    image_limit: number;
    selected_images: number;
    has_earlier_images: boolean;
  };
  freshness: {
    source: 'wacrm';
    retrieved_at: string;
  };
}

export interface AnalyzeImagesDependencies {
  /**
   * A fixed analyzer, for tests and for callers that already hold one.
   * `null` means "none configured" and the tool fails with `unavailable`
   * before reading any media.
   */
  analyzer?: ImageAnalyzer | null;
  /**
   * Production path: resolve the analyzer for the calling account. Takes
   * precedence over `analyzer`, because WACRM's provider, model, and key
   * are per account and cannot be baked into a module singleton.
   */
  resolveAnalyzer?: ImageAnalyzerResolver;
  mediaLoader: AnalysisMediaLoader;
  /** Injectable for tests. Defaults to `IMAGE_ANALYZER_TIMEOUT_MS`. */
  analyzerTimeoutMs?: number;
}

const MESSAGE_COLUMNS = [
  'id',
  'conversation_id',
  'sender_type',
  'content_type',
  'media_url',
  'media_type',
  'created_at',
].join(',');

const ALLOWED_INPUT_KEYS = new Set([
  'conversation_id',
  'message_ids',
  'image_limit',
  'include_context',
]);

interface MessageRow {
  id: string;
  conversation_id: string;
  sender_type: string;
  content_type: string;
  media_url: string | null;
  media_type: string | null;
  created_at: string;
}

interface ParsedInput {
  conversation_id: string;
  message_ids: string[] | null;
  image_limit: number;
  include_context: boolean;
}

/**
 * `analyze_images` — the Objective 08 read tool.
 *
 * Reads customer-uploaded images from canonical WACRM records, hands the
 * bytes to an injected provider-neutral analyzer, and returns validated
 * structured observations. It never calculates a price, never estimates a
 * weight, and never infers a property or access detail that no photograph
 * shows.
 */
export function createAnalyzeImagesTool(
  dependencies: AnalyzeImagesDependencies
): ReadBusinessTool<AnalyzeImagesInput, AnalyzeImagesOutput> {
  const analyzerTimeoutMs =
    dependencies.analyzerTimeoutMs ?? IMAGE_ANALYZER_TIMEOUT_MS;

  return defineReadTool<AnalyzeImagesInput, AnalyzeImagesOutput>(
    'analyze_images',
    async (context, rawInput) => {
      const input = parseInput(rawInput);

      // An explicitly injected absence fails immediately: with no provider
      // there is nothing honest to return, and downloading customer
      // photographs would be pointless work.
      if (!dependencies.resolveAnalyzer && !dependencies.analyzer) {
        throw new ToolError(
          'unavailable',
          'Image analysis is not configured for this deployment',
          { retryable: false }
        );
      }

      const conversation = await loadConversation(
        context.db,
        context.account_id,
        input.conversation_id
      );
      if (!conversation) {
        // Unknown and foreign conversation ids collapse to one result, so
        // this cannot be used to probe another account.
        throw new ToolError('not_found', 'Conversation not found');
      }

      // Resolved after the account-scoped conversation check and before any
      // media read, so an unconfigured account never causes a download —
      // and `conversation_id` is only forwarded once it is known to belong
      // to this account.
      const analyzer = await resolveAnalyzer(dependencies, context, {
        conversation_id: conversation.id,
      });
      if (!analyzer) {
        throw new ToolError(
          'unavailable',
          'Image analysis is not configured for this deployment',
          { retryable: false }
        );
      }

      const { candidates, hasEarlier } = await loadCandidateMessages(
        context.db,
        conversation.id,
        input
      );
      if (candidates.length === 0) {
        throw new ToolError(
          'invalid_input',
          'No image media was found for this conversation'
        );
      }

      const enquiry = input.include_context
        ? await loadActiveEnquiry(
            context.db,
            context.account_id,
            conversation.id
          )
        : null;
      const analysisContext = enquiry ? toAnalysisContext(enquiry) : null;

      const { images, duplicates } = await resolveAnalysisImages({
        // The caller's client already carries the storage namespace. No
        // client and no credential is constructed here.
        client: context.db as unknown as AnalysisMediaClient,
        account_id: context.account_id,
        candidates,
        loader: dependencies.mediaLoader,
        signal: context.signal,
      });
      if (images.length === 0) {
        throw new ToolError(
          'invalid_input',
          'No image media was found for this conversation'
        );
      }

      const raw = await runAnalyzer(
        analyzer,
        {
          images: images.map((image): AnalyzerImage => ({
            source: image.source,
            mime_type: image.mime_type,
            byte_length: image.byte_length,
            bytes: image.bytes,
          })),
          context: analysisContext,
        },
        analyzerTimeoutMs,
        context.signal
      );

      const result = validateResult(
        raw,
        images.map((image) => image.source)
      );

      return {
        conversation_id: conversation.id,
        enquiry_id: analysisContext?.enquiry_id ?? null,
        analyzer_id: analyzer.id,
        images: images.map((image) => ({
          ordinal: image.source.ordinal,
          source_message_id: image.source.source_message_id,
          source_media_id: image.source.source_media_id,
          mime_type: image.mime_type,
          byte_length: image.byte_length,
          direction: image.direction,
          content_type: image.content_type,
          created_at: image.created_at,
        })),
        duplicate_media_references: duplicates,
        observations: result.observations,
        ambiguous_items: result.ambiguous_items,
        image_quality: result.image_quality,
        estimated_volume_range: result.estimated_volume_range,
        need_more_photos: result.need_more_photos,
        follow_up_questions: result.follow_up_questions,
        notes: result.notes,
        supplied_context: analysisContext,
        uncertainty: {
          has_ambiguous_items: result.ambiguous_items.length > 0,
          has_image_quality_issues: result.image_quality.length > 0,
          volume_range_observed: result.estimated_volume_range !== null,
          lowest_observation_confidence: lowestConfidence(result),
          visual_deduplication: 'identical_media_object_only',
          possible_duplicate_photos: images.length > 1,
        },
        guarantees: {
          price_calculated: false,
          weight_estimated: false,
          hidden_details_inferred: false,
        },
        limits: {
          max_images: IMAGE_ANALYSIS_LIMITS.max_images,
          max_bytes_per_image: IMAGE_ANALYSIS_LIMITS.max_bytes_per_image,
          max_total_bytes: IMAGE_ANALYSIS_LIMITS.max_total_bytes,
          supported_mime_types: IMAGE_ANALYSIS_LIMITS.supported_mime_types,
        },
        context_window: {
          image_limit: input.image_limit,
          selected_images: images.length,
          has_earlier_images: hasEarlier,
        },
        freshness: {
          source: 'wacrm',
          retrieved_at: new Date().toISOString(),
        },
      };
    }
  );
}

/**
 * The registry instance. It uses the production media loader and resolves
 * the analyzer per account from that account's own AI configuration. An
 * account with no usable configuration gets a structured `unavailable`
 * result instead of a fabricated analysis.
 */
export const analyzeImagesTool = createAnalyzeImagesTool({
  resolveAnalyzer: getConfiguredImageAnalyzer,
  mediaLoader: createSupabaseStorageMediaLoader(),
});

/**
 * Resolve the analyzer for this call.
 *
 * The injected-analyzer form stays synchronous and side-effect free, so
 * tests keep a fast, offline path. The production resolver is async and
 * reads the account's own `ai_configs` row through the caller's client;
 * it never constructs a client and never reaches for a credential.
 */
async function resolveAnalyzer(
  dependencies: AnalyzeImagesDependencies,
  context: ToolExecutionContext,
  args: { conversation_id: string }
): Promise<ImageAnalyzer | null> {
  if (!dependencies.resolveAnalyzer) {
    return dependencies.analyzer ?? null;
  }
  return dependencies.resolveAnalyzer({
    db: context.db,
    account_id: context.account_id,
    conversation_id: args.conversation_id,
    correlation_id: context.correlation_id,
    signal: context.signal,
  });
}

function parseInput(input: unknown): ParsedInput {
  if (!isRecord(input)) {
    throw new ToolError('invalid_input', 'Tool input must be an object');
  }
  for (const key of Object.keys(input)) {
    if (key === 'account_id' || key === 'account') {
      throw new ToolError(
        'invalid_input',
        'account_id comes from the execution context and must not be supplied'
      );
    }
    if (!ALLOWED_INPUT_KEYS.has(key)) {
      throw new ToolError(
        'invalid_input',
        `analyze_images does not accept ${key}; media is referenced by WACRM message id only`
      );
    }
  }

  const conversationId = parseRequiredId(
    input.conversation_id,
    'conversation_id'
  );

  const messageIds = parseMessageIds(input.message_ids);
  const imageLimit = parseImageLimit(input.image_limit, messageIds !== null);
  const includeContext = parseIncludeContext(input.include_context);

  return {
    conversation_id: conversationId,
    message_ids: messageIds,
    image_limit: imageLimit,
    include_context: includeContext,
  };
}

function parseMessageIds(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) {
    throw new ToolError('invalid_input', 'message_ids must be an array');
  }
  if (value.length === 0) {
    throw new ToolError('invalid_input', 'message_ids must not be empty');
  }
  if (value.length > IMAGE_ANALYSIS_LIMITS.max_images) {
    throw new ToolError(
      'invalid_input',
      `At most ${IMAGE_ANALYSIS_LIMITS.max_images} images can be analysed in one call`
    );
  }
  const ids: string[] = [];
  for (const entry of value) {
    const id = parseRequiredId(entry, 'message_ids[]');
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function parseImageLimit(value: unknown, explicitIds: boolean): number {
  if (value !== undefined && explicitIds) {
    throw new ToolError(
      'invalid_input',
      'image_limit cannot be combined with message_ids'
    );
  }
  if (value === undefined) return ANALYZE_IMAGES_DEFAULT_IMAGE_COUNT;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > IMAGE_ANALYSIS_LIMITS.max_images
  ) {
    throw new ToolError(
      'invalid_input',
      `image_limit must be a whole number from 1 to ${IMAGE_ANALYSIS_LIMITS.max_images}`
    );
  }
  return value;
}

function parseIncludeContext(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== 'boolean') {
    throw new ToolError(
      'invalid_input',
      'include_context must be true or false'
    );
  }
  return value;
}

async function loadConversation(
  db: SupabaseClient,
  accountId: string,
  conversationId: string
): Promise<{ id: string } | null> {
  const { data, error } = await db
    .from('conversations')
    .select('id')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) {
    throw new ToolError('unavailable', 'Could not load conversation', {
      retryable: true,
    });
  }
  return (data as { id: string } | null) ?? null;
}

/**
 * Resolve the candidate messages for this call.
 *
 * `messages` has no `account_id` column (migration 017 reaches it through
 * the parent conversation's policy), so the account boundary is the
 * already-verified conversation plus the `conversation_id` filter below.
 * Both branches order deterministically and then present chronologically,
 * so the analyser sees the customer's photos in the order they were sent.
 */
async function loadCandidateMessages(
  db: SupabaseClient,
  conversationId: string,
  input: ParsedInput
): Promise<{ candidates: AnalysisMediaCandidate[]; hasEarlier: boolean }> {
  if (input.message_ids) {
    const { data, error } = await db
      .from('messages')
      .select(MESSAGE_COLUMNS)
      .eq('conversation_id', conversationId)
      .in('id', input.message_ids)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true });
    if (error) {
      throw new ToolError('unavailable', 'Could not load messages', {
        retryable: true,
      });
    }
    const rows = (data ?? []) as unknown as MessageRow[];
    if (rows.length !== input.message_ids.length) {
      // A message id from another conversation, another account, or simply
      // unknown. All three are the same answer.
      throw new ToolError('not_found', 'One or more messages were not found');
    }
    return { candidates: rows.map(toCandidate), hasEarlier: false };
  }

  const { data, error } = await db
    .from('messages')
    .select(MESSAGE_COLUMNS)
    .eq('conversation_id', conversationId)
    .eq('content_type', 'image')
    .not('media_url', 'is', null)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(input.image_limit + 1);
  if (error) {
    throw new ToolError('unavailable', 'Could not load messages', {
      retryable: true,
    });
  }
  const rows = ((data ?? []) as unknown as MessageRow[]).slice(
    0,
    input.image_limit
  );
  return {
    candidates: rows.reverse().map(toCandidate),
    hasEarlier:
      ((data ?? []) as unknown as MessageRow[]).length > input.image_limit,
  };
}

function toCandidate(row: MessageRow): AnalysisMediaCandidate {
  return {
    message_id: row.id,
    created_at: row.created_at,
    sender_type: row.sender_type,
    content_type: row.content_type,
    media_url: row.media_url,
    media_type: row.media_type,
  };
}

function toAnalysisContext(enquiry: {
  id: string;
  item_descriptions: string[] | null;
  waste_type: string | null;
  estimated_volume: string | null;
  heavy_special_items: string[] | null;
  access_constraints: string[] | null;
  property_type: string | null;
  floor: string | null;
  lift_available: boolean | null;
  parking: string | null;
}): ImageAnalysisContext {
  return {
    origin: 'customer_statement',
    enquiry_id: enquiry.id,
    item_descriptions: enquiry.item_descriptions ?? [],
    waste_type: enquiry.waste_type,
    estimated_volume: enquiry.estimated_volume,
    heavy_special_items: enquiry.heavy_special_items ?? [],
    access_constraints: enquiry.access_constraints ?? [],
    property_type: enquiry.property_type,
    floor: enquiry.floor,
    lift_available: enquiry.lift_available,
    parking: enquiry.parking,
  };
}

/**
 * Call the analyzer under a hard deadline.
 *
 * The caller keeps control of cancellation through `ToolExecutionContext`,
 * as every other tool does; the timeout here is only a bound on how long
 * one provider call may occupy the request, and its message is distinct
 * from a caller cancellation so an operator can tell them apart.
 */
async function runAnalyzer(
  analyzer: ImageAnalyzer,
  request: { images: AnalyzerImage[]; context: ImageAnalysisContext | null },
  timeoutMs: number,
  callerSignal: AbortSignal | undefined
): Promise<unknown> {
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const abortWithCaller = () => controller.abort();
  if (callerSignal?.aborted) {
    controller.abort();
  } else {
    callerSignal?.addEventListener('abort', abortWithCaller, { once: true });
  }

  const deadline = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      'abort',
      () =>
        reject(
          timedOut
            ? new ToolError('unavailable', 'Image analysis timed out', {
                retryable: true,
              })
            : new ToolError('unavailable', 'Tool execution was cancelled', {
                retryable: true,
              })
        ),
      { once: true }
    );
  });

  const analysis = Promise.resolve(
    analyzer.analyze({
      images: request.images,
      context: request.context,
      signal: controller.signal,
    })
  );
  // The losing promise of a race must not surface as an unhandled
  // rejection when the deadline wins.
  analysis.catch(() => undefined);

  try {
    return await Promise.race([analysis, deadline]);
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError('unavailable', 'Image analysis provider failed', {
      retryable: true,
    });
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', abortWithCaller);
  }
}

function validateResult(
  raw: unknown,
  sources: ImageSourceRef[]
): ImageAnalysisResult {
  try {
    return parseImageAnalysisResult(raw, sources);
  } catch (error) {
    if (error instanceof ImageAnalysisValidationError) {
      // The provider's own message is dropped: it can echo provider text.
      throw new ToolError(
        'internal',
        `Image analysis provider returned an invalid result (${error.reason})`
      );
    }
    throw error;
  }
}

function lowestConfidence(result: ImageAnalysisResult): number | null {
  if (result.observations.length === 0) return null;
  return result.observations.reduce(
    (lowest, observation) => Math.min(lowest, observation.confidence),
    1
  );
}
