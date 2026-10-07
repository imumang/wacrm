/**
 * Objective 08 — the controlled media-retrieval boundary.
 *
 * This is the only path by which image bytes reach an analyzer, and it is
 * deliberately small and fail-closed:
 *
 * - **Canonical records only.** Media is resolved from `messages` rows the
 *   caller has already been authorised for, and the object path is derived
 *   from that row's own `media_url`. Nothing here accepts a caller- or
 *   model-supplied URL or filesystem path.
 * - **Account scoped.** The derived object path must start with
 *   `account-<account_id>/`, the convention the `chat-media` write policies
 *   match on (migrations 020/023). A path pointing at another account's
 *   folder is refused with `forbidden`.
 * - **No remote fetch, therefore no SSRF.** The stored reference is parsed
 *   for its object path and then that path is read through the Supabase
 *   Storage client the trusted caller already holds. No URL is ever
 *   requested, no host is ever resolved, and no token or signed URL is
 *   produced. `AGENTS.md`'s service-role rule is respected: this module
 *   constructs no client and reaches for no credential.
 * - **Bounded.** Image count, per-image bytes, total bytes, and MIME type
 *   are all checked here rather than trusted to the provider.
 * - **Content-verified.** The stored MIME label must agree with the actual
 *   leading bytes, so a mislabelled object cannot be passed off as an image.
 *
 * Media that Meta still holds but WACRM never mirrored (the legacy
 * `/api/whatsapp/media/<id>` proxy pointer) is deliberately *not*
 * retrievable through this boundary. Fetching it would mean decrypting the
 * account's WhatsApp token inside an analysis call; that is a separate
 * capability with its own failure modes, and it is a documented limitation
 * rather than a shortcut taken here.
 */

import type { ImageSourceRef } from './analyzer';
import {
  ANALYSIS_MEDIA_BUCKET,
  IMAGE_ANALYSIS_LIMITS,
  normalizeImageMimeType,
  sniffImageMimeType,
  type ImageAnalysisLimits,
  type SupportedImageMimeType,
} from './limits';
import { ToolError } from '@/lib/ai/tools/contract';

/** Narrow Storage surface. Only `download` is needed, and tests can fake it. */
export interface AnalysisMediaBucketClient {
  download(
    path: string
  ): Promise<{ data: Blob | null; error: { message: string } | null }>;
}

export interface AnalysisMediaClient {
  storage: { from(bucket: string): AnalysisMediaBucketClient };
}

export interface AnalysisMediaLoadRequest {
  client: AnalysisMediaClient;
  bucket: string;
  object_path: string;
  max_bytes: number;
  signal?: AbortSignal;
}

export interface LoadedAnalysisMedia {
  bytes: Uint8Array;
  /** Content type reported by storage. Advisory only — bytes are the fact. */
  declared_mime_type: string | null;
}

/**
 * A pluggable byte source. The production implementation reads the
 * `chat-media` bucket; a future implementation could serve Meta-hosted
 * media that was never mirrored. The tool only ever sees this interface.
 */
export interface AnalysisMediaLoader {
  readonly id: string;
  read(request: AnalysisMediaLoadRequest): Promise<LoadedAnalysisMedia>;
}

export interface AnalysisMediaCandidate {
  message_id: string;
  created_at: string;
  sender_type: string;
  content_type: string;
  media_url: string | null;
  media_type: string | null;
}

export interface ResolvedAnalysisImage {
  source: ImageSourceRef;
  mime_type: SupportedImageMimeType;
  byte_length: number;
  bytes: Uint8Array;
  created_at: string;
  direction: 'inbound' | 'outbound';
  content_type: string;
}

export interface DuplicateMediaReference {
  message_id: string;
  duplicate_of_message_id: string;
  reason: 'identical_media_object';
}

export type MediaReferenceResolution =
  | { ok: true; object_path: string }
  | {
      ok: false;
      reason:
        | 'missing'
        | 'not_durable_media'
        | 'invalid_reference'
        | 'foreign_account';
    };

