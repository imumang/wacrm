/**
 * The deterministic per-image semantic builder.
 *
 * This is the extension objective 03 needed and did not have: a
 * semantic representation of ONE photograph, built from that
 * photograph's canonical persisted observations.
 *
 * ## The distinction from the case-level builder, stated once
 *
 * WACRM has two — and will have two — observation-derived semantic
 * representations. They are NOT interchangeable, and conflating them is
 * the mistake this module's existence prevents:
 *
 * | | Case-level (`image-observation-text-v1`) | Per-image (`per-image-observation-text-v1`) |
 * | --- | --- | --- |
 * | Source | a finalized case's frozen `image_analysis` snapshot, built from `image_observed` FACTS | the canonical per-image observations of one photograph |
 * | Granularity | one vector per JOB | one vector per PHOTOGRAPH |
 * | Question it answers | "which historical jobs were visually described similarly?" | "which photographs were described similarly?" |
 * | Identity | `(case, kind, versions, content hash)` | `(case, run, IMAGE ORDINAL, kind, versions, content hash)` |
 * | Failure mode | coarse: two jobs collapse into one neighbour | fine: one poor photograph can dominate its own neighbourhood |
 *
 * Both are `image_observation_text` and NEITHER is `native_image`. Both
 * are a vision model describing photographs in words, embedded by a
 * text model. Neither measures visual similarity between pixels, and
 * `generateNativeImageEmbedding` remains a typed `unsupported` error.
 *
 * ## What is deliberately absent from the text
 *
 * The per-image builder is the most tempting place in the codebase to
 * leak metadata, because a per-image record has an ordinal, a message
 * id and a storage object path sitting right next to it. None of them is
 * emitted:
 *
 *   - an ordinal or message id in the text would make the embedding a
 *     function of WHICH message happened to carry the photograph, so the
 *     same picture forwarded twice would not match itself;
 *   - a storage object path is a needless identifier in a semantic
 *     vector, and it would poison the content hash the moment the
 *     uploader's naming changed;
 *   - price and exact weight are absent for the same reason they are
 *     absent from the case-level builder: embedding them would rank
 *     comparables by price. See `assertNoMonetaryLeakage`.
 *
 * Source references stay on the ROW, where traceability belongs.
 */

import {
  IMAGE_OBSERVATION_TEXT_SEMANTIC_INPUT_VERSION,
  VECTOR_MEMORY_MAX_SEMANTIC_INPUT_CHARS,
  VectorMemoryError,
  assertNoMonetaryLeakage,
} from './model';
import type { ImageObservationRecord } from './semantic-input';
import { sha256Hex } from './semantic-input';
import type { SemanticInput } from './semantic-input';
import type {
  ImageAnalysisAggregate,
  ValidatedPersistedImageFinding,
} from '@/lib/image-observations/model';

/**
 * Version tag for the PER-IMAGE builder.
 *
 * Separate from `IMAGE_OBSERVATION_TEXT_SEMANTIC_INPUT_VERSION` for the
 * same reason the model version is separate: a model upgrade means new
 * coordinates, while a builder change means the same coordinates now
 * describe something slightly different. Conflating them would make a
 * wording change look like a model upgrade, and re-embedding the wrong
 * population would follow.
 *
 * Per-image text is a subset of case-level text — same observations, one
 * photograph's worth — so the two are semantically comparable in the way
 * two views of the same corpus are, but they are stored under separate
 * versions and must never be mixed into one another's neighbourhood.
 */
export const PER_IMAGE_OBSERVATION_TEXT_SEMANTIC_INPUT_VERSION =
  'per-image-observation-text-v1';

/**
 * One photograph's observations, and where it came from.
 *
 * `ordinal` and `source_media_id` are METADATA. They are on this shape
 * so a caller can address the right photograph, and they are used only to
 * set `source_reference` on the embedding ROW. Neither reaches the text.
 */
export interface PerImageObservationSource {
  /** 1-based position in the analysed set. Row metadata only. */
  ordinal: number;
  /** The account-scoped storage object path. Row metadata only. */
  source_media_id: string;
  /** The canonical message the photograph came from. Row metadata only. */
  source_message_id: string;
}

