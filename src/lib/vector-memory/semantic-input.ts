/**
 * Objective 03 — the deterministic semantic-input builders.
 *
 * These functions turn canonical WACRM business data into the exact
 * text that will be embedded. They are pure, side-effect free, and
 * deterministic: the same case state under the same
 * `semantic_input_version` always produces byte-identical text and
 * therefore the same content hash, which is what makes generation
 * idempotent.
 *
 * Three properties are load-bearing, and each one is enforced rather
 * than documented-and-hoped-for:
 *
 * 1. **Price cannot leak in.** The builders read from an explicit
 *    allowlist of operational fields. No monetary fact key is ever
 *    touched, and the finished text is then re-read by
 *    `assertNoMonetaryLeakage`, which refuses money and commercial
 *    decision tokens outright.
 *
 * 2. **Unknown stays absent.** A missing floor is an omitted line, not
 *    "floor: none" and not "floor: ground". An omitted field does not
 *    pull the vector toward a meaning the data does not have, and a
 *    comparison between "we don't know" and "we know it's the ground
 *    floor" stays distinguishable downstream.
 *
 * 3. **Estimated is not actual.** Where both exist they are emitted as
 *    separately labelled lines, so a job that was estimated at one load
 *    and came out at two does not flatten into one statement.
 *
 * Raw conversation text is deliberately not embedded. `customer_intent`
 * is free text written by a customer, so it can contain a price they
 * quoted, another firm's name, an address, or a prompt injection.
 * Structured `item_descriptions` is the normalised form of what the
 * customer described, and it is what the canonical job summary is
 * built from.
 */

import { createHash } from 'node:crypto';

import type { ImageAnalysisResult } from '@/lib/ai/image-analysis/result';
import type {
  HistoricalCaseFact,
  HistoricalCaseFactKey,
} from '@/lib/historical-cases/model';

import {
  CASE_TEXT_SEMANTIC_INPUT_VERSION,
  IMAGE_OBSERVATION_TEXT_SEMANTIC_INPUT_VERSION,
  VECTOR_MEMORY_MAX_SEMANTIC_INPUT_CHARS,
  VectorMemoryError,
  assertNoMonetaryLeakage,
  isMonetaryCaseFactKey,
  type GeneratableVectorEmbeddingKind,
} from './model';

// ---------------------------------------------------------------------------
// Canonical case text
// ---------------------------------------------------------------------------

/**
 * The `enquiries` columns this builder is allowed to read.
 *
 * Named explicitly so "what goes into an embedding" is a decision in
 * one file, not whatever the enquiry table happens to gain next
 * quarter.
 *
 * `customer_intent`, `postcode` and `address` are absent by decision:
 *
 * - `customer_intent` is untrusted free text from a customer. It can
 *   contain a price the customer was quoted elsewhere, a competitor's
 *   name, or an address. Structured item descriptions are the
 *   normalised equivalent and are attacker-free.
 * - `postcode` and `address` are location. Location is a *structured*
 *   retrieval feature (objective 06's feature model), not a semantic
 *   one: embedding a postcode makes every customer in a postcode a
 *   neighbour of every other, which is noise dressed up as similarity.
 */
export const SEMANTIC_ENQUIRY_FIELDS = [
  'item_descriptions',
  'waste_type',
  'property_type',
  'floor',
  'lift_available',
  'parking',
  'access_constraints',
  'estimated_volume',
  'heavy_special_items',
] as const;

export type SemanticEnquiryField = (typeof SEMANTIC_ENQUIRY_FIELDS)[number];

/**
 * Enquiry facts, as read from the `enquiries` row or from a frozen
 * `enquiry_facts` snapshot.
 *
 * Both the raw column and a JSONB snapshot value are accepted, because
 * a finalized case is described by its snapshot (immutable learning
 * truth) while an open one is described by the live row.
 */
export interface SemanticEnquiryFacts {
  item_descriptions?: readonly string[] | string | null;
  waste_type?: string | null;
  property_type?: string | null;
  floor?: string | null;
  lift_available?: boolean | null;
  parking?: string | null;
  access_constraints?: readonly string[] | string | null;
  estimated_volume?: string | null;
  heavy_special_items?: readonly string[] | string | null;
}

