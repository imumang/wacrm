/**
 * Objective 02 (Historical Import and Normalization) - the import
 * domain model.
 *
 * This module owns the vocabularies the importer speaks in and the
 * pure decisions it makes. It performs no I/O and never touches a
 * database, which is what makes the dry run trustworthy: the dry run
 * is not a simplified version of the import, it is *this* planner
 * with the writes switched off.
 *
 * Five rules shaped everything here, and each of them exists because
 * the alternative is a dataset that cannot be trusted.
 *
 * 1. **Never invent.** A source record with no structured outcome
 *    produces a case with no outcome. The importer's job is to move
 *    evidence that already exists, not to reconstruct evidence that
 *    somebody never wrote down.
 *
 * 2. **Import quality is not evidence tier.** `import_quality` answers
 *    "did this source record map cleanly onto the case model?".
 *    `evidence_quality_tier` answers "how much does this case prove
 *    about a real job?". An enquiry can map exactly and still leave a
 *    case with no evidence at all, because the business never recorded
 *    what happened. Collapsing the two is how a dataset ends up full of
 *    tidy-looking training rows that prove nothing, so they are
 *    separate columns on separate tables and separate counters here.
 *
 * 3. **Provenance is a statement, and statements have a strength
 *    order.** An imported fact may fill a gap, but it may never
 *    replace something a person confirmed. See
 *    {@link provenanceStrength}.
 *
 * 4. **Ambiguity is reported, not resolved.** A record the importer
 *    cannot map deterministically is skipped with a reason and a
 *    sample. Guessing is available here only as a bug.
 *
 * 5. **Nothing customer-shaped goes in a log.** An import summary is
 *    ids, reasons and counts. No message body, no name, no phone, no
 *    media URL - see {@link buildImportSummary}.
 */

import {
  historicalCaseFactKind,
  type HistoricalCaseFact,
  type HistoricalCaseFactInput,
  type HistoricalCaseProvenance,
} from '../historical-cases/model';

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/**
 * The importer build that produced a plan.
 *
 * Written to every import run so a mapping change can be identified
 * without inferring it from row contents. It is a mapping version, not
 * an evidence-rule version: `HISTORICAL_CASE_RULE_VERSION` still
 * governs the tier, and an import never changes it.
 */
export const HISTORICAL_IMPORT_VERSION = 'wacrm-historical-import-v1';

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/**
 * The source adapters this importer has.
 *
 * One run, one adapter. A run that mixed sources could not be re-run
 * in isolation, and "which source did this" is the first question
 * anybody asks of a bad import.
 *
 * Note which of these actually import anything. Only `enquiries` maps
 * onto cases today; the other two are report-only adapters, and their
 * presence in this list is a statement that they were examined and
 * deliberately not mapped.
 */
export const HISTORICAL_IMPORT_SOURCE_TYPES = [
  'enquiries',
  'legacy_conversations',
  'deals',
] as const;

export type HistoricalImportSourceType =
  (typeof HISTORICAL_IMPORT_SOURCE_TYPES)[number];

/**
 * The kinds of canonical record an imported fact can be attributed to.
 *
 * Closed, because an open vocabulary would make "where did this come
 * from" unanswerable by a query. Mirrors
 * `historical_case_sources.source_kind` in migration 051.
 */
export const HISTORICAL_IMPORT_SOURCE_KINDS = [
  'enquiry',
  'legacy_conversation',
  'message',
  'deal',
  'contact',
] as const;

export type HistoricalImportSourceKind =
  (typeof HISTORICAL_IMPORT_SOURCE_KINDS)[number];

/**
 * How well one source record mapped onto the case model.
 *
 * The roadmap's vocabulary, verbatim:
 *
 * - `exact` - the record mapped with no interpretation at all. One
 *   canonical enquiry row is one job record, one-for-one.
 * - `high_confidence_mapping` - the mapping required a mechanical,
 *   reversible resolution (for example deriving a canonical storage
 *   object path from a stored media URL) and nothing more.
 * - `partial` - some of the record mapped and some of it was
 *   unusable. The unusable part is reported, not repaired.
 * - `ambiguous` - the record could plausibly mean more than one
 *   thing. Skipped rather than guessed.
 * - `unusable` - the record cannot become a case at all.
 *
 * **None of these says anything about evidence strength.** A case
 * built from an `exact` mapping can still be unclassified, because the
 * business never recorded an outcome. That separation is the whole
 * reason this vocabulary exists next to the evidence tiers instead of
 * inside them.
 */
