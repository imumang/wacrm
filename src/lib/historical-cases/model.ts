/**
 * Objective 01 — the historical case domain model.
 *
 * A historical case is the learning-facing view of ONE enquiry/job
 * lifecycle. This module owns the vocabularies, the strict runtime
 * validation, and the deterministic evidence-quality classification.
 * `repository.ts` owns the account-scoped reads and writes.
 *
 * Four rules shaped everything here:
 *
 * 1. A case is not a CRM. Identity belongs to `enquiries`; contact,
 *    conversation, address, items and workflow state are *referenced*,
 *    never copied. This file has no field that already exists on
 *    `enquiries`, `contacts`, or `conversations`.
 *
 * 2. Unknown is not zero and estimated is not actual. Every scalar is
 *    nullable, and `provenance` sits on the individual fact rather than
 *    on the case, so "the customer said three sofas" and "a vision model
 *    thought it might be four" can both be true at once.
 *
 * 3. An AI suggestion is a prediction. It is stored as a separate fact
 *    with `ai_suggested` provenance and can never satisfy the evidence
 *    requirements of tier A or B. The database enforces the same rule on
 *    privileged writes (migration 049).
 *
 * 4. Absent evidence means "unclassified", not "the worst tier". A case
 *    with nothing recorded is never silently filed as tier F.
 *
 * Every vocabulary and every guard here is mirrored by migration 049, and
 * the two are deliberately identical in the values they accept.
 */

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/**
 * Evidence-quality tiers, roadmap A-F. `null` is a first-class value and
 * means UNCLASSIFIED: the evidence needed to place the case is absent, and
 * guessing a tier is exactly the failure mode this model exists to prevent.
 */
export const HISTORICAL_CASE_EVIDENCE_TIERS = [
  'A',
  'B',
  'C',
  'D',
  'E',
  'F',
] as const;

export type HistoricalCaseEvidenceTier =
  (typeof HISTORICAL_CASE_EVIDENCE_TIERS)[number];

/**
 * Provenance belongs to a value, not to a case.
 *
 * `ai_suggested` is a model output and is the reason this list is not just
 * a synonym for "who typed it": a typed fact and a predicted fact are not
 * the same kind of evidence, and a future learning pipeline must be able
 * to tell them apart.
 */
export const HISTORICAL_CASE_PROVENANCES = [
  'customer_stated',
  'operator_entered',
  'image_observed',
  'system_derived',
  'imported_historical',
  'ai_suggested',
  'confirmed_outcome',
] as const;

export type HistoricalCaseProvenance =
  (typeof HISTORICAL_CASE_PROVENANCES)[number];

/**
 * Learning eligibility is an operator-owned decision with three states.
 * `pending` is the default, so a case trains nothing until somebody says
 * otherwise. Retrieval eligibility is a separate concept with separate
 * rules (see `repository.ts`), because "may this train a model?" and "may
 * this be shown as a comparable job?" are different questions.
 */
export const HISTORICAL_CASE_LEARNING_ELIGIBILITIES = [
  'pending',
  'included',
  'excluded',
] as const;

export type HistoricalCaseLearningEligibility =
  (typeof HISTORICAL_CASE_LEARNING_ELIGIBILITIES)[number];

export const HISTORICAL_CASE_EXCLUSION_REASONS = [
  'incomplete',
  'ambiguous',
  'bad_data',
  'outlier',
  'operator_excluded',
  'privacy_deletion',
  'test_data',
] as const;

export type HistoricalCaseExclusionReason =
  (typeof HISTORICAL_CASE_EXCLUSION_REASONS)[number];

export const HISTORICAL_CASE_ELIGIBILITY_BASES = [
  'operator',
  'system_rule',
  'import_policy',
] as const;

export type HistoricalCaseEligibilityBasis =
  (typeof HISTORICAL_CASE_ELIGIBILITY_BASES)[number];

export const HISTORICAL_CASE_SOURCES = [
  'live_enquiry',
  'imported_historical',
] as const;

export type HistoricalCaseSource = (typeof HISTORICAL_CASE_SOURCES)[number];

export const HISTORICAL_CASE_STATES = ['open', 'finalized'] as const;

export type HistoricalCaseState = (typeof HISTORICAL_CASE_STATES)[number];

export const HISTORICAL_CASE_SNAPSHOT_KINDS = [
  'evidence_classification',
  'enquiry_facts',
  'image_analysis',
  'commercial',
  'outcome',
  /**
   * Objective 02. Records that a FINALIZED case was afterwards
   * withdrawn from training. It is the only thing that may be
   * appended about a frozen case, and it changes nothing the case
   * said - it only changes whether the case may train a model.
   * Deliberately repeatable, unlike the four finalization kinds.
   */
  'correction',
] as const;

export type HistoricalCaseSnapshotKind =
  (typeof HISTORICAL_CASE_SNAPSHOT_KINDS)[number];

/**
 * The snapshot kinds written exactly once, by finalization.
 *
 * Mirrors the partial unique index
 * `idx_historical_case_snapshots_one_finalization`, which is what makes
 * a replayed finalize unable to leave two competing answers about what
 * a training example was built from.
 */
export const HISTORICAL_CASE_FINALIZATION_SNAPSHOT_KINDS = [
  'enquiry_facts',
  'image_analysis',
  'commercial',
  'outcome',
] as const satisfies readonly HistoricalCaseSnapshotKind[];

/**
 * Version tag written next to every classification.
 *
 * Recorded so a tier can be recomputed after the rules change without
 * losing what the previous rules concluded, and so a training set can be
 * reproduced by rule version.
 */
export const HISTORICAL_CASE_RULE_VERSION = 'evidence-tier-v2';

/**
 * Version tag on the four finalization snapshots.
 *
 * Separate from the classification rule version because the two answer
 * different questions: this one says which capture shape produced the
 * frozen payload, so a training example built by an older capture
 * layout stays reproducible after the layout changes.
 */
export const HISTORICAL_CASE_FINALIZATION_VERSION = 'outcome-capture-v2-quotes';

// ---------------------------------------------------------------------------
// Fact vocabulary
// ---------------------------------------------------------------------------

export type HistoricalCaseFactValueKind =
  'text' | 'number' | 'integer' | 'boolean' | 'timestamp';

/**
 * Keys that annotate a column which already exists on `enquiries`.
 *
 * They carry a provenance and NO value: the case records where a fact came
 * from without duplicating it. This is the cheapest way to answer "was the
 * postcode customer-stated or operator-entered?" without copying the
 * postcode into a second table that could then drift.
 */
export const HISTORICAL_CASE_CANONICAL_FACT_KINDS = {
  customer_intent: 'text',
  postcode: 'text',
  address: 'text',
  property_type: 'text',
  floor: 'text',
  lift_available: 'boolean',
  parking: 'text',
  access_constraints: 'text',
  item_descriptions: 'text',
  waste_type: 'text',
  estimated_volume: 'text',
  heavy_special_items: 'text',
  photos_received: 'boolean',
} as const satisfies Record<string, HistoricalCaseFactValueKind>;