export interface PerImageSemanticInput extends SemanticInput {
  /**
   * The photograph's stable reference, carried on the embedding row.
   *
   * The MEDIA OBJECT PATH rather than the message id: two messages can
   * point at the same object, and the object is the thing that is
   * actually the photograph. Bounded and non-secret, and never a URL and
   * never a signed URL.
   */
  source_reference: string;
  /** Row metadata. Never part of `text`. */
  ordinal: number;
}

/**
 * Build the deterministic semantic text for ONE photograph.
 *
 * Pure, and a function of the observation records alone: the same
 * observations always produce byte-identical text and therefore the same
 * content hash, which is what makes per-image generation idempotent.
 *
 * Throws when the photograph has no observations. That is the honest
 * answer — a photograph nothing was observed about has nothing to
 * describe — and it is the same rule `buildImageObservationSemanticInput`
 * applies to an empty case-level record set.
 *
 * Ambiguity and quality are preserved exactly as they are at case level:
 * an ambiguous finding stays its own line marked `uncertain`, and
 * low-quality imagery becomes its own observation, because "these photos
 * were dark" is precisely the signal objective 04 needs in order not to
 * trust a visual match derived from them.
 */
export function buildPerImageObservationSemanticInput(input: {
  /** Identity for the embedding ROW. Never part of the text. */
  source: PerImageObservationSource;
  /** This photograph's validated observations. */
  records: readonly ImageObservationRecord[];
}): PerImageSemanticInput {
  const lines: string[] = [];
  let signalCount = 0;

  for (const record of input.records) {
    const category = normaliseText(record.category);
    if (category === null) continue;

    const line = [`observed ${category}`];
    if (typeof record.count === 'number' && Number.isFinite(record.count)) {
      line.push(`about ${Math.round(record.count)}`);
    }
    if (
      typeof record.volume_min === 'number' &&
      typeof record.volume_max === 'number' &&
      Number.isFinite(record.volume_min) &&
      Number.isFinite(record.volume_max)
    ) {
      line.push(
        `relative volume ${formatNumber(record.volume_min)} to ${formatNumber(record.volume_max)}`
      );
    }
    if (record.dismantling === 'indicated') line.push('needs dismantling');
    if (record.heavy === 'indicated') line.push('needs heavy handling');
    if (record.uncertainty === 'ambiguous') line.push('uncertain');
    else if (record.uncertainty === 'unknown') line.push('unconfirmed');

    const note = normaliseText(record.note);
    if (note !== null) line.push(`- ${note}`);

    lines.push(line.join(' '));
    signalCount += 1;
  }

  lines.sort();
  const text = lines.join('\n');

  if (text.trim() === '') {
    throw new VectorMemoryError(
      'invalid_input',
      'There are no validated observations of this photograph to embed.'
    );
  }
  if (text.length > VECTOR_MEMORY_MAX_SEMANTIC_INPUT_CHARS) {
    throw new VectorMemoryError(
      'invalid_input',
      `The serialised observations of this photograph are ${text.length} characters; the limit is ${VECTOR_MEMORY_MAX_SEMANTIC_INPUT_CHARS}.`
    );
  }

  assertNoMonetaryLeakage(text, 'the per-image observation description');

  return {
    kind: 'image_observation_text',
    semantic_input_version: PER_IMAGE_OBSERVATION_TEXT_SEMANTIC_INPUT_VERSION,
    text,
    content_hash: sha256Hex(text),
    signal_count: signalCount,
    // Per-image memory is derived from a canonical observation record, not
    // from a case snapshot. The two are distinguished here so a consumer
    // can tell which corpus a vector belongs to.
    source_entity: 'historical_case',
    source_reference: input.source.source_media_id,
    ordinal: input.source.ordinal,
  };
}

/**
 * Project a run's validated findings onto per-image semantic sources.
 *
 * This is the adapter that makes the model answer objective 04's question
 * — "which observation came from which photograph?" — without the caller
 * having to know how findings and source links are stored.
 *
 * One entry per analysed photograph that has at least one observation, in
 * ordinal order. A photograph with no observations is OMITTED rather than
 * emitted as empty, because an empty description would either throw
 * downstream or, worse, be filled with a placeholder that matches
 * everything.
 *
 * Observations that legitimately reference several photographs appear in
 * EVERY photograph's set — which is the point. "The same sofa appears in
 * photos 1 and 3" means both photographs carry that observation, and it
 * is stored once in the canonical record so the duplication here is a
 * projection rather than a stored copy.
 */