export const HISTORICAL_IMPORT_QUALITIES = [
  'exact',
  'high_confidence_mapping',
  'partial',
  'ambiguous',
  'unusable',
] as const;

export type HistoricalImportQuality =
  (typeof HISTORICAL_IMPORT_QUALITIES)[number];

/**
 * Why a source record was not imported.
 *
 * Closed vocabulary, bounded report. `already_imported` is what makes
 * a second run a no-op rather than a duplicate; the rest are the
 * reasons this importer refuses to guess.
 */
export const HISTORICAL_IMPORT_SKIP_REASONS = [
  /** A source ledger row already attributes this record to a case. */
  'already_imported',
  /**
   * A legacy conversation with no enquiry row. There is no
   * deterministic evidence of where one job ends and the next begins,
   * so it needs operator segmentation - which is explicitly not an
   * LLM problem.
   */
  'requires_enquiry_segmentation',
  /**
   * The record's meaning is not established by the schema, the
   * application behaviour, or the documentation. `deals` is the live
   * example: a pipeline row with a `value` column is not a quote.
   */
  'source_semantics_unproven',
  /** The target case is finalized, so it accepts no new evidence. */
  'case_finalized',
  /** Nothing on the record could be mapped onto any fact key. */
  'no_mappable_facts',
  /** The record cannot become a case under any reading. */
  'unusable_source',
] as const;

export type HistoricalImportSkipReason =
  (typeof HISTORICAL_IMPORT_SKIP_REASONS)[number];

/**
 * Why imported evidence did not overwrite what was already there.
 *
 * Every one of these is a deliberate refusal. The importer never
 * replaces a confirmed value with an imported one, and never amends a
 * finalized case; it records what it found and moves on.
 */
export const HISTORICAL_IMPORT_CONFLICT_REASONS = [
  /** An existing `confirmed_outcome` outranks anything importable. */
  'confirmed_value_retained',
  /** The existing fact already carried stronger provenance. */
  'stronger_provenance_retained',
  /** Different values: the existing one is kept and the clash reported. */
  'existing_value_retained',
  /** The case is frozen, so nothing was written and nothing was changed. */
  'finalized_case_not_mutated',
  /** This source record is already attributed to a case. */
  'source_record_already_attributed',
] as const;

export type HistoricalImportConflictReason =
  (typeof HISTORICAL_IMPORT_CONFLICT_REASONS)[number];

/**
 * Run-level findings: statements about the *installation*, not about
 * one record. Bounded vocabulary words, so an operator reading a log
 * cannot be shown customer content.
 */
export const HISTORICAL_IMPORT_FINDINGS = [
  /**
   * No pre-052 structured historical quote source exists inside WACRM.
   * The canonical quote domain records the new workflow; it does not
   * retroactively prove the meaning of `deals.value` or prices mentioned
   * in old messages. Those values are never treated as quotes by this
   * importer or by an NLP extractor.
   */
  'no_structured_quote_source',
  /**
   * No structured disposal, load, labour or payment source exists, so
   * no imported case can carry an actual load, a disposal weight, a
   * labour duration or a collected amount that is anything other than
   * unknown. Those keys exist and stay empty.
   */
  'no_structured_outcome_source',
  /**
   * Legacy conversations with no enquiry row exist in this account.
   * They need deterministic operator segmentation before they can
   * become cases, and no LLM is used to guess where one job ends.
   */
  'legacy_conversations_require_segmentation',
  /**
   * The run itself failed part-way. Recorded so a `failed` run is
   * self-describing rather than needing its status column read.
   */
  'import_run_failed',
] as const;

export type HistoricalImportFinding =
  (typeof HISTORICAL_IMPORT_FINDINGS)[number];

// ---------------------------------------------------------------------------
// Bounds
//
// These mirror the CHECK constraints in migration 051. The summary has
// room for ids, reasons and counts, and no room for a transcript: that
// is what stops an import log becoming a second copy of customer
// messages.
// ---------------------------------------------------------------------------