/**
 * The captured case facts this builder is allowed to read.
 *
 * Notably absent: every monetary key in `MONETARY_CASE_FACT_KEYS`,
 * every free-text note (`final_job_notes`, `scope_change_reason`), and
 * `travel_distance_km` / `travel_time_minutes`.
 *
 * Travel is excluded on purpose. It is a real price driver, but it is a
 * *structured* feature: two jobs in the same city should be able to
 * match on what they involved without their vectors being pulled
 * together by geography, and a postcode-free vector is what lets
 * objective 04 apply distance as its own explainable term.
 */
export const SEMANTIC_CASE_FACT_KEYS = [
  'service_type',
  'item_count',
  'estimated_load_units',
  'actual_load_units',
  'carry_distance_metres',
  'dismantling_required',
  'actual_dismantling_required',
  'crew_count',
  'estimated_labour_minutes',
  'actual_labour_minutes',
  'scope_change_type',
] as const satisfies readonly HistoricalCaseFactKey[];

export type SemanticCaseFactKey = (typeof SEMANTIC_CASE_FACT_KEYS)[number];

export interface SemanticCaseSource {
  case_id: string;
  account_id: string;
  case_state: 'open' | 'finalized';
  source_kind: string;
  evidence_quality_tier: string | null;
  learning_eligibility: 'pending' | 'included' | 'excluded';
  completed_at: string | null;
  finalized_at: string | null;
  /** `null` when the enquiry itself no longer exists. */
  enquiry: SemanticEnquiryFacts | null;
  facts: readonly HistoricalCaseFact[];
  /** Which canonical record supplied `enquiry`. Recorded as metadata. */
  source_entity: 'historical_case' | 'historical_case_snapshot';
  source_reference: string | null;
}

export interface SemanticInput {
  kind: GeneratableVectorEmbeddingKind;
  semantic_input_version: string;
  /** The exact text handed to the provider. */
  text: string;
  /** SHA-256 (lowercase hex) of `text`. The idempotency key. */
  content_hash: string;
  /**
   * How many independent operational signals were present. Feeds the
   * eligibility policy: a vector built from one fact is not worth
   * storing.
   */
  signal_count: number;
  source_entity: 'historical_case' | 'historical_case_snapshot';
  source_reference: string | null;
}

/**
 * Build the canonical semantic text for one historical case.
 *
 * Output is a sorted, newline-delimited `label: value` document. A
 * structured form rather than prose on purpose: it is inspectable (an
 * operator can see exactly what was embedded), it is stable across
 * refactors of the wording around it, and it makes the price-exclusion
 * argument checkable by reading the labels.
 *
 * Finalized cases contribute their *actual* operational facts and open
 * cases only their estimates, which is why a case's vector legitimately
 * changes when the job is captured. That produces a new content hash
 * and a stale/superseded pair rather than a silent overwrite.
 */