/**
 * Keys that hold a value with no canonical home, because WACRM has no
 * quote, payment, booking, or completed-job entity yet.
 *
 * Deliberately closed: a fact key is added here and in migration 049, never
 * invented at runtime. `null` is a meaningful value for all of them.
 */
export const HISTORICAL_CASE_CAPTURED_FACT_KINDS = {
  // Enquiry / access
  service_type: 'text',
  carry_distance_metres: 'integer',
  dismantling_required: 'boolean',
  // Waste / items
  item_count: 'integer',
  estimated_load_units: 'number',
  actual_load_units: 'number',
  actual_disposal_weight_kg: 'number',
  // Operations
  travel_distance_km: 'number',
  travel_time_minutes: 'integer',
  crew_count: 'integer',
  estimated_labour_minutes: 'integer',
  actual_labour_minutes: 'integer',
  // Objective 02. On-site timing is a pair of timestamps, not a
  // duration somebody estimates on the way back to the van.
  arrival_at: 'timestamp',
  departed_at: 'timestamp',
  // Commercial
  ai_suggested_amount: 'number',
  human_approved_amount: 'number',
  customer_facing_quote_amount: 'number',
  quote_decision: 'text',
  final_amount_collected: 'number',
  quote_adjustment_amount: 'number',
  quote_adjustment_reason: 'text',
  // Outcome
  outcome_no_show: 'boolean',
  final_operational_outcome: 'text',
  actual_dismantling_required: 'boolean',
  scope_changed: 'boolean',
  scope_change_type: 'text',
  scope_change_reason: 'text',
  final_job_notes: 'text',
} as const satisfies Record<string, HistoricalCaseFactValueKind>;

export type HistoricalCaseCanonicalFactKey =
  keyof typeof HISTORICAL_CASE_CANONICAL_FACT_KINDS;

export type HistoricalCaseCapturedFactKey =
  keyof typeof HISTORICAL_CASE_CAPTURED_FACT_KINDS;

export type HistoricalCaseFactKey =
  HistoricalCaseCanonicalFactKey | HistoricalCaseCapturedFactKey;

/**
 * The value vocabulary for `quote_decision`, which is the commercial
 * outcome of an enquiry: what the customer actually did about the
 * number we sent them.
 *
 * The point of extending this list (objective 02) is that "rejected"
 * was carrying four different things, and only one of them is an
 * explicit statement about our price:
 *
 * - `accepted` - the customer said yes. The only value that can begin
 *   to describe a job that will happen.
 * - `rejected_price` - the customer said the number was too high.
 *   Explicit, and about the price.
 * - `found_better_price` - the customer told us they got a lower
 *   number elsewhere. Stronger than silence, because it is a fact the
 *   customer supplied, and still NOT proof of what the job was worth.
 * - `no_response` - silence. WACRM never heard back. This is the value
 *   most likely to be mistaken for a rejection, and it is the reason
 *   the distinction exists.
 * - `cancelled_by_customer` - the customer withdrew.
 * - `other_lost` - lost for a reason that is none of the above.
 * - `rejected` - retained from objective 01 for rows recorded before
 *   the split. It is read as an explicit, if unclassified, rejection.
 * - `pending` - a decision is outstanding and expected.
 * - `unknown` - nothing was recorded. The honest default.
 *
 * **No value in the lost set is a completed-job price.** A quote the
 * customer walked away from says something about what that customer
 * would pay; it says nothing about what the job cost to do. The
 * evidence rules below keep that separation in code rather than in a
 * convention somebody has to remember.
 */
export const HISTORICAL_CASE_QUOTE_DECISIONS = [
  'accepted',
  'rejected',
  'rejected_price',
  'found_better_price',
  'no_response',
  'cancelled_by_customer',
  'other_lost',
  'pending',
  'unknown',
] as const;

export type HistoricalCaseQuoteDecision =
  (typeof HISTORICAL_CASE_QUOTE_DECISIONS)[number];

/**
 * Decisions that mean the job was lost. Every one of them places the
 * case at tier F, and none of them may be read as a completed-job
 * price.
 */
export const HISTORICAL_CASE_LOST_DECISIONS = [
  'rejected',
  'rejected_price',
  'found_better_price',
  'no_response',
  'cancelled_by_customer',
  'other_lost',
] as const satisfies readonly HistoricalCaseQuoteDecision[];

export type HistoricalCaseLostDecision =
  (typeof HISTORICAL_CASE_LOST_DECISIONS)[number];

/**
 * The subset of lost decisions where the customer actually said
 * something.
 *
 * `no_response` is deliberately NOT in here. Silence is not a
 * statement about the price, and a lost-business analysis that merges
 * "too dear" with "never replied" overstates how often this business
 * is priced out.
 */
export const HISTORICAL_CASE_EXPLICIT_REJECTION_DECISIONS = [
  'rejected',
  'rejected_price',
  'found_better_price',
] as const satisfies readonly HistoricalCaseLostDecision[];

export type HistoricalCaseExplicitRejectionDecision =
  (typeof HISTORICAL_CASE_EXPLICIT_REJECTION_DECISIONS)[number];

/** The only lost decision that is a fact the customer volunteered. */
/**
 * How the job actually ended.
 *
 * Closed, and separate from `quote_decision`: "the customer accepted
 * our quote" and "we finished the job" are different events, and a
 * case can have one without the other. A `no_show` here is a fact
 * about our attendance, not about our price.
 */
export const HISTORICAL_CASE_JOB_OUTCOMES = [
  'completed',
  'partially_completed',
  'cancelled_on_arrival',
  'no_show',
] as const;

export type HistoricalCaseJobOutcome =
  (typeof HISTORICAL_CASE_JOB_OUTCOMES)[number];

/** Job outcomes where work was actually carried out. */
export const HISTORICAL_CASE_WORKED_JOB_OUTCOMES = [
  'completed',
  'partially_completed',
] as const satisfies readonly HistoricalCaseJobOutcome[];

/**
 * Whether the job differed from what was quoted, and how.
 *
 * An operator statement, never inferred. In particular it is NOT
 * derived from the gap between the quote and the collected amount:
 * a job can collect less than quoted because the customer paid less,
 * or because less work happened, and those are completely different
 * lessons. Guessing the cause from the price difference is exactly the
 * kind of invented business fact this dataset must not contain.
 */
export const HISTORICAL_CASE_SCOPE_CHANGE_TYPES = [
  'no_material_change',
  'more_waste_than_expected',
  'less_waste_than_expected',
  'access_harder_than_expected',
  'access_easier_than_expected',
  'customer_added_work',
  'customer_removed_work',
  'other',
] as const;