export const HISTORICAL_IMPORT_SUMMARY_MAX_BYTES = 8_192;
export const HISTORICAL_IMPORT_MAX_REASON_KEYS = 20;
export const HISTORICAL_IMPORT_MAX_SAMPLES_PER_REASON = 10;
export const HISTORICAL_IMPORT_MAX_SAMPLE_REF_LENGTH = 64;
export const HISTORICAL_IMPORT_MAX_ERROR_DETAILS = 50;

/**
 * Records read per page, and the ceiling on how deep the importer will
 * page.
 *
 * Bounded reads are the point: a learning import runs over an
 * account's whole history, so an unbounded scan is not an option, and
 * the deepest page is refused rather than allowed to run for an hour.
 */
export const HISTORICAL_IMPORT_PAGE_SIZE = 200;
export const HISTORICAL_IMPORT_MAX_PAGE_SIZE = 500;
export const HISTORICAL_IMPORT_MAX_OFFSET = 10_000;

/**
 * Inbound media references recorded per case.
 *
 * These are *references*, not observations: the row says "this
 * conversation contains this attachment" and nothing about what is in
 * it. No image analysis runs during an import, and no AI provider is
 * called.
 */
export const HISTORICAL_IMPORT_MAX_MEDIA_PER_CASE = 20;

// ---------------------------------------------------------------------------
// Provenance strength
// ---------------------------------------------------------------------------

/**
 * How much a provenance class asserts, strongest first.
 *
 * This total order is used for exactly one decision: **may an imported
 * fact replace a fact that is already on the case?** It is not a
 * training weight and it is not a tier ordering.
 *
 * The order, and why:
 *
 * - `confirmed_outcome` is something somebody observed after the job,
 *   for a fact that can only be known after it. Nothing importable
 *   outranks it.
 * - `operator_entered` and `customer_stated` are a person asserting a
 *   fact, in WACRM or in the conversation. A person can be wrong, but
 *   they were there.
 * - `image_observed` is a validated model observation with a named
 *   source message and media id. Real evidence, and never decisive:
 *   image analysis cannot decide a price.
 * - `system_derived` is arithmetic somebody's numbers produced.
 * - `imported_historical` is the weakest claim in the vocabulary: the
 *   value arrived from a historical source and WACRM does not know who
 *   produced it or in what context. It is honest, which is why it is
 *   allowed, and it is not strong, which is why it yields.
 * - `ai_suggested` is a prediction, not evidence at all, and is last.
 *   The fact vocabulary already refuses it on every outcome, decision
 *   and human-quote key; this ordering means that even where it is
 *   permitted, it never wins.
 */
const PROVENANCE_STRENGTH: Record<HistoricalCaseProvenance, number> = {
  confirmed_outcome: 6,
  operator_entered: 5,
  customer_stated: 4,
  image_observed: 3,
  system_derived: 2,
  imported_historical: 1,
  ai_suggested: 0,
};

export function provenanceStrength(
  provenance: HistoricalCaseProvenance
): number {
  return PROVENANCE_STRENGTH[provenance];
}

/** True when `candidate` may replace `existing` without downgrading it. */
export function provenanceIsAtLeast(
  candidate: HistoricalCaseProvenance,
  existing: HistoricalCaseProvenance
): boolean {
  return provenanceStrength(candidate) >= provenanceStrength(existing);
}

// ---------------------------------------------------------------------------
// Import quality roll-up
// ---------------------------------------------------------------------------

const QUALITY_SEVERITY: Record<HistoricalImportQuality, number> = {
  exact: 0,
  high_confidence_mapping: 1,
  partial: 2,
  ambiguous: 3,
  unusable: 4,
};

/**
 * The worst quality in a set, which is the only honest summary of a
 * set. Averaging a mapping verdict would produce a number that means
 * nothing; "this batch was partially mapped" does.
 *
 * `null` for an empty set, because "no records" is not `exact`.
 */
export function worstImportQuality(
  qualities: readonly HistoricalImportQuality[]
): HistoricalImportQuality | null {
  let worst: HistoricalImportQuality | null = null;
  for (const quality of qualities) {
    if (worst === null || QUALITY_SEVERITY[quality] > QUALITY_SEVERITY[worst]) {
      worst = quality;
    }
  }
  return worst;
}

/** True for the two qualities that must never train anything. */
export function importQualityIsUntrusted(
  quality: HistoricalImportQuality
): boolean {
  return quality === 'ambiguous' || quality === 'unusable';
}