export function buildCaseSemanticInput(
  source: SemanticCaseSource
): SemanticInput {
  const facts = indexSemanticFacts(source.facts);
  const lines: string[] = [];
  let signalCount = 0;

  const add = (label: string, value: string | null | undefined): void => {
    const normalised = normaliseText(value);
    if (normalised === null) return;
    lines.push(`${label}: ${normalised}`);
    signalCount += 1;
  };
  const addList = (
    label: string,
    value: readonly string[] | string | null | undefined
  ): void => {
    const items = normaliseList(value);
    if (items.length === 0) return;
    lines.push(`${label}: ${items.join('; ')}`);
    signalCount += 1;
  };

  const enquiry = source.enquiry ?? {};

  // What was asked for.
  add('job service', textFact(facts, 'service_type'));
  addList('job items', enquiry.item_descriptions);
  add('job item count', integerFact(facts, 'item_count'));
  addList('job heavy or special items', enquiry.heavy_special_items);

  // What it was going to be, and what it turned out to be. Labelled
  // separately so an estimate is never read as a measurement.
  add('job estimated volume', enquiry.estimated_volume);
  add('job estimated load units', numberFact(facts, 'estimated_load_units'));
  add('job actual load units', numberFact(facts, 'actual_load_units'));
  add('job waste type', enquiry.waste_type);

  // Where and how it had to be done.
  add('job property type', enquiry.property_type);
  add('job floor', enquiry.floor);
  add(
    'job lift available',
    tristateBoolean(enquiry.lift_available, 'yes', 'no')
  );
  add('job parking', enquiry.parking);
  addList('job access constraints', enquiry.access_constraints);
  add('job carry distance metres', integerFact(facts, 'carry_distance_metres'));
  // "when estimated", not "when quoted": the label must not itself
  // contain a commercial word, because the finished document is re-read
  // by `assertNoMonetaryLeakage` and a self-inflicted false positive
  // here would refuse every job that needed dismantling.
  add(
    'job dismantling required when estimated',
    tristateBoolean(factBoolean(facts, 'dismantling_required'), 'yes', 'no')
  );
  add(
    'job dismantling required on the day',
    tristateBoolean(
      factBoolean(facts, 'actual_dismantling_required'),
      'yes',
      'no'
    )
  );

  // What it took, post-job only.
  add('job crew size', integerFact(facts, 'crew_count'));
  add('job estimated labour minutes', integerFact(facts, 'estimated_labour_minutes'));
  add('job actual labour minutes', integerFact(facts, 'actual_labour_minutes'));

  // Only a *closed-vocabulary* scope-change descriptor. The operator's
  // free-text reason is excluded: it routinely mentions money.
  const scopeChange = textFact(facts, 'scope_change_type');
  add(
    'job scope change',
    scopeChange === 'no_material_change' ? null : scopeChange
  );

  // Deterministic order: sort by label so the same facts always serialise
  // identically, regardless of the order the repository returned them in
  // or the order the sections above were written.
  lines.sort();
  const text = lines.join('\n');

  if (text.trim() === '') {
    throw new VectorMemoryError(
      'invalid_input',
      'This case has no operational description to embed. Record at least the items and one access or load fact first.'
    );
  }
  if (text.length > VECTOR_MEMORY_MAX_SEMANTIC_INPUT_CHARS) {
    throw new VectorMemoryError(
      'invalid_input',
      `The canonical job description is ${text.length} characters; the limit is ${VECTOR_MEMORY_MAX_SEMANTIC_INPUT_CHARS}.`
    );
  }

  assertNoMonetaryLeakage(text, 'the canonical job description');

  return {
    kind: 'case_text',
    semantic_input_version: CASE_TEXT_SEMANTIC_INPUT_VERSION,
    text,
    content_hash: sha256Hex(text),
    signal_count: signalCount,
    source_entity: source.source_entity,
    source_reference: source.source_reference,
  };
}

// ---------------------------------------------------------------------------
// Image observation text
// ---------------------------------------------------------------------------

/**
 * One normalised visual observation.
 *
 * A deliberately narrow intermediate shape, with adapters from the two
 * places WACRM actually holds validated observations: the live
 * `analyze_images` result, and the frozen `image_analysis` snapshot on
 * a finalized case.
 *
 * It carries no source reference at all. Message ids, media ids and
 * storage paths are traceability metadata for the embedding *row*, not
 * words in the embedded text.
 */
export interface ImageObservationRecord {
  /** Normalised category or short label. */
  category: string;
  /** Approximate count, or null when not established. */
  count: number | null;
  /** How firmly the observation is held. */
  uncertainty: 'observed' | 'ambiguous' | 'unknown';
  volume_min: number | null;
  volume_max: number | null;
  dismantling: 'indicated' | 'not_indicated' | 'unknown';
  heavy: 'indicated' | 'not_indicated' | 'unknown';
  note: string | null;
}

/**
 * Serialise validated visual observations into embeddable text.
 *
 * This produces `image_observation_text`, and the name is the whole
 * point: the output is a description of what a vision model reported
 * seeing, embedded by a *text* model. It is not a visual vector and
 * does not measure visual similarity.
 *
 * Explicitly absent from the output, in addition to the money rules:
 * storage paths, signed URLs, message ids, media ids, image bytes, and
 * the provider's raw response. A signed URL in embedding input is both
 * a credential leak and a transient value that would poison the
 * content hash.
 *
 * Ambiguity is preserved rather than resolved. An ambiguous observation
 * is emitted as its own labelled line and never merged into the
 * confident set, because "we think there may be a fridge" is not a
 * fact and must not become one by being serialised next to definite
 * observations.
 */