export type HistoricalCaseScopeChangeType =
  (typeof HISTORICAL_CASE_SCOPE_CHANGE_TYPES)[number];

/** The one scope-change value that means "the quote was right". */
export const HISTORICAL_CASE_NO_SCOPE_CHANGE = 'no_material_change';

/** A human-issued quote: approved or sent by a person, never by a model. */
export const HISTORICAL_CASE_HUMAN_QUOTE_KEYS = [
  'human_approved_amount',
  'customer_facing_quote_amount',
] as const satisfies readonly HistoricalCaseCapturedFactKey[];

/**
 * Facts that can only be known once the job is over, AND that are
 * measured rather than judged.
 *
 * The distinction matters for the learning pipeline: `confirmed_outcome`
 * is the strongest provenance WACRM has, and it is spent on measurements
 * an observer could independently check. `crew_count`, `final_job_notes`,
 * `scope_change_type` and `final_operational_outcome` are all things a
 * person asserts about a day that has already happened; they are honest
 * and worth keeping, but they are recorded as `operator_entered` so a
 * future model can weight them against something measured.
 *
 * `arrival_at` and `departed_at` are here because nobody knows when a
 * crew turned up before it happens.
 */
export const HISTORICAL_CASE_CONFIRMED_OUTCOME_KEYS = [
  'final_amount_collected',
  'actual_load_units',
  'actual_disposal_weight_kg',
  'actual_labour_minutes',
  'arrival_at',
  'departed_at',
  'scope_change_reason',
  'final_job_notes',
] as const satisfies readonly HistoricalCaseFactKey[];

/**
 * Facts a model may never claim, whatever the code path.
 *
 * This is the feedback-loop protection: an AI suggestion is a prediction,
 * so it cannot describe a confirmed outcome, a human-issued quote, or a
 * customer decision. A case whose only money fact is `ai_suggested_amount`
 * can therefore never reach tier A or B.
 */
export const HISTORICAL_CASE_AI_FORBIDDEN_KEYS = [
  'final_amount_collected',
  'actual_load_units',
  'actual_disposal_weight_kg',
  'actual_labour_minutes',
  'arrival_at',
  'departed_at',
  'actual_dismantling_required',
  'quote_decision',
  'final_job_notes',
  'final_operational_outcome',
  'scope_changed',
  'scope_change_type',
  'scope_change_reason',
  'outcome_no_show',
  'human_approved_amount',
  'customer_facing_quote_amount',
  'quote_adjustment_amount',
  'quote_adjustment_reason',
] as const satisfies readonly HistoricalCaseFactKey[];