/**
 * Read bytes for one already-resolved, account-verified object.
 *
 * Fails closed: a storage error becomes a retryable `unavailable` with a
 * generic message. The underlying storage message is written to the
 * operator log (it helps diagnose a broken bucket) and never returned,
 * because it can carry object names and connection detail.
 */
export function createSupabaseStorageMediaLoader(): AnalysisMediaLoader {
  return {
    id: 'supabase_storage',
    async read(request) {
      const bucket = request.client.storage.from(request.bucket);
      const { data, error } = await bucket.download(request.object_path);
      if (error || !data) {
        console.warn('[image-analysis] stored media could not be read', {
          bucket: request.bucket,
          error: error?.message ?? 'no data returned',
        });
        throw new ToolError('unavailable', 'Stored media is not readable', {
          retryable: true,
        });
      }
      const bytes = new Uint8Array(await data.arrayBuffer());
      return {
        bytes,
        declared_mime_type: typeof data.type === 'string' ? data.type : null,
      };
    },
  };
}

/**
 * Derive the account-scoped storage object path from a stored media
 * reference. Pure, so the security rules are testable without a client.
 *
 * Accepts only an `https:` Supabase public-object URL for the analysis
 * bucket whose path begins with this account's folder. The URL's origin is
 * parsed but never used — nothing is fetched from it.
 */
export function resolveMediaObjectPath(
  mediaUrl: string | null | undefined,
  accountId: string,
  limits: ImageAnalysisLimits = IMAGE_ANALYSIS_LIMITS
): MediaReferenceResolution {
  if (typeof mediaUrl !== 'string' || mediaUrl.trim() === '') {
    return { ok: false, reason: 'missing' };
  }
  const value = mediaUrl.trim();
  if (value.length > limits.max_media_reference_chars) {
    return { ok: false, reason: 'invalid_reference' };
  }
  // A site-relative pointer is the legacy Meta proxy route, i.e. media WACRM
  // never mirrored. It is not durable media and this boundary will not
  // chase it back through Meta.
  if (value.startsWith('/')) {
    return { ok: false, reason: 'not_durable_media' };
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: 'invalid_reference' };
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    return { ok: false, reason: 'invalid_reference' };
  }

  const prefix = `/storage/v1/object/public/${ANALYSIS_MEDIA_BUCKET}/`;
  if (!url.pathname.startsWith(prefix)) {
    return { ok: false, reason: 'not_durable_media' };
  }

  const objectPath = url.pathname.slice(prefix.length);
  const segments = objectPath.split('/');
  if (
    segments.length < 2 ||
    segments.some(
      (segment) =>
        segment === '' ||
        segment === '.' ||
        segment === '..' ||
        !/^[A-Za-z0-9._-]+$/.test(segment)
    )
  ) {
    return { ok: false, reason: 'invalid_reference' };
  }
  if (segments[0] !== `account-${accountId}`) {
    return { ok: false, reason: 'foreign_account' };
  }
  return { ok: true, object_path: objectPath };
}

/**
 * Resolve every candidate into a bounded, verified image payload, in the
 * order given (the caller orders chronologically).
 *
 * Deterministic duplicate handling: two messages that point at the *same*
 * storage object are byte-identical by construction, so the first is kept
 * and the later reference is reported. Visually similar but distinct
 * photographs are NOT deduplicated — that needs perceptual comparison this
 * layer deliberately does not perform.
 */