export function buildImageObservationSemanticInput(
  records: readonly ImageObservationRecord[]
): SemanticInput {
  const lines: string[] = [];
  let signalCount = 0;

  for (const record of records) {
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
    // Tristate indicators are emitted only when they say something.
    // "unknown" is represented by the line's absence, which is the same
    // rule the case builder uses.
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
      'There are no validated image observations to embed.'
    );
  }
  if (text.length > VECTOR_MEMORY_MAX_SEMANTIC_INPUT_CHARS) {
    throw new VectorMemoryError(
      'invalid_input',
      `The serialised image observations are ${text.length} characters; the limit is ${VECTOR_MEMORY_MAX_SEMANTIC_INPUT_CHARS}.`
    );
  }

  assertNoMonetaryLeakage(text, 'the image observation description');

  return {
    kind: 'image_observation_text',
    semantic_input_version: IMAGE_OBSERVATION_TEXT_SEMANTIC_INPUT_VERSION,
    text,
    content_hash: sha256Hex(text),
    signal_count: signalCount,
    source_entity: 'historical_case_snapshot',
    source_reference: null,
  };
}

/**
 * Adapt a live `analyze_images` result.
 *
 * The source already guarantees there are no price or weight fields in
 * the observation schema (`result.ts` rejects them by key name), and
 * `ImageSourceRef`s are dropped here rather than serialised.
 */
export function imageObservationRecordsFromAnalysis(
  result: ImageAnalysisResult
): ImageObservationRecord[] {
  const records: ImageObservationRecord[] = result.observations.map(
    (observation) => ({
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
    })
  );

  for (const item of result.ambiguous_items) {
    records.push({
      category: item.description,
      count: null,
      uncertainty: 'ambiguous',
      volume_min: null,
      volume_max: null,
      dismantling: 'unknown',
      heavy: 'unknown',
      note: null,
    });
  }

  // Low-quality imagery is recorded as its own observation rather than
  // dropped: "these photos were dark and blurry" is exactly the signal
  // objective 04 needs in order not to trust a visual match derived
  // from them.
  for (const quality of result.image_quality) {
    records.push({
      category: `image quality: ${quality.kind}`,
      count: null,
      uncertainty: 'observed',
      volume_min: null,
      volume_max: null,
      dismantling: 'unknown',
      heavy: 'unknown',
      note: quality.detail,
    });
  }

  if (result.estimated_volume_range) {
    records.push({
      category: 'overall relative volume',
      count: null,
      uncertainty: 'observed',
      volume_min: result.estimated_volume_range.min,
      volume_max: result.estimated_volume_range.max,
      dismantling: 'unknown',
      heavy: 'unknown',
      note: null,
    });
  }

  return records;
}

/**
 * Adapt a frozen `image_analysis` snapshot from a finalized case.
 *
 * The snapshot payload (written by `buildImageAnalysisPayload` in
 * `historical-cases/outcome.ts`) carries `fact_key`, `value` and the
 * source message/media ids per observation. Only the first two become
 * text; the ids are traceability for the embedding row and are dropped
 * here, so a storage path or message id can never reach the provider.
 */
export function imageObservationRecordsFromSnapshot(
  payload: unknown
): ImageObservationRecord[] {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new VectorMemoryError(
      'invalid_input',
      'The image_analysis snapshot payload must be an object'
    );
  }
  const observations = (payload as { observations?: unknown }).observations;
  if (!Array.isArray(observations)) return [];

  const records: ImageObservationRecord[] = [];
  for (const entry of observations) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const factKey =
      typeof row.fact_key === 'string' ? row.fact_key : null;
    const value =
      typeof row.value === 'string'
        ? row.value
        : typeof row.value === 'number' || typeof row.value === 'boolean'
          ? String(row.value)
          : null;
    if (factKey === null || value === null) continue;

    records.push({
      category: snapshotCategoryLabel(factKey),
      count: null,
      // An `image_observed` provenance fact is by definition something
      // the analyser reported about a photograph. It is not marked
      // ambiguous, because an ambiguous observation would never have
      // been recorded as a fact in the first place.
      uncertainty: 'observed',
      volume_min: null,
      volume_max: null,
      dismantling: 'unknown',
      heavy: 'unknown',
      note: value,
    });
  }
  return records;
}

/**
 * Human-readable label for a snapshot fact key.
 *
 * A closed map rather than the raw key, so the embedded wording is a
 * decision that can be reviewed and versioned instead of whatever a
 * future fact key happens to be called.
 */