// Storage bounds, mirroring the CHECK constraints in migration 049.
const MAX_TEXT_VALUE_LENGTH = 2000;
const MAX_INTEGER_MAGNITUDE = 1_000_000;
const MAX_NUMBER_MAGNITUDE = 1_000_000_000;
const MAX_MEDIA_ID_LENGTH = 200;
const MAX_EVIDENCE_REASONS = 20;
const MAX_EVIDENCE_REASON_LENGTH = 200;
export const HISTORICAL_CASE_SNAPSHOT_MAX_BYTES = 16_384;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface HistoricalCase {
  id: string;
  account_id: string;
  enquiry_id: string;
  conversation_id: string;
  contact_id: string;
  source_kind: HistoricalCaseSource;
  case_state: HistoricalCaseState;
  completed_at: string | null;
  evidence_quality_tier: HistoricalCaseEvidenceTier | null;
  evidence_rule_version: string | null;
  evidence_reasons: string[];
  evidence_classified_at: string | null;
  learning_eligibility: HistoricalCaseLearningEligibility;
  learning_exclusion_reason: HistoricalCaseExclusionReason | null;
  learning_eligibility_basis: HistoricalCaseEligibilityBasis | null;
  finalized_at: string | null;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface HistoricalCaseFact {
  id: string;
  account_id: string;
  case_id: string;
  fact_key: HistoricalCaseFactKey;
  value_source: 'canonical' | 'captured';
  value_text: string | null;
  value_number: number | null;
  value_integer: number | null;
  value_boolean: boolean | null;
  value_timestamp: string | null;
  provenance: HistoricalCaseProvenance;
  source_message_id: string | null;
  source_media_id: string | null;
  observed_at: string | null;
  recorded_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface HistoricalCaseFactInput {
  fact_key: HistoricalCaseFactKey;
  value_source: 'canonical' | 'captured';
  provenance: HistoricalCaseProvenance;
  value_text?: string | null;
  value_number?: number | null;
  value_integer?: number | null;
  value_boolean?: boolean | null;
  value_timestamp?: string | null;
  source_message_id?: string | null;
  source_media_id?: string | null;
  observed_at?: string | null;
  recorded_by_user_id?: string | null;
}

export interface HistoricalCaseSnapshot {
  id: string;
  account_id: string;
  case_id: string;
  snapshot_kind: HistoricalCaseSnapshotKind;
  payload: Record<string, unknown>;
  source_version: string;
  recorded_by_user_id: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class HistoricalCaseValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HistoricalCaseValidationError';
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const TIER_SET = new Set<string>(HISTORICAL_CASE_EVIDENCE_TIERS);
const PROVENANCE_SET = new Set<string>(HISTORICAL_CASE_PROVENANCES);
const ELIGIBILITY_SET = new Set<string>(HISTORICAL_CASE_LEARNING_ELIGIBILITIES);
const EXCLUSION_REASON_SET = new Set<string>(HISTORICAL_CASE_EXCLUSION_REASONS);
const ELIGIBILITY_BASIS_SET = new Set<string>(
  HISTORICAL_CASE_ELIGIBILITY_BASES
);
const SOURCE_SET = new Set<string>(HISTORICAL_CASE_SOURCES);
const STATE_SET = new Set<string>(HISTORICAL_CASE_STATES);
const SNAPSHOT_KIND_SET = new Set<string>(HISTORICAL_CASE_SNAPSHOT_KINDS);
const QUOTE_DECISION_SET = new Set<string>(HISTORICAL_CASE_QUOTE_DECISIONS);
const LOST_DECISION_SET = new Set<string>(HISTORICAL_CASE_LOST_DECISIONS);
const EXPLICIT_REJECTION_SET = new Set<string>(
  HISTORICAL_CASE_EXPLICIT_REJECTION_DECISIONS
);
const JOB_OUTCOME_SET = new Set<string>(HISTORICAL_CASE_JOB_OUTCOMES);
const SCOPE_CHANGE_SET = new Set<string>(HISTORICAL_CASE_SCOPE_CHANGE_TYPES);
const AI_FORBIDDEN_SET = new Set<string>(HISTORICAL_CASE_AI_FORBIDDEN_KEYS);
const CONFIRMED_OUTCOME_SET = new Set<string>(
  HISTORICAL_CASE_CONFIRMED_OUTCOME_KEYS
);
const HUMAN_QUOTE_SET = new Set<string>(HISTORICAL_CASE_HUMAN_QUOTE_KEYS);

export function isHistoricalCaseFactKey(
  value: unknown
): value is HistoricalCaseFactKey {
  return (
    typeof value === 'string' &&
    (isCanonicalFactKey(value) || isCapturedFactKey(value))
  );
}

export function isCanonicalFactKey(
  value: string
): value is HistoricalCaseCanonicalFactKey {
  return Object.hasOwn(HISTORICAL_CASE_CANONICAL_FACT_KINDS, value);
}

export function isCapturedFactKey(
  value: string
): value is HistoricalCaseCapturedFactKey {
  return Object.hasOwn(HISTORICAL_CASE_CAPTURED_FACT_KINDS, value);
}

/**
 * Which value column a key uses, or `null` for a canonical annotation key.
 * Mirrors `public.historical_case_fact_kind` in migration 049.
 */
export function historicalCaseFactKind(
  key: string
): HistoricalCaseFactValueKind | null {
  if (isCanonicalFactKey(key)) {
    return HISTORICAL_CASE_CANONICAL_FACT_KINDS[key];
  }
  if (isCapturedFactKey(key)) {
    return HISTORICAL_CASE_CAPTURED_FACT_KINDS[key];
  }
  return null;
}

export function isHistoricalCaseEvidenceTier(
  value: unknown
): value is HistoricalCaseEvidenceTier {
  return typeof value === 'string' && TIER_SET.has(value);
}

export function isHistoricalCaseProvenance(
  value: unknown
): value is HistoricalCaseProvenance {
  return typeof value === 'string' && PROVENANCE_SET.has(value);
}

/**
 * Validate one fact input against the closed vocabulary, the value-kind
 * rules, and the provenance compatibility rules.
 *
 * This is the TypeScript twin of
 * `public.historical_case_fact_shape_valid`, so a bad fact is rejected
 * before it reaches the network as well as after.
 */
export function parseHistoricalCaseFactInput(
  input: unknown
): HistoricalCaseFactInput {
  if (!isRecord(input)) {
    throw new HistoricalCaseValidationError('Case fact must be an object');
  }

  const factKey = input.fact_key;
  if (!isHistoricalCaseFactKey(factKey)) {
    throw new HistoricalCaseValidationError(
      `Unknown historical case fact key: ${String(factKey)}`
    );
  }

  const provenance = input.provenance;
  if (!isHistoricalCaseProvenance(provenance)) {
    throw new HistoricalCaseValidationError(
      `Invalid provenance: ${String(provenance)}`
    );
  }

  const canonical = isCanonicalFactKey(factKey);
  const expected = historicalCaseFactKind(
    factKey
  ) as HistoricalCaseFactValueKind;
  const valueSource = canonical ? 'canonical' : 'captured';

  if (input.value_source !== undefined && input.value_source !== valueSource) {
    throw new HistoricalCaseValidationError(
      `${factKey} must use value_source '${valueSource}'`
    );
  }

  const valueText = readNullableString(input.value_text);
  const valueNumber = readNullableNumber(input.value_number);
  const valueInteger = readNullableInteger(input.value_integer);
  const valueBoolean = readNullableBoolean(input.value_boolean);
  const valueTimestamp = readNullableTimestampValue(input.value_timestamp);

  const present = [
    valueText !== null,
    valueNumber !== null,
    valueInteger !== null,
    valueBoolean !== null,
    valueTimestamp !== null,
  ].filter(Boolean).length;

  if (canonical) {
    if (present > 0) {
      throw new HistoricalCaseValidationError(
        `${factKey} already exists on the enquiry; record its provenance only`
      );
    }
  } else {
    if (present !== 1) {
      throw new HistoricalCaseValidationError(
        `${factKey} requires exactly one value`
      );
    }
    if (expected !== 'text' && valueText !== null) {
      throw new HistoricalCaseValidationError(`${factKey} is not a text fact`);
    }
    if (expected !== 'number' && valueNumber !== null) {
      throw new HistoricalCaseValidationError(
        `${factKey} is not a numeric fact`
      );
    }
    if (expected !== 'integer' && valueInteger !== null) {
      throw new HistoricalCaseValidationError(
        `${factKey} is not an integer fact`
      );
    }
    if (expected !== 'boolean' && valueBoolean !== null) {
      throw new HistoricalCaseValidationError(
        `${factKey} is not a boolean fact`
      );
    }
    if (expected !== 'timestamp' && valueTimestamp !== null) {
      throw new HistoricalCaseValidationError(
        `${factKey} is not a timestamp fact`
      );
    }
    if (expected === 'text') {
      const trimmed = valueText?.trim() ?? '';
      if (trimmed.length < 1 || trimmed.length > MAX_TEXT_VALUE_LENGTH) {
        throw new HistoricalCaseValidationError(
          `${factKey} must be 1 to ${MAX_TEXT_VALUE_LENGTH} characters`
        );
      }
    }
    if (
      factKey === 'quote_decision' &&
      !QUOTE_DECISION_SET.has(trimmed(valueText))
    ) {
      throw new HistoricalCaseValidationError(
        `quote_decision must be one of: ${HISTORICAL_CASE_QUOTE_DECISIONS.join(', ')}`
      );
    }
    if (
      factKey === 'final_operational_outcome' &&
      !JOB_OUTCOME_SET.has(trimmed(valueText))
    ) {
      throw new HistoricalCaseValidationError(
        `final_operational_outcome must be one of: ${HISTORICAL_CASE_JOB_OUTCOMES.join(', ')}`
      );
    }
    if (
      factKey === 'scope_change_type' &&
      !SCOPE_CHANGE_SET.has(trimmed(valueText))
    ) {
      throw new HistoricalCaseValidationError(
        `scope_change_type must be one of: ${HISTORICAL_CASE_SCOPE_CHANGE_TYPES.join(', ')}`
      );
    }
  }

  // AI feedback-loop protection, in the domain layer.
  if (provenance === 'ai_suggested' && AI_FORBIDDEN_SET.has(factKey)) {
    throw new HistoricalCaseValidationError(
      `${factKey} cannot carry ai_suggested provenance: an AI suggestion is a prediction, not an outcome, a human quote, or a customer decision`
    );
  }
  if (factKey === 'ai_suggested_amount' && provenance !== 'ai_suggested') {
    throw new HistoricalCaseValidationError(
      'ai_suggested_amount must carry ai_suggested provenance'
    );
  }
  if (
    provenance === 'confirmed_outcome' &&
    !CONFIRMED_OUTCOME_SET.has(factKey)
  ) {
    throw new HistoricalCaseValidationError(
      `${factKey} cannot be a confirmed outcome; it is not a post-job fact`
    );
  }

  const sourceMessageId = readNullableString(input.source_message_id);
  const sourceMediaId = readNullableString(input.source_media_id);

  if (provenance === 'image_observed') {
    if (sourceMessageId === null || sourceMediaId === null) {
      throw new HistoricalCaseValidationError(
        'image_observed facts must name the message and media they came from'
      );
    }
  }
  if (sourceMediaId !== null && sourceMediaId.length > MAX_MEDIA_ID_LENGTH) {
    throw new HistoricalCaseValidationError(
      `source_media_id must be at most ${MAX_MEDIA_ID_LENGTH} characters`
    );
  }

  return {
    fact_key: factKey,
    value_source: valueSource,
    provenance,
    value_text: valueText,
    value_number: valueNumber,
    value_integer: valueInteger,
    value_boolean: valueBoolean,
    value_timestamp: valueTimestamp,
    source_message_id: sourceMessageId,
    source_media_id: sourceMediaId,
    observed_at: readNullableTimestamp(input.observed_at, 'observed_at'),
    recorded_by_user_id: readNullableString(input.recorded_by_user_id),
  };
}

/** The database payload for a validated fact. Nulls are explicit. */
export function historicalCaseFactPayload(
  input: HistoricalCaseFactInput,
  accountId: string,
  caseId: string
): Record<string, unknown> {
  return {
    account_id: accountId,
    case_id: caseId,
    fact_key: input.fact_key,
    value_source: input.value_source,
    value_text: input.value_text ?? null,
    value_number: input.value_number ?? null,
    value_integer: input.value_integer ?? null,
    value_boolean: input.value_boolean ?? null,
    value_timestamp: input.value_timestamp ?? null,
    provenance: input.provenance,
    source_message_id: input.source_message_id ?? null,
    source_media_id: input.source_media_id ?? null,
    observed_at: input.observed_at ?? null,
    recorded_by_user_id: input.recorded_by_user_id ?? null,
  };
}

export function parseHistoricalCase(input: unknown): HistoricalCase {
  const row = requireRecord(input, 'historical case');

  const tier = row.evidence_quality_tier;
  if (tier !== null && !isHistoricalCaseEvidenceTier(tier)) {
    throw new HistoricalCaseValidationError(
      `Invalid evidence tier: ${String(tier)}`
    );
  }

  const eligibility = row.learning_eligibility;
  if (typeof eligibility !== 'string' || !ELIGIBILITY_SET.has(eligibility)) {
    throw new HistoricalCaseValidationError('Invalid learning_eligibility');
  }

  const exclusionReason = row.learning_exclusion_reason;
  if (
    exclusionReason !== null &&
    (typeof exclusionReason !== 'string' ||
      !EXCLUSION_REASON_SET.has(exclusionReason))
  ) {
    throw new HistoricalCaseValidationError(
      'Invalid learning_exclusion_reason'
    );
  }
  if ((eligibility === 'excluded') !== (exclusionReason !== null)) {
    throw new HistoricalCaseValidationError(
      'learning_exclusion_reason is required exactly when eligibility is excluded'
    );
  }

  const basis = row.learning_eligibility_basis;
  if (
    basis !== null &&
    (typeof basis !== 'string' || !ELIGIBILITY_BASIS_SET.has(basis))
  ) {
    throw new HistoricalCaseValidationError(
      'Invalid learning_eligibility_basis'
    );
  }
  if ((eligibility === 'pending') !== (basis === null)) {
    throw new HistoricalCaseValidationError(
      'learning_eligibility_basis is required exactly when eligibility is not pending'
    );
  }

  const finalizedAt = readNullableTimestamp(row.finalized_at, 'finalized_at');
  const caseState = row.case_state;
  if (typeof caseState !== 'string' || !STATE_SET.has(caseState)) {
    throw new HistoricalCaseValidationError('Invalid case_state');
  }
  if ((caseState === 'finalized') !== (finalizedAt !== null)) {
    throw new HistoricalCaseValidationError(
      'A case is finalized exactly when finalized_at is set'
    );
  }

  const classifiedAt = readNullableTimestamp(
    row.evidence_classified_at,
    'evidence_classified_at'
  );
  const ruleVersion = readNullableString(row.evidence_rule_version);
  if ((classifiedAt === null) !== (ruleVersion === null)) {
    throw new HistoricalCaseValidationError(
      'evidence_classified_at and evidence_rule_version must be set together'
    );
  }

  return {
    id: requireString(row.id, 'id'),
    account_id: requireString(row.account_id, 'account_id'),
    enquiry_id: requireString(row.enquiry_id, 'enquiry_id'),
    conversation_id: requireString(row.conversation_id, 'conversation_id'),
    contact_id: requireString(row.contact_id, 'contact_id'),
    source_kind: requireEnum(row.source_kind, SOURCE_SET, 'source_kind'),
    case_state: caseState as HistoricalCaseState,
    completed_at: readNullableTimestamp(row.completed_at, 'completed_at'),
    evidence_quality_tier: tier as HistoricalCaseEvidenceTier | null,
    evidence_rule_version: ruleVersion,
    evidence_reasons: readEvidenceReasons(row.evidence_reasons),
    evidence_classified_at: classifiedAt,
    learning_eligibility: eligibility as HistoricalCaseLearningEligibility,
    learning_exclusion_reason:
      exclusionReason as HistoricalCaseExclusionReason | null,
    learning_eligibility_basis: basis as HistoricalCaseEligibilityBasis | null,
    finalized_at: finalizedAt,
    created_by_user_id: readNullableString(row.created_by_user_id),
    created_at: requireString(row.created_at, 'created_at'),
    updated_at: requireString(row.updated_at, 'updated_at'),
  };
}

export function parseHistoricalCaseFact(input: unknown): HistoricalCaseFact {
  const row = requireRecord(input, 'historical case fact');

  const factKey = row.fact_key;
  if (!isHistoricalCaseFactKey(factKey)) {
    throw new HistoricalCaseValidationError(
      `Unknown historical case fact key: ${String(factKey)}`
    );
  }
  if (row.value_source !== 'canonical' && row.value_source !== 'captured') {
    throw new HistoricalCaseValidationError('Invalid value_source');
  }
  if (!isHistoricalCaseProvenance(row.provenance)) {
    throw new HistoricalCaseValidationError('Invalid provenance');
  }

  // Round-tripping through the input parser keeps the two validators in
  // step: a row that could not have been written cannot be read back.
  const validated = parseHistoricalCaseFactInput({
    fact_key: factKey,
    value_source: row.value_source,
    value_text: row.value_text ?? null,
    value_number: row.value_number ?? null,
    value_integer: row.value_integer ?? null,
    value_boolean: row.value_boolean ?? null,
    value_timestamp: row.value_timestamp ?? null,
    provenance: row.provenance,
    source_message_id: row.source_message_id ?? null,
    source_media_id: row.source_media_id ?? null,
    observed_at: row.observed_at ?? null,
    recorded_by_user_id: row.recorded_by_user_id ?? null,
  });

  return {
    id: requireString(row.id, 'id'),
    account_id: requireString(row.account_id, 'account_id'),
    case_id: requireString(row.case_id, 'case_id'),
    fact_key: validated.fact_key,
    value_source: validated.value_source,
    value_text: validated.value_text ?? null,
    value_number: validated.value_number ?? null,
    value_integer: validated.value_integer ?? null,
    value_boolean: validated.value_boolean ?? null,
    value_timestamp: validated.value_timestamp ?? null,
    provenance: validated.provenance,
    source_message_id: validated.source_message_id ?? null,
    source_media_id: validated.source_media_id ?? null,
    observed_at: validated.observed_at ?? null,
    recorded_by_user_id: validated.recorded_by_user_id ?? null,
    created_at: requireString(row.created_at, 'created_at'),
    updated_at: requireString(row.updated_at, 'updated_at'),
  };
}

export function parseLearningEligibility(input: {
  eligibility: HistoricalCaseLearningEligibility;
  reason: HistoricalCaseExclusionReason | null;
  basis: HistoricalCaseEligibilityBasis;
}): {
  eligibility: HistoricalCaseLearningEligibility;
  reason: HistoricalCaseExclusionReason | null;
  basis: HistoricalCaseEligibilityBasis;
} {
  if (!HISTORICAL_CASE_LEARNING_ELIGIBILITIES.includes(input.eligibility)) {
    throw new HistoricalCaseValidationError('Invalid learning eligibility');
  }
  if (!HISTORICAL_CASE_ELIGIBILITY_BASES.includes(input.basis)) {
    throw new HistoricalCaseValidationError('Invalid eligibility basis');
  }
  if (input.eligibility === 'excluded') {
    if (input.reason === null) {
      throw new HistoricalCaseValidationError(
        'An excluded case must say why it is excluded'
      );
    }
    if (!HISTORICAL_CASE_EXCLUSION_REASONS.includes(input.reason)) {
      throw new HistoricalCaseValidationError('Invalid exclusion reason');
    }
  } else if (input.reason !== null) {
    throw new HistoricalCaseValidationError(
      'Only an excluded case may carry an exclusion reason'
    );
  }
  return {
    eligibility: input.eligibility,
    reason: input.reason,
    basis: input.basis,
  };
}

export function parseSnapshotPayload(value: unknown): Record<string, unknown> {
  const payload = requireRecord(value, 'snapshot payload');
  if (
    new TextEncoder().encode(JSON.stringify(payload)).byteLength >
    HISTORICAL_CASE_SNAPSHOT_MAX_BYTES
  ) {
    throw new HistoricalCaseValidationError(
      `Snapshot payload exceeds ${HISTORICAL_CASE_SNAPSHOT_MAX_BYTES} bytes`
    );
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Evidence-quality classification
// ---------------------------------------------------------------------------

export interface HistoricalCaseEvidenceInput {
  /** The enquiry's terminal state, or null while it is still active. */
  enquiryOutcome: 'completed' | 'cancelled' | null;
  /** Whether the case itself records a completed job. */
  completedAt: string | null;
  facts: readonly HistoricalCaseFact[];
  /**
   * Canonical operational quote evidence. When present it replaces the
   * legacy quote-shaped facts for classification; final collected amount
   * still comes only from the outcome facts above.
   */
  quoteEvidence?: {
    aiSuggestionCount: number;
    humanApprovedQuoteCount: number;
    customerFacingQuoteCount: number;
    quoteDecision:
      | 'unknown'
      | 'accepted'
      | 'rejected_price'
      | 'found_better_price'
      | 'no_response'
      | 'cancelled_by_customer'
      | 'other_lost'
      | null;
  } | null;
}

export interface HistoricalCaseClassification {
  /** `null` is UNCLASSIFIED, not a low tier. */
  tier: HistoricalCaseEvidenceTier | null;
  rule_version: string;
  reasons: string[];
  /**
   * The recorded customer decision, or null when none exists.
   *
   * Carried alongside the tier rather than inside it. A tier says how
   * much a case proves; the decision says what the customer did. Six
   * different decisions all collapse to tier F, and losing that
   * distinction at this point would make "the customer said it was too
   * dear" and "the customer never replied" indistinguishable forever.
   */
  quote_decision: HistoricalCaseQuoteDecision | null;
}

export interface HistoricalCaseEvidenceSummary {
  humanQuoteAmounts: number[];
  aiSuggestedAmounts: number[];
  hasHumanQuote: boolean;
  hasAiSuggestion: boolean;
  finalAmountsCollected: number[];
  quoteDecision: HistoricalCaseQuoteDecision | null;
  confirmedOutcomeFacts: HistoricalCaseFactKey[];
  capturedFactKeys: HistoricalCaseFactKey[];
}

/**
 * Reduce a case to the handful of facts the tier rules actually read.
 * Exported so a reviewer can see exactly what the classifier sees.
 */
export function summarizeHistoricalCaseEvidence(
  input: HistoricalCaseEvidenceInput
): HistoricalCaseEvidenceSummary {
  const humanQuoteAmounts: number[] = [];
  const aiSuggestedAmounts: number[] = [];
  const finalAmountsCollected: number[] = [];
  const confirmedOutcomeFacts: HistoricalCaseFactKey[] = [];
  const capturedFactKeys: HistoricalCaseFactKey[] = [];
  let quoteDecision: HistoricalCaseQuoteDecision | null = null;
  let hasHumanQuote = false;
  let hasAiSuggestion = false;

  for (const fact of input.facts) {
    if (fact.value_source === 'captured') {
      capturedFactKeys.push(fact.fact_key);
    }
    if (fact.provenance === 'confirmed_outcome') {
      confirmedOutcomeFacts.push(fact.fact_key);
    }
    if (isHumanQuoteKey(fact.fact_key) && fact.value_number !== null) {
      humanQuoteAmounts.push(fact.value_number);
    }
    if (fact.fact_key === 'ai_suggested_amount' && fact.value_number !== null) {
      aiSuggestedAmounts.push(fact.value_number);
    }
    if (
      fact.fact_key === 'final_amount_collected' &&
      fact.provenance === 'confirmed_outcome' &&
      fact.value_number !== null
    ) {
      finalAmountsCollected.push(fact.value_number);
    }
    if (fact.fact_key === 'quote_decision' && fact.value_text !== null) {
      quoteDecision = fact.value_text as HistoricalCaseQuoteDecision;
    }
  }

  hasHumanQuote = humanQuoteAmounts.length > 0;
  hasAiSuggestion = aiSuggestedAmounts.length > 0;

  // Once a canonical quote exists, quote-shaped historical facts are legacy
  // compatibility evidence only. Do not merge the two sources or a stale fact
  // could overrule the operational quote lifecycle.
  if (input.quoteEvidence) {
    humanQuoteAmounts.length = 0;
    aiSuggestedAmounts.length = 0;
    hasHumanQuote =
      input.quoteEvidence.humanApprovedQuoteCount > 0 ||
      input.quoteEvidence.customerFacingQuoteCount > 0;
    hasAiSuggestion = input.quoteEvidence.aiSuggestionCount > 0;
    quoteDecision =
      input.quoteEvidence.quoteDecision === 'unknown'
        ? null
        : input.quoteEvidence.quoteDecision;
  }

  return {
    humanQuoteAmounts,
    aiSuggestedAmounts,
    hasHumanQuote,
    hasAiSuggestion,
    finalAmountsCollected,
    quoteDecision,
    confirmedOutcomeFacts,
    capturedFactKeys,
  };
}

/**
 * Deterministic evidence-quality classification.
 *
 * The ladder is exclusive and ordered strongest-evidence-first. It is a
 * pure function: the same case facts always produce the same tier, and a
 * missing input never produces a confident answer.
 *
 *   F  the enquiry was cancelled or abandoned, or the job was lost
 *   A  the job completed AND a confirmed final amount was captured
 *   B  the customer accepted a human quote and the job has not completed
 *   C  the customer accepted, the job is marked complete, but no final
 *      amount was captured — a known decision without a trustworthy outcome
 *   D  a human-issued quote exists and no customer decision is recorded
 *   E  an AI-suggested amount exists and nothing a human or a job produced
 *   -  UNCLASSIFIED: not enough evidence to place the case at all
 *
 * Three properties are load-bearing:
 *
 * - An AI suggestion alone can reach at most `E`. Tiers A-D all require
 *   either a confirmed outcome or a human-issued quote, and neither can be
 *   written with `ai_suggested` provenance.
 * - No tier is reachable by omission. Every one of A-F requires positive
 *   evidence of its own, so a case with only descriptive facts recorded
 *   stays UNCLASSIFIED rather than being filed as a rejected job — the
 *   single worst thing a learning dataset can do.
 * - Every lost decision lands on F, but they are NOT the same fact.
 *   `no_response` is silence and `rejected_price` is a statement the
 *   customer made; they share a tier because a tier describes how much
 *   the case proves about a job, and neither proves anything about a
 *   job. Which one it was lives on the `quote_decision` value and in
 *   the reason recorded here, so the merged tier never becomes the
 *   thing a future analysis reads.
 *
 * C is the one place where this implementation is narrower than the
 * roadmap wording ("human-issued quote with known customer decision"),
 * because that phrase overlaps A, B, and F once a decision and an outcome
 * are both recorded. C is therefore reserved for the decision that is known
 * while the trustworthy outcome is missing, which is the only remaining
 * state in that phrase.
 */
export function classifyHistoricalCaseEvidence(
  input: HistoricalCaseEvidenceInput
): HistoricalCaseClassification {
  const summary = summarizeHistoricalCaseEvidence(input);
  const hasConfirmedOutcome = summary.confirmedOutcomeFacts.length > 0;
  const hasConfirmedFinalAmount = summary.finalAmountsCollected.length > 0;
  const hasHumanQuote = summary.hasHumanQuote;
  const cancelled = input.enquiryOutcome === 'cancelled';
  const completed = input.completedAt !== null;
  const decision = summary.quoteDecision;

  const result = (
    tier: HistoricalCaseEvidenceTier | null,
    ...reasons: string[]
  ): HistoricalCaseClassification => ({
    tier,
    rule_version: HISTORICAL_CASE_RULE_VERSION,
    reasons: reasons.slice(0, MAX_EVIDENCE_REASONS),
    quote_decision: decision,
  });

  // Conflicting evidence is reported as unclassified rather than resolved
  // in either direction. Guessing here is how a dataset becomes untrustworthy.
  if (cancelled && hasConfirmedOutcome) {
    return result(
      null,
      'the enquiry is cancelled but a confirmed outcome is recorded',
      'the evidence conflicts; a human must resolve it'
    );
  }

  if (cancelled) {
    return result('F', 'the enquiry was cancelled or abandoned');
  }

  // Every lost decision is tier F - none of them describes a job that
  // happened - but each keeps its own reason, because "we were too
  // dear", "they got a better price" and "they never replied" are
  // three different commercial lessons and a lost-business analysis
  // that cannot separate them will draw the wrong conclusion.
  if (isLostDecision(decision)) {
    return result('F', ...lostDecisionReasons(decision));
  }

  if (completed && hasConfirmedFinalAmount) {
    return result(
      'A',
      'the job completed and a confirmed final amount was captured'
    );
  }

  if (decision === 'accepted' && !completed) {
    return result(
      'B',
      'the customer accepted a human quote and the job has not completed'
    );
  }

  if (decision === 'accepted') {
    return result(
      'C',
      'the customer accepted and the job is complete but no final amount was captured'
    );
  }

  if (hasHumanQuote) {
    return result(
      'D',
      'a human-issued quote exists and no customer decision is recorded'
    );
  }

  if (!summary.hasAiSuggestion && !hasConfirmedOutcome) {
    return result(
      null,
      summary.capturedFactKeys.length === 0
        ? 'no learning facts have been recorded'
        : 'no price, decision or outcome evidence has been recorded yet'
    );
  }

  return result(
    'E',
    hasConfirmedOutcome
      ? 'a confirmed outcome exists without a human-issued quote'
      : 'no human-issued quote exists; any price here is a suggestion'
  );
}

export function isHumanQuoteKey(
  key: string
): key is HistoricalCaseCapturedFactKey {
  return HUMAN_QUOTE_SET.has(key);
}

export function isLostDecision(
  value: unknown
): value is HistoricalCaseLostDecision {
  return typeof value === 'string' && LOST_DECISION_SET.has(value);
}

export function isExplicitRejectionDecision(
  value: unknown
): value is HistoricalCaseExplicitRejectionDecision {
  return (
    typeof value === 'string' && EXPLICIT_REJECTION_SET.has(value)
  );
}

/**
 * Why a case is tier F, in the customer's own terms.
 *
 * Two entries per decision on purpose: what happened, and the standing
 * instruction that it is not a price signal. The instruction travels
 * with the data, so it cannot be separated from the tier by a query
 * that only reads `evidence_reasons`.
 */
function lostDecisionReasons(decision: HistoricalCaseLostDecision): string[] {
  switch (decision) {
    case 'rejected':
      return [
        'the customer rejected the quote',
        'the reason was not classified further; this is retained from an earlier record',
        'a lost quote is commercial evidence only and is not a completed-job price',
      ];
    case 'rejected_price':
      return [
        'the customer said the quoted price was too high',
        'an explicit rejection is evidence about this customer, not about the correct job price',
      ];
    case 'found_better_price':
      return [
        'the customer said they found a better price elsewhere',
        'a competing number is a fact about the market for this quote, not a completed-job price',
      ];
    case 'no_response':
      return [
        'the customer never responded to the quote',
        'silence is not a rejection and proves nothing about the price',
      ];
    case 'cancelled_by_customer':
      return [
        'the customer cancelled before the job went ahead',
        'a cancellation is not evidence about price',
      ];
    case 'other_lost':
      return [
        'the business was lost for a reason other than the price',
        'the reason must be recorded separately; it is not a price signal',
      ];
    default:
      return ['the business was lost'];
  }
}

// ---------------------------------------------------------------------------
// Learning populations
// ---------------------------------------------------------------------------

/**
 * The populations a future training set must be able to draw from
 * SEPARATELY.
 *
 * The whole point of recording a lost quote is that it is useful
 * evidence about winning and losing business. It is not useful
 * evidence about what a job costs, and folding the two into one target
 * dataset is the single easiest way to build a price model that learns
 * from quotes nobody accepted.
 *
 * So the populations are named here rather than left to whoever
 * eventually writes the query. There is no stored column for this: it
 * is a pure function of a classification the case already carries, and
 * a second stored flag could disagree with the tier.
 */
export type HistoricalCaseLearningPopulation =
  /** Completed job with a confirmed final amount. The only price label. */
  | 'completed_trusted_price_outcome'
  /** Completed, but nobody captured what was collected. */
  | 'completed_outcome_without_final_amount'
  /** Accepted, not yet completed. A future job, not a past one. */
  | 'accepted_quote_outcome_pending'
  /** The customer said the number was too high, or went elsewhere. */
  | 'explicitly_rejected_quote'
  /** The customer never replied. Not a rejection. */
  | 'no_response_quote'
  /** Cancelled by the customer, or lost for another reason. */
  | 'other_lost_quote'
  /** Only a model has ever had an opinion about this case. */
  | 'ai_suggestion_only'
  /** Withheld from training by an operator decision. */
  | 'excluded'
  /** Nothing has been recorded that places the case. */
  | 'unclassified';

export function historicalCaseLearningPopulation(input: {
  learningEligibility: HistoricalCaseLearningEligibility;
  classification: HistoricalCaseClassification;
}): HistoricalCaseLearningPopulation {
  // An exclusion is a decision, not a description of the evidence, so
  // it wins: an excluded Tier A case is still excluded, and a future
  // pipeline must never recover it by filtering on tier instead.
  if (input.learningEligibility === 'excluded') return 'excluded';

  const decision = input.classification.quote_decision;
  switch (input.classification.tier) {
    case 'A':
      return 'completed_trusted_price_outcome';
    case 'B':
      return 'accepted_quote_outcome_pending';
    case 'C':
      return 'completed_outcome_without_final_amount';
    case 'E':
      return 'ai_suggestion_only';
    case 'F':
      if (decision === 'no_response') return 'no_response_quote';
      if (decision !== null && EXPLICIT_REJECTION_SET.has(decision)) {
        return 'explicitly_rejected_quote';
      }
      return 'other_lost_quote';
    default:
      return 'unclassified';
  }
}

// ---------------------------------------------------------------------------
// Shared readers
// ---------------------------------------------------------------------------

export function isHistoricalCaseSnapshotKind(
  value: unknown
): value is HistoricalCaseSnapshotKind {
  return typeof value === 'string' && SNAPSHOT_KIND_SET.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new HistoricalCaseValidationError(`${label} must be an object`);
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HistoricalCaseValidationError(
      `${field} must be a non-empty string`
    );
  }
  return value;
}

function requireEnum<T extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
  field: string
): T {
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new HistoricalCaseValidationError(`Invalid ${field}`);
  }
  return value as T;
}

function readNullableString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new HistoricalCaseValidationError('Expected a string or null');
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function trimmed(value: string | null): string {
  return value ?? '';
}

function readNullableNumber(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const numeric = typeof value === 'string' ? Number(value) : value;
  if (
    typeof numeric !== 'number' ||
    !Number.isFinite(numeric) ||
    Math.abs(numeric) > MAX_NUMBER_MAGNITUDE
  ) {
    throw new HistoricalCaseValidationError(
      `Expected a number within +/-${MAX_NUMBER_MAGNITUDE} or null`
    );
  }
  return numeric;
}

function readNullableInteger(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new HistoricalCaseValidationError('Expected an integer or null');
  }
  if (Math.abs(value) > MAX_INTEGER_MAGNITUDE) {
    throw new HistoricalCaseValidationError(
      `Expected an integer within +/-${MAX_INTEGER_MAGNITUDE} or null`
    );
  }
  return value;
}

function readNullableBoolean(value: unknown): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') {
    throw new HistoricalCaseValidationError('Expected a boolean or null');
  }
  return value;
}

