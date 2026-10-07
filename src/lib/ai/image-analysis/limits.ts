/**
 * Objective 08 — image analysis limits, MIME vocabulary and content sniffing.
 *
 * These are module constants on purpose. The limits are a safety boundary
 * (server memory, provider payload size, and cost control once a real vision
 * provider exists), not an operator preference, so there is deliberately no
 * configuration surface for them yet. Changing a value here is a code-review
 * event, which is the point.
 *
 * The values are derived from existing WACRM media behaviour rather than
 * invented:
 *
 * - `max_bytes_per_image` is `MEDIA_MAX_BYTES_BY_KIND.image` (5 MB) — Meta's
 *   own WhatsApp image ceiling, which is also the composer/mirror limit for
 *   an image (`src/lib/storage/upload-media.ts`).
 * - `max_total_bytes` is three times that, so a full six-image call cannot
 *   transfer the 16 MB the `chat-media` bucket accepts per object.
 * - `max_images` is six: enough for a whole room, small enough that a
 *   single call cannot become an unbounded transfer.
 * - `supported_mime_types` is exactly the image types the `chat-media`
 *   bucket accepts (migrations 023 and 039). Nothing is added here, so a
 *   stored attachment that the bucket allowed is analysable and nothing
 *   else is.
 *
 * The worst-case bytes actually transferred by one call is bounded at
 * `max_total_bytes + max_bytes_per_image` (20 MB): the running total is
 * checked after each image, so the call stops before it can exceed the
 * per-image allowance again.
 */

/** Same bucket the composer writes to and the inbound mirror copies into. */
export const ANALYSIS_MEDIA_BUCKET = 'chat-media';

export const SUPPORTED_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
] as const;

export type SupportedImageMimeType =
  (typeof SUPPORTED_IMAGE_MIME_TYPES)[number];

export interface ImageAnalysisLimits {
  /** Images in one analysis call. */
  max_images: number;
  /** Bytes for a single image. */
  max_bytes_per_image: number;
  /** Bytes across every image in one call. */
  max_total_bytes: number;
  /** Longest stored media reference considered at all. */
  max_media_reference_chars: number;
  /** Provider observations retained in one result. */
  max_observations: number;
  max_ambiguous_items: number;
  max_image_quality_observations: number;
  max_follow_up_questions: number;
  max_notes: number;
  max_hazards_per_observation: number;
  max_sources_per_observation: number;
  max_label_chars: number;
  max_note_chars: number;
  max_question_chars: number;
  supported_mime_types: readonly SupportedImageMimeType[];
}

export const IMAGE_ANALYSIS_LIMITS: ImageAnalysisLimits = Object.freeze({
  max_images: 6,
  max_bytes_per_image: 5 * 1024 * 1024,
  max_total_bytes: 15 * 1024 * 1024,
  max_media_reference_chars: 2_048,
  max_observations: 30,
  max_ambiguous_items: 15,
  max_image_quality_observations: 12,
  max_follow_up_questions: 6,
  max_notes: 5,
  max_hazards_per_observation: 5,
  max_sources_per_observation: 6,
  max_label_chars: 120,
  max_note_chars: 400,
  max_question_chars: 300,
  supported_mime_types: Object.freeze([
    ...SUPPORTED_IMAGE_MIME_TYPES,
  ]) as readonly SupportedImageMimeType[],
});

/** Images analysed when the caller does not name messages explicitly. */
export const ANALYZE_IMAGES_DEFAULT_IMAGE_COUNT = 3;

/** Wall-clock budget for one provider call. */
export const IMAGE_ANALYZER_TIMEOUT_MS = 20_000;

/**
 * Lower-case a MIME type and drop its parameters, so `image/jpeg; charset=x`
 * is matched as plain `image/jpeg`. Returns `null` for anything that is not
 * a supported image type, which is what makes "reject unsupported media" a
 * single comparison rather than a list of special cases.
 */
export function normalizeImageMimeType(
  value: string | null | undefined
): SupportedImageMimeType | null {
  if (typeof value !== 'string') return null;
  const base = value.split(';')[0]?.trim().toLowerCase() ?? '';
  return (SUPPORTED_IMAGE_MIME_TYPES as readonly string[]).includes(base)
    ? (base as SupportedImageMimeType)
    : null;
}

/**
 * Identify an image from its leading bytes.
 *
 * A stored MIME type is a label someone (or some client) wrote; the bytes
 * are the fact. The retrieval boundary requires the two to agree, so a
 * mislabelled object cannot reach a provider as if it were an image.
 */
export function sniffImageMimeType(
  bytes: Uint8Array
): SupportedImageMimeType | null {
  if (bytes.byteLength < 4) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (startsWithAscii(bytes, '\x89PNG\r\n\x1a\n')) return 'image/png';
  if (startsWithAscii(bytes, 'GIF87a') || startsWithAscii(bytes, 'GIF89a')) {
    return 'image/gif';
  }
  if (startsWithAscii(bytes, 'RIFF') && startsWithAscii(bytes, 'WEBP', 8)) {
    return 'image/webp';
  }
  return null;
}

function startsWithAscii(
  bytes: Uint8Array,
  ascii: string,
  offset = 0
): boolean {
  if (bytes.byteLength < offset + ascii.length) return false;
  for (let index = 0; index < ascii.length; index += 1) {
    if (bytes[offset + index] !== ascii.charCodeAt(index)) return false;
  }
  return true;
}