const SNAPSHOT_CATEGORY_LABELS: Readonly<Record<string, string>> = {
  item_descriptions: 'items described',
  waste_type: 'waste type',
  estimated_volume: 'estimated volume',
  heavy_special_items: 'heavy or special items',
  item_count: 'item count',
  estimated_load_units: 'estimated load units',
  actual_load_units: 'actual load units',
  property_type: 'property type',
  floor: 'floor',
  lift_available: 'lift available',
  parking: 'parking',
  access_constraints: 'access constraints',
  dismantling_required: 'dismantling required',
  actual_dismantling_required: 'dismantling required on the day',
};

function snapshotCategoryLabel(factKey: string): string {
  return SNAPSHOT_CATEGORY_LABELS[factKey] ?? 'observed attribute';
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * SHA-256 of the exact embedded text, lowercase hex.
 *
 * Hashed over the text and nothing else. The identity tuple
 * (account, case, kind, semantic input version, provider, model,
 * model version, content hash) is what makes generation idempotent, so
 * the hash has to be a pure function of the content that was sent — not
 * of a timestamp, a row id, or a source reference that may legitimately
 * be re-pointed at the same content.
 */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Index the captured facts this builder may read.
 *
 * Monetary keys are skipped rather than merely unused, and a defensive
 * skip is the point: this is the one place where a future edit adding
 * "just one more field" could quietly pull a price into embedding
 * input. Canonical (annotation-only) facts are skipped too, since the
 * value lives on the enquiry and is read from there instead.
 */
function indexSemanticFacts(
  facts: readonly HistoricalCaseFact[]
): Map<string, HistoricalCaseFact> {
  const allowed = new Set<string>(SEMANTIC_CASE_FACT_KEYS);
  const byKey = new Map<string, HistoricalCaseFact>();
  for (const fact of facts) {
    if (fact.value_source !== 'captured') continue;
    if (isMonetaryCaseFactKey(fact.fact_key)) continue;
    if (!allowed.has(fact.fact_key)) continue;
    byKey.set(fact.fact_key, fact);
  }
  return byKey;
}

function textFact(
  facts: ReadonlyMap<string, HistoricalCaseFact>,
  key: string
): string | null {
  const fact = facts.get(key);
  return fact?.value_text ?? null;
}

function integerFact(
  facts: ReadonlyMap<string, HistoricalCaseFact>,
  key: string
): string | null {
  const fact = facts.get(key);
  return fact?.value_integer === null || fact?.value_integer === undefined
    ? null
    : String(fact.value_integer);
}

function numberFact(
  facts: ReadonlyMap<string, HistoricalCaseFact>,
  key: string
): string | null {
  const fact = facts.get(key);
  return fact?.value_number === null || fact?.value_number === undefined
    ? null
    : formatNumber(fact.value_number);
}

function factBoolean(
  facts: ReadonlyMap<string, HistoricalCaseFact>,
  key: string
): boolean | null {
  const fact = facts.get(key);
  return fact?.value_boolean ?? null;
}

/**
 * Render a tri-state as words.
 *
 * `null` yields `null` — an omitted line — rather than "no". A job
 * where nobody recorded whether there was a lift is not a job with no
 * lift, and encoding it as "no" would make an unknown indistinguishable
 * from a known negative in every downstream comparison.
 */
function tristateBoolean(
  value: boolean | null | undefined,
  whenTrue: string,
  whenFalse: string
): string | null {
  if (value === true) return whenTrue;
  if (value === false) return whenFalse;
  return null;
}

/** Collapse whitespace and lowercase, or null when there is nothing. */
function normaliseText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value !== 'string') return null;
  const collapsed = value.toLowerCase().replace(/\s+/g, ' ').trim();
  return collapsed === '' ? null : collapsed;
}

/**
 * Normalise a list-valued field.
 *
 * Accepts an array or a single string, because the same fact arrives as
 * `TEXT[]` from the live `enquiries` row and as a JSON string from a
 * snapshot payload. Sorted and de-duplicated, so two cases recorded in
 * a different order hash identically.
 */
function normaliseList(
  value: readonly string[] | string | null | undefined
): string[] {
  if (value === null || value === undefined) return [];
  const raw = Array.isArray(value) ? value : [value as string];
  const items: string[] = [];
  for (const entry of raw) {
    const normalised = normaliseText(entry);
    if (normalised !== null && !items.includes(normalised)) items.push(normalised);
  }
  return items.sort();
}

/** Stable, locale-independent number formatting. */
function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  // `toFixed` would round a measurement; `toString` is exact and does
  // not depend on the host locale.
  return String(value);
}