/**
 * A stored fact timestamp.
 *
 * Stricter than {@link readNullableTimestamp}: an instant with no
 * timezone designator is rejected outright, because "08:00 on the site"
 * and "08:00 UTC" are different facts and a dataset that cannot tell
 * them apart cannot derive a labour duration from them. Postgres
 * returns `2026-03-01T09:00:00+00:00` and JavaScript produces
 * `2026-03-01T09:00:00.000Z`, so both real shapes carry a designator.
 */
function readNullableTimestampValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HistoricalCaseValidationError('Expected a timestamp or null');
  }
  const trimmed = value.trim();
  const hasZone = /[zZ]$/.test(trimmed) || /[+-]\d{2}:?\d{2}$/.test(trimmed);
  if (!hasZone || Number.isNaN(Date.parse(trimmed))) {
    throw new HistoricalCaseValidationError(
      'A stored timestamp must be an ISO-8601 instant with a timezone designator'
    );
  }
  return trimmed;
}

function readNullableTimestamp(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new HistoricalCaseValidationError(`${field} must be a timestamp`);
  }
  return value;
}

function readEvidenceReasons(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new HistoricalCaseValidationError(
      'evidence_reasons must be an array'
    );
  }
  if (value.length > MAX_EVIDENCE_REASONS) {
    throw new HistoricalCaseValidationError(
      `evidence_reasons exceeds ${MAX_EVIDENCE_REASONS} entries`
    );
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new HistoricalCaseValidationError(
        `evidence_reasons[${index}] must be a non-empty string`
      );
    }
    if (entry.length > MAX_EVIDENCE_REASON_LENGTH) {
      throw new HistoricalCaseValidationError(
        `evidence_reasons[${index}] exceeds ${MAX_EVIDENCE_REASON_LENGTH} characters`
      );
    }
    return entry;
  });
}