export function perImageSemanticSources(
  aggregate: ImageAnalysisAggregate,
  findings: readonly ValidatedPersistedImageFinding[]
): Array<{
  source: PerImageObservationSource;
  records: ImageObservationRecord[];
}> {
  const imageByOrdinal = new Map(
    aggregate.images.map((image) => [image.ordinal, image])
  );
  const recordsByOrdinal = new Map<number, ImageObservationRecord[]>();

  for (const finding of findings) {
    const record = recordFromFinding(finding);
    if (!record) continue;
    for (const ordinal of finding.source_ordinals) {
      const existing = recordsByOrdinal.get(ordinal) ?? [];
      existing.push(record);
      recordsByOrdinal.set(ordinal, existing);
    }
  }

  const sources: Array<{
    source: PerImageObservationSource;
    records: ImageObservationRecord[];
  }> = [];
  for (const ordinal of [...recordsByOrdinal.keys()].sort((l, r) => l - r)) {
    const image = imageByOrdinal.get(ordinal);
    if (!image) continue;
    sources.push({
      source: {
        ordinal,
        source_media_id: image.source_media_id,
        source_message_id: image.source_message_id,
      },
      records: (recordsByOrdinal.get(ordinal) ?? []).sort((left, right) =>
        left.category.localeCompare(right.category)
      ),
    });
  }
  return sources;
}

/**
 * One validated finding, as a semantic record.
 *
 * The same normalisation `imageObservationRecordsFromAnalysis` applies,
 * so a per-image vector and a case-level vector describe an observation
 * in identical language. A finding whose fields do not match its kind
 * yields no record: it cannot be described honestly, and inventing a
 * generic label would let an ambiguous finding read as an observation.
 */
function recordFromFinding(
  finding: ValidatedPersistedImageFinding
): ImageObservationRecord | null {
  if (finding.finding_kind === 'observation') {
    const observation = finding.finding as {
      kind: string;
      label: string;
      confidence: number;
      basis: 'observed' | 'ambiguous';
      approximate_count: { value: number } | null;
      volume_range: { min: number; max: number } | null;
      dismantling: ImageObservationRecord['dismantling'];
      heavy_handling: ImageObservationRecord['heavy'];
      notes: string | null;
    };
    return {
      category: observation.label || observation.kind,
      count: observation.approximate_count?.value ?? null,
      uncertainty:
        observation.basis === 'ambiguous'
          ? 'ambiguous'
          : observation.confidence >= 0.5
            ? 'observed'
            : 'unknown',
      volume_min: observation.volume_range?.min ?? null,
      volume_max: observation.volume_range?.max ?? null,
      dismantling: observation.dismantling,
      heavy: observation.heavy_handling,
      note: observation.notes,
    };
  }

  if (finding.finding_kind === 'ambiguous_item') {
    const item = finding.finding as { description: string };
    return {
      category: item.description,
      count: null,
      uncertainty: 'ambiguous',
      volume_min: null,
      volume_max: null,
      dismantling: 'unknown',
      heavy: 'unknown',
      note: null,
    };
  }

  const quality = finding.finding as { kind: string; detail: string | null };
  return {
    category: `image quality: ${quality.kind}`,
    count: null,
    uncertainty: 'observed',
    volume_min: null,
    volume_max: null,
    dismantling: 'unknown',
    heavy: 'unknown',
    note: quality.detail,
  };
}

function normaliseText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value !== 'string') return null;
  const collapsed = value.toLowerCase().replace(/\s+/g, ' ').trim();
  return collapsed === '' ? null : collapsed;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return String(value);
}

// Re-exported so a consumer importing the per-image builder has the
// case-level version tag in scope and cannot confuse the two.
export { IMAGE_OBSERVATION_TEXT_SEMANTIC_INPUT_VERSION };