// ---------------------------------------------------------------------------
// Eligibility policy
// ---------------------------------------------------------------------------

export interface HistoricalImportEligibilityDecision {
  eligibility: 'excluded';
  reason: 'ambiguous' | 'incomplete';
  basis: 'import_policy';
}

/**
 * What an import does to a case's learning eligibility.
 *
 * `null` means "leave it alone", and that is the answer for every
 * quality except the two that must not be trained on. An imported case
 * arrives `pending` - the database default - and stays there until an
 * operator decides, because "historical data may be trusted into
 * training by arriving" is exactly the failure this whole objective
 * exists to prevent.
 *
 * An `ambiguous` or `unusable` import is different: it is not a case
 * waiting for a decision, it is a mapping the importer could not make
 * honestly. Those are excluded up front, with `import_policy` as the
 * basis, which is the basis that already existed in the objective-01
 * vocabulary for precisely this case.
 */
export function eligibilityForImportQuality(
  quality: HistoricalImportQuality
): HistoricalImportEligibilityDecision | null {
  if (quality === 'unusable') {
    return {
      eligibility: 'excluded',
      reason: 'incomplete',
      basis: 'import_policy',
    };
  }
  if (quality === 'ambiguous') {
    return {
      eligibility: 'excluded',
      reason: 'ambiguous',
      basis: 'import_policy',
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fact conflict resolution
// ---------------------------------------------------------------------------

export type HistoricalImportFactDecision =
  | { action: 'write' }
  | { action: 'skip'; reason: 'value_unchanged' }
  | { action: 'conflict'; reason: HistoricalImportConflictReason };

/**
 * Decide what happens to one imported fact, given the fact already on
 * the case. Pure, and total - every combination returns a decision.
 *
 * The ordering matters and is deliberate:
 *
 * 1. Nothing recorded -> write. Filling a gap is the whole point.
 * 2. A confirmed outcome already there -> report a conflict and keep
 *    it. An import can never demote a measurement somebody made.
 * 3. The existing provenance is stronger -> report a conflict and keep
 *    it. Provenance is not downgraded to make room for an import.
 * 4. Same value -> skip, no conflict. This is the ordinary path for a
 *    re-run and it is deliberately *not* counted as a problem.
 * 5. Otherwise the values differ -> keep the existing value and report
 *    it. The importer does not adjudicate between two readings of the
 *    same business; it writes down that they disagree.
 *
 * The one thing it never does is overwrite. A bulk import that can
 * overwrite is a bulk import that can destroy the newest confirmed
 * evidence in the account.
 */
export function decideImportedFact(
  existing: HistoricalCaseFact | null,
  incoming: HistoricalCaseFactInput
): HistoricalImportFactDecision {
  if (existing === null) {
    return { action: 'write' };
  }

  const incomingStrength = provenanceStrength(incoming.provenance);

  if (
    existing.provenance === 'confirmed_outcome' &&
    incomingStrength < provenanceStrength('confirmed_outcome')
  ) {
    return { action: 'conflict', reason: 'confirmed_value_retained' };
  }

  if (incomingStrength < provenanceStrength(existing.provenance)) {
    return { action: 'conflict', reason: 'stronger_provenance_retained' };
  }

  if (importedFactMatches(existing, incoming)) {
    return { action: 'skip', reason: 'value_unchanged' };
  }

  return { action: 'conflict', reason: 'existing_value_retained' };
}

/**
 * Whether an incoming fact would store exactly what is already there.
 *
 * Compares only the column the key actually uses, so a timestamp fact
 * is not compared against a text one, and `null` is compared as
 * "unknown" rather than coerced.
 */
export function importedFactMatches(
  existing: HistoricalCaseFact,
  incoming: HistoricalCaseFactInput
): boolean {
  if (existing.fact_key !== incoming.fact_key) return false;
  if (existing.provenance !== incoming.provenance) return false;

  switch (historicalCaseFactKind(existing.fact_key)) {
    case 'text':
      return existing.value_text === (incoming.value_text ?? null);
    case 'number':
      return existing.value_number === (incoming.value_number ?? null);
    case 'integer':
      return existing.value_integer === (incoming.value_integer ?? null);
    case 'boolean':
      return existing.value_boolean === (incoming.value_boolean ?? null);
    case 'timestamp':
      return (
        existing.value_timestamp === (incoming.value_timestamp ?? null)
      );
    // A canonical annotation key carries no value, so identity is the
    // whole comparison: same key, same provenance.
    default:
      return true;
  }
}

// ---------------------------------------------------------------------------
// Bounded summary
// ---------------------------------------------------------------------------

export interface HistoricalImportSummary {
  /** Tier counts, with `unclassified` for the explicit null tier. */
  evidence_tiers: Record<string, number>;
  /** Import-quality counts, per source record. */
  import_quality: Record<string, number>;
  /** Skip-reason counts, per source record. */
  skip_reasons: Record<string, number>;
  /** Conflict-reason counts. */
  conflict_reasons: Record<string, number>;
  /** Bounded run-level findings. */
  findings: string[];
  /** Up to ten source references per reason. Ids only. */
  samples: Record<string, string[]>;
  /**
   * What the run would do, for a dry run, and what it did, for a real
   * one.
   *
   * Separate from `cases_created` / `cases_updated` on the run row
   * because those two columns are the *written* counters, and a dry run
   * writes none. A CHECK constraint in the database refuses to record a
   * non-zero `cases_created` on a dry run, which is exactly right - the
   * column means "this run created a case" - but it would leave a dry
   * run with nowhere to say what it *would* create. That answer belongs
   * here, where it is a projection rather than a claim.
   */
  projection: HistoricalImportProjection;
}

export interface HistoricalImportProjection {
  cases_to_create: number;
  cases_to_update: number;
  cases_to_reuse: number;
  facts_to_import: number;
  media_references_to_record: number;
}

export const EMPTY_IMPORT_PROJECTION: HistoricalImportProjection = {
  cases_to_create: 0,
  cases_to_update: 0,
  cases_to_reuse: 0,
  facts_to_import: 0,
  media_references_to_record: 0,
};

export interface HistoricalImportSummaryCounters {
  evidence_tiers: Map<string, number>;
  import_quality: Map<string, number>;
  skip_reasons: Map<string, number>;
  conflict_reasons: Map<string, number>;
  findings: Set<string>;
  samples: Map<string, string[]>;
}

export function emptyImportSummaryCounters(): HistoricalImportSummaryCounters {
  return {
    evidence_tiers: new Map(),
    import_quality: new Map(),
    skip_reasons: new Map(),
    conflict_reasons: new Map(),
    findings: new Set(),
    samples: new Map(),
  };
}

/**
 * A stable, human-readable reference to one source record.
 *
 * `<kind>:<id>` - never a name, a phone number, a message body or a
 * media URL. It has to be enough for an operator to find the record,
 * and nothing more than that.
 */
export function sourceRef(
  kind: HistoricalImportSourceKind,
  recordId: string
): string {
  const ref = `${kind}:${recordId}`;
  return ref.length > HISTORICAL_IMPORT_MAX_SAMPLE_REF_LENGTH
    ? ref.slice(0, HISTORICAL_IMPORT_MAX_SAMPLE_REF_LENGTH)
    : ref;
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Record one skipped source record, with at most one sample reference. */
export function countSkip(
  counters: HistoricalImportSummaryCounters,
  reason: HistoricalImportSkipReason,
  ref: string
): void {
  bump(counters.skip_reasons, reason);
  const bucket = counters.samples.get(reason) ?? [];
  if (bucket.length < HISTORICAL_IMPORT_MAX_SAMPLES_PER_REASON) {
    bucket.push(ref);
    counters.samples.set(reason, bucket);
  }
}

export function countConflict(
  counters: HistoricalImportSummaryCounters,
  reason: HistoricalImportConflictReason,
  ref?: string
): number {
  bump(counters.conflict_reasons, reason);
  if (ref !== undefined) {
    const bucket = counters.samples.get(reason) ?? [];
    if (bucket.length < HISTORICAL_IMPORT_MAX_SAMPLES_PER_REASON) {
      bucket.push(ref);
      counters.samples.set(reason, bucket);
    }
  }
  return 1;
}

export function countQuality(
  counters: HistoricalImportSummaryCounters,
  quality: HistoricalImportQuality
): void {
  bump(counters.import_quality, quality);
}

/**
 * Record the tier the deterministic classifier produced.
 *
 * `null` is stored under `unclassified`, because "we classified it and
 * could not place it" and "we never classified it" are different
 * answers and the summary has to be able to tell them apart.
 */
export function countEvidenceTier(
  counters: HistoricalImportSummaryCounters,
  tier: string | null
): void {
  bump(counters.evidence_tiers, tier ?? 'unclassified');
}

/**
 * Freeze the counters into the summary the database stores.
 *
 * Reason maps are sorted by count then key so the same run always
 * produces the same bytes, and the whole structure is rejected if it
 * exceeds the database bound rather than being silently trimmed - a
 * summary that does not fit is a bug in the bounds, and hiding it
 * would mean an operator reviewing an import that dropped rows from
 * the report.
 */
export function buildImportSummary(
  counters: HistoricalImportSummaryCounters,
  projection: HistoricalImportProjection = EMPTY_IMPORT_PROJECTION
): HistoricalImportSummary {
  const summary: HistoricalImportSummary = {
    evidence_tiers: freezeCounts(counters.evidence_tiers),
    import_quality: freezeCounts(counters.import_quality),
    skip_reasons: freezeCounts(counters.skip_reasons),
    conflict_reasons: freezeCounts(counters.conflict_reasons),
    findings: [...counters.findings].sort(),
    samples: freezeSamples(counters.samples),
    projection,
  };

  const bytes = new TextEncoder().encode(JSON.stringify(summary)).byteLength;
  if (bytes > HISTORICAL_IMPORT_SUMMARY_MAX_BYTES) {
    throw new HistoricalImportValidationError(
      `The import summary exceeds ${HISTORICAL_IMPORT_SUMMARY_MAX_BYTES} bytes`
    );
  }
  return summary;
}

function freezeCounts(map: Map<string, number>): Record<string, number> {
  return [...map.entries()]
    .sort(([leftKey, leftCount], [rightKey, rightCount]) =>
      rightCount - leftCount || leftKey.localeCompare(rightKey)
    )
    .slice(0, HISTORICAL_IMPORT_MAX_REASON_KEYS)
    .reduce<Record<string, number>>((out, [key, count]) => {
      out[key] = count;
      return out;
    }, {});
}

function freezeSamples(
  map: Map<string, string[]>
): Record<string, string[]> {
  return [...map.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, HISTORICAL_IMPORT_MAX_REASON_KEYS)
    .reduce<Record<string, string[]>>((out, [key, refs]) => {
      out[key] = refs.slice(0, HISTORICAL_IMPORT_MAX_SAMPLES_PER_REASON);
      return out;
    }, {});
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export interface HistoricalImportRun {
  id: string;
  account_id: string;
  source_type: HistoricalImportSourceType;
  status: HistoricalImportRunStatus;
  started_at: string;
  completed_at: string | null;
  dry_run: boolean;
  records_examined: number;
  cases_created: number;
  cases_updated: number;
  cases_reused: number;
  facts_imported: number;
  records_skipped: number;
  ambiguous_records: number;
  conflicts: number;
  errors: number;
  summary: HistoricalImportSummary;
  error_metadata: HistoricalImportErrorDetail[];
  importer_version: string;
  triggered_by_user_id: string | null;
  created_at: string;
}

export const HISTORICAL_IMPORT_RUN_STATUSES = [
  'running',
  'completed',
  'completed_with_errors',
  'failed',
] as const;

export type HistoricalImportRunStatus =
  (typeof HISTORICAL_IMPORT_RUN_STATUSES)[number];

/**
 * One bounded error entry.
 *
 * Ids and a vocabulary reason. There is deliberately no `message` field
 * that could hold a database error string echoing row contents.
 */
export interface HistoricalImportErrorDetail {
  source_kind: HistoricalImportSourceKind;
  source_record_id: string;
  reason: string;
}

export interface HistoricalCaseSource {
  id: string;
  account_id: string;
  case_id: string;
  source_kind: HistoricalImportSourceKind;
  source_record_id: string;
  source_system: string;
  source_version: string | null;
  source_observed_at: string | null;
  import_run_id: string | null;
  imported_at: string;
  import_quality: HistoricalImportQuality;
  import_quality_reasons: string[];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export class HistoricalImportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HistoricalImportValidationError';
  }
}

const SOURCE_TYPE_SET = new Set<string>(HISTORICAL_IMPORT_SOURCE_TYPES);
const SOURCE_KIND_SET = new Set<string>(HISTORICAL_IMPORT_SOURCE_KINDS);
const QUALITY_SET = new Set<string>(HISTORICAL_IMPORT_QUALITIES);
const SKIP_SET = new Set<string>(HISTORICAL_IMPORT_SKIP_REASONS);
const CONFLICT_SET = new Set<string>(HISTORICAL_IMPORT_CONFLICT_REASONS);
const STATUS_SET = new Set<string>(HISTORICAL_IMPORT_RUN_STATUSES);

export function isHistoricalImportSourceType(
  value: unknown
): value is HistoricalImportSourceType {
  return typeof value === 'string' && SOURCE_TYPE_SET.has(value);
}

export function isHistoricalImportSourceKind(
  value: unknown
): value is HistoricalImportSourceKind {
  return typeof value === 'string' && SOURCE_KIND_SET.has(value);
}

export function isHistoricalImportQuality(
  value: unknown
): value is HistoricalImportQuality {
  return typeof value === 'string' && QUALITY_SET.has(value);
}

export function isHistoricalImportSkipReason(
  value: unknown
): value is HistoricalImportSkipReason {
  return typeof value === 'string' && SKIP_SET.has(value);
}

export function isHistoricalImportConflictReason(
  value: unknown
): value is HistoricalImportConflictReason {
  return typeof value === 'string' && CONFLICT_SET.has(value);
}

/**
 * Strictly parse an import run row.
 *
 * Reuses the shape of the row rather than casting it, for the same
 * reason `parseHistoricalCase` does: a row that could not have been
 * written must not be readable as though it had been. The summary is
 * parsed leniently - it is a report, not a fact - but its counters are
 * clamped to non-negative integers.
 */
export function parseHistoricalImportRun(input: unknown): HistoricalImportRun {
  const row = requireRecord(input, 'historical import run');

  const status = requireEnum<HistoricalImportRunStatus>(
    row.status,
    STATUS_SET,
    'status'
  );
  const sourceType = requireEnum<HistoricalImportSourceType>(
    row.source_type,
    SOURCE_TYPE_SET,
    'source_type'
  );
  const completedAt = readNullableString(row.completed_at);
  if ((status === 'running') !== (completedAt === null)) {
    throw new HistoricalImportValidationError(
      'an import run is finished exactly when it is not running'
    );
  }
  const dryRun = row.dry_run;
  if (typeof dryRun !== 'boolean') {
    throw new HistoricalImportValidationError('dry_run must be a boolean');
  }
  const casesCreated = readCount(row.cases_created, 'cases_created');
  const casesUpdated = readCount(row.cases_updated, 'cases_updated');
  if (dryRun && (casesCreated > 0 || casesUpdated > 0)) {
    throw new HistoricalImportValidationError(
      'a dry run cannot have created or updated a case'
    );
  }

  return {
    id: requireString(row.id, 'id'),
    account_id: requireString(row.account_id, 'account_id'),
    source_type: sourceType,
    status,
    started_at: requireString(row.started_at, 'started_at'),
    completed_at: completedAt,
    dry_run: dryRun,
    records_examined: readCount(row.records_examined, 'records_examined'),
    cases_created: casesCreated,
    cases_updated: casesUpdated,
    cases_reused: readCount(row.cases_reused, 'cases_reused'),
    facts_imported: readCount(row.facts_imported, 'facts_imported'),
    records_skipped: readCount(row.records_skipped, 'records_skipped'),
    ambiguous_records: readCount(row.ambiguous_records, 'ambiguous_records'),
    conflicts: readCount(row.conflicts, 'conflicts'),
    errors: readCount(row.errors, 'errors'),
    summary: parseSummary(row.summary),
    error_metadata: parseErrorMetadata(row.error_metadata),
    importer_version: requireString(row.importer_version, 'importer_version'),
    triggered_by_user_id: readNullableString(row.triggered_by_user_id),
    created_at: requireString(row.created_at, 'created_at'),
  };
}

export function parseHistoricalCaseSource(
  input: unknown
): HistoricalCaseSource {
  const row = requireRecord(input, 'historical case source');
  return {
    id: requireString(row.id, 'id'),
    account_id: requireString(row.account_id, 'account_id'),
    case_id: requireString(row.case_id, 'case_id'),
    source_kind: requireEnum<HistoricalImportSourceKind>(
      row.source_kind,
      SOURCE_KIND_SET,
      'source_kind'
    ),
    source_record_id: requireString(row.source_record_id, 'source_record_id'),
    source_system: requireString(row.source_system, 'source_system'),
    source_version: readNullableString(row.source_version),
    source_observed_at: readNullableString(row.source_observed_at),
    import_run_id: readNullableString(row.import_run_id),
    imported_at: requireString(row.imported_at, 'imported_at'),
    import_quality: requireEnum<HistoricalImportQuality>(
      row.import_quality,
      QUALITY_SET,
      'import_quality'
    ),
    import_quality_reasons: readReasonList(row.import_quality_reasons),
  };
}

function parseSummary(value: unknown): HistoricalImportSummary {
  const fallback = buildImportSummary(emptyImportSummaryCounters());
  if (typeof value !== 'object' || value === null) return fallback;
  const row = value as Record<string, unknown>;
  return {
    evidence_tiers: readCountMap(row.evidence_tiers),
    import_quality: readCountMap(row.import_quality),
    skip_reasons: readCountMap(row.skip_reasons),
    conflict_reasons: readCountMap(row.conflict_reasons),
    findings: Array.isArray(row.findings)
      ? row.findings
          .filter((entry): entry is string => typeof entry === 'string')
          .slice(0, HISTORICAL_IMPORT_MAX_REASON_KEYS)
      : fallback.findings,
    samples: readSamples(row.samples),
    projection: readProjection(row.projection),
  };
}

function readProjection(value: unknown): HistoricalImportProjection {
  if (typeof value !== 'object' || value === null) {
    return EMPTY_IMPORT_PROJECTION;
  }
  const row = value as Record<string, unknown>;
  return {
    cases_to_create: readCount(row.cases_to_create, 'cases_to_create'),
    cases_to_update: readCount(row.cases_to_update, 'cases_to_update'),
    cases_to_reuse: readCount(row.cases_to_reuse, 'cases_to_reuse'),
    facts_to_import: readCount(row.facts_to_import, 'facts_to_import'),
    media_references_to_record: readCount(
      row.media_references_to_record,
      'media_references_to_record'
    ),
  };
}

function parseErrorMetadata(value: unknown): HistoricalImportErrorDetail[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, HISTORICAL_IMPORT_MAX_ERROR_DETAILS)
    .flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null) return [];
      const row = entry as Record<string, unknown>;
      if (!isHistoricalImportSourceKind(row.source_kind)) return [];
      if (typeof row.source_record_id !== 'string') return [];
      return [
        {
          source_kind: row.source_kind,
          source_record_id: row.source_record_id,
          reason:
            typeof row.reason === 'string' && row.reason.trim() !== ''
              ? row.reason.trim().slice(0, 200)
              : 'unspecified',
        },
      ];
    });
}