export async function resolveAnalysisImages(args: {
  client: AnalysisMediaClient;
  account_id: string;
  candidates: readonly AnalysisMediaCandidate[];
  loader: AnalysisMediaLoader;
  limits?: ImageAnalysisLimits;
  signal?: AbortSignal;
}): Promise<{
  images: ResolvedAnalysisImage[];
  duplicates: DuplicateMediaReference[];
}> {
  const limits = args.limits ?? IMAGE_ANALYSIS_LIMITS;
  const unique: Array<{
    candidate: AnalysisMediaCandidate;
    objectPath: string;
  }> = [];
  const duplicates: DuplicateMediaReference[] = [];
  const seen = new Map<string, string>();

  for (const candidate of args.candidates) {
    const resolution = resolveMediaObjectPath(
      candidate.media_url,
      args.account_id,
      limits
    );
    if (!resolution.ok) {
      throw mediaError(resolution.reason);
    }
    const kept = seen.get(resolution.object_path);
    if (kept !== undefined) {
      duplicates.push({
        message_id: candidate.message_id,
        duplicate_of_message_id: kept,
        reason: 'identical_media_object',
      });
      continue;
    }
    seen.set(resolution.object_path, candidate.message_id);
    unique.push({ candidate, objectPath: resolution.object_path });
  }

  if (unique.length > limits.max_images) {
    throw new ToolError(
      'invalid_input',
      `At most ${limits.max_images} images can be analysed in one call`
    );
  }

  const images: ResolvedAnalysisImage[] = [];
  let totalBytes = 0;

  for (const entry of unique) {
    if (args.signal?.aborted) {
      throw new ToolError('unavailable', 'Image analysis was cancelled', {
        retryable: true,
      });
    }

    const { bytes, declared_mime_type } = await args.loader.read({
      client: args.client,
      bucket: ANALYSIS_MEDIA_BUCKET,
      object_path: entry.objectPath,
      max_bytes: limits.max_bytes_per_image,
      signal: args.signal,
    });

    if (bytes.byteLength === 0) {
      throw new ToolError('unavailable', 'Stored media is empty', {
        retryable: false,
      });
    }
    if (bytes.byteLength > limits.max_bytes_per_image) {
      throw new ToolError(
        'invalid_input',
        `An image exceeds the ${limits.max_bytes_per_image}-byte analysis limit`
      );
    }

    const sniffed = sniffImageMimeType(bytes);
    if (sniffed === null) {
      throw new ToolError(
        'invalid_input',
        'Media content is not a supported image'
      );
    }
    assertDeclaredMimeMatches(
      [declared_mime_type, entry.candidate.media_type],
      sniffed
    );

    totalBytes += bytes.byteLength;
    if (totalBytes > limits.max_total_bytes) {
      throw new ToolError(
        'invalid_input',
        `The selected images exceed the ${limits.max_total_bytes}-byte total analysis limit`
      );
    }

    images.push({
      source: {
        ordinal: images.length + 1,
        source_message_id: entry.candidate.message_id,
        // The object path, not the URL: canonical, non-secret, and exactly
        // what an operator needs to find the attachment again.
        source_media_id: entry.objectPath,
      },
      mime_type: sniffed,
      byte_length: bytes.byteLength,
      bytes,
      created_at: entry.candidate.created_at,
      direction:
        entry.candidate.sender_type === 'customer' ? 'inbound' : 'outbound',
      content_type: entry.candidate.content_type,
    });
  }

  return { images, duplicates };
}

function assertDeclaredMimeMatches(
  declared: readonly (string | null)[],
  sniffed: SupportedImageMimeType
): void {
  for (const value of declared) {
    if (value === null || value === undefined) continue;
    const normalized = normalizeImageMimeType(value);
    if (normalized === null) {
      throw new ToolError(
        'invalid_input',
        'Media type is not a supported image type'
      );
    }
    if (normalized !== sniffed) {
      throw new ToolError(
        'invalid_input',
        'Media content does not match its declared image type'
      );
    }
  }
}

function mediaError(
  reason: Exclude<MediaReferenceResolution, { ok: true }>['reason']
): ToolError {
  switch (reason) {
    case 'missing':
      return new ToolError('invalid_input', 'Message has no media reference');
    case 'foreign_account':
      return new ToolError(
        'forbidden',
        'Media is not accessible for this account'
      );
    case 'not_durable_media':
      return new ToolError(
        'unavailable',
        'Media is not stored in WACRM media storage',
        { retryable: false }
      );
    default:
      return new ToolError(
        'invalid_input',
        'Media reference is not a supported WACRM media object'
      );
  }
}