function readCountMap(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null) return {};
  const out: Record<string, number> = {};
  for (const [key, count] of Object.entries(
    value as Record<string, unknown>
  )) {
    if (typeof count !== 'number' || !Number.isFinite(count)) continue;
    out[key] = Math.max(0, Math.trunc(count));
    if (Object.keys(out).length >= HISTORICAL_IMPORT_MAX_REASON_KEYS) break;
  }
  return out;
}

function readSamples(value: unknown): Record<string, string[]> {
  if (typeof value !== 'object' || value === null) return {};
  const out: Record<string, string[]> = {};
  for (const [key, refs] of Object.entries(
    value as Record<string, unknown>
  )) {
    if (!Array.isArray(refs)) continue;
    out[key] = refs
      .filter((ref): ref is string => typeof ref === 'string')
      .slice(0, HISTORICAL_IMPORT_MAX_SAMPLES_PER_REASON);
    if (Object.keys(out).length >= HISTORICAL_IMPORT_MAX_REASON_KEYS) break;
  }
  return out;
}

function readReasonList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.slice(0, 200));
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HistoricalImportValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HistoricalImportValidationError(
      `${field} must be a non-empty string`
    );
  }
  return value;
}

function readNullableString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  return value;
}

function requireEnum<T extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
  field: string
): T {
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new HistoricalImportValidationError(`Invalid ${field}`);
  }
  return value as T;
}

function readCount(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new HistoricalImportValidationError(
      `${field} must be a non-negative integer`
    );
  }
  return Math.max(0, Math.trunc(value));
}
