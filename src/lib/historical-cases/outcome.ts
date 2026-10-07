/**
 * Objective 02 - the operational completion / lost-business capture path.
 *
 * This module owns the two questions an objective-01 case could not
 * answer:
 *
 *   1. "What actually happened on this job, and what did we collect?"
 *   2. "Why did we lose this one?"
 *
 * Everything here writes through the case fact vocabulary from
 * migration 049 / 050 rather than inventing a job, quote, payment, or
 * booking entity. That is a deliberate constraint, not an
 * inconvenience: a second place to record a price is a second place
 * where a price can be wrong, and this dataset's value depends on
 * there being exactly one answer to "what did we collect".
 *
 * Four rules shape every function below.
 *
 * 1. **The caller never chooses provenance.** `parseCompletedJobOutcome`
 *    assigns it, per fact, from a fixed table. An operator cannot
 *    promote a note they typed into a `confirmed_outcome` measurement,
 *    and - the point of the whole exercise - neither can a model.
 *
 * 2. **Unknown stays unknown.** Every measurement is optional. If
 *    nobody weighed the load, `actual_disposal_weight_kg` is absent;
 *    it is never zero, and it is never estimated from the photograph.
 *
 * 3. **Actual is not estimated, and load is not weight.** `actual_load_units`
 *    and `actual_disposal_weight_kg` are separate facts with separate
 *    provenances. Nothing here converts between them, because the
 *    conversion factor is a business decision nobody has made yet
 *    (see `17 - Business Inputs Needed.md`, "load-size definitions").
 *
 * 4. **A lost quote is not a price.** The lost-business path can only
 *    record what the customer did. It cannot record a final amount, and
 *    no amount on a lost case can reach tier A, because tier A
 *    requires `completed_at`.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  listImageAnalysisRunsForCase,
  loadImageAnalysisAggregate,
} from '@/lib/image-observations/repository';
import type { Quote } from '@/lib/quotes/model';
import {
  createQuoteService,
  getCanonicalQuoteHistory,
} from '@/lib/quotes/service';

import {
  HISTORICAL_CASE_FINALIZATION_SNAPSHOT_KINDS,
  HISTORICAL_CASE_FINALIZATION_VERSION,
  HISTORICAL_CASE_LOST_DECISIONS,
  HISTORICAL_CASE_WORKED_JOB_OUTCOMES,
  HISTORICAL_CASE_JOB_OUTCOMES,
  HISTORICAL_CASE_SCOPE_CHANGE_TYPES,
  HISTORICAL_CASE_NO_SCOPE_CHANGE,
  historicalCaseLearningPopulation,
  parseHistoricalCase,
  parseLearningEligibility,
  type HistoricalCase,
  type HistoricalCaseClassification,
  type HistoricalCaseEligibilityBasis,
  type HistoricalCaseExclusionReason,
  type HistoricalCaseFact,
  type HistoricalCaseFactInput,
  type HistoricalCaseJobOutcome,
  type HistoricalCaseLearningPopulation,
  type HistoricalCaseLostDecision,
  type HistoricalCaseSnapshot,
} from './model';
import {
  HISTORICAL_CASE_COLUMNS,
  HistoricalCaseRepositoryError,
  appendHistoricalCaseSnapshot,
  classifyHistoricalCase,
  ensureHistoricalCase,
  freezeHistoricalCase,
  getHistoricalCase,
  getHistoricalCaseFacts,
  getHistoricalCaseSnapshots,
  loadEnquiryFactsForCapture,
  type HistoricalCaseEnquirySnapshotRow,
  recordHistoricalCaseFact,
  setHistoricalCaseCompleted,
  setHistoricalCaseLearningEligibility,
} from './repository';

// ---------------------------------------------------------------------------
// Bounds
//
// Input hygiene, not business rules. The business has not defined a
// maximum van load or a maximum crew, so these are deliberately loose:
// they exist to reject a mistyped "18000" or a negative weight, not to
// encode a policy.
// ---------------------------------------------------------------------------

const MAX_LOAD_UNITS = 1_000;
const MAX_DISPOSAL_WEIGHT_KG = 100_000;
const MAX_CREW_COUNT = 20;
const MAX_NOTES_LENGTH = 2_000;

const JOB_OUTCOME_SET = new Set<string>(HISTORICAL_CASE_JOB_OUTCOMES);
const WORKED_SET = new Set<string>(HISTORICAL_CASE_WORKED_JOB_OUTCOMES);
const LOST_SET = new Set<string>(HISTORICAL_CASE_LOST_DECISIONS);
const SCOPE_CHANGE_SET = new Set<string>(HISTORICAL_CASE_SCOPE_CHANGE_TYPES);

// ---------------------------------------------------------------------------
// Completed job
// ---------------------------------------------------------------------------

/**
 * What an operator can record about a job that has finished.
 *
 * Required: the operational outcome, and - for a job where work was
 * actually done - the completion time and the amount collected.
 * Everything else is optional and honestly so: a crew that did not
 * weigh the load did not weigh the load.
 */
export interface CompletedJobOutcomeInput {
  /** How the job ended. Always required. */
  final_operational_outcome: unknown;
  /** When the job finished. Required for a worked job. */
  completed_at?: unknown;
  /** What was actually collected. Required for a worked job. */
  final_amount_collected?: unknown;
  /**
   * Loads removed, as a fraction. `0.5`, `1`, `1.5`, `2` are all
   * ordinary values. There is no kilograms-per-load conversion and
   * none is assumed here.
   */
  actual_load_units?: unknown;
  /** Total weight handed to the disposal site. Canonical unit: kg. */
  actual_disposal_weight_kg?: unknown;
  /**
   * Optional pointer to the message holding the weighbridge ticket or
   * disposal receipt, so the number is falsifiable later.
   *
   * Accepted only because the fact table already has an account-scoped
   * `source_message_id` that the database checks belongs to this
   * account. No new column and no new storage path.
   */
  disposal_weight_source_message_id?: unknown;
  arrival_at?: unknown;
  departed_at?: unknown;
  crew_count?: unknown;
  actual_dismantling_required?: unknown;
  scope_change_type?: unknown;
  scope_change_reason?: unknown;
  final_job_notes?: unknown;
}

/**
 * A validated completed-job capture, already reduced to "write these
 * facts, in this order, with these provenances".
 */
export interface CompletedJobOutcomePlan {
  final_operational_outcome: HistoricalCaseJobOutcome;
  completedAt: string | null;
  /** Ordered so both timestamps land before the duration derived from them. */
  facts: HistoricalCaseFactInput[];
  /** True when both timestamps are present and a duration was derived. */
  labourDurationMinutes: number | null;
  /**
   * True when the call supplies a complete arrival/departure pair.
   * False means the duration is unknown, which is a legitimate result.
   */
  timingComplete: boolean;
}

/**
 * Validate a completed-job capture and turn it into an ordered fact plan.
 *
 * Provenance is assigned here and is not caller-selectable. That is the
 * mechanism behind the AI feedback-loop guarantee: there is no code
 * path in this module that will write a `confirmed_outcome` for
 * anything a model produced, and the vocabulary rejects one if it were
 * tried from elsewhere.
 */
export function parseCompletedJobOutcome(
  input: unknown
): CompletedJobOutcomePlan {
  const record = requireRecord(input, 'A completed job outcome');

  const outcome = readRequiredEnum(
    record.final_operational_outcome,
    JOB_OUTCOME_SET,
    'final_operational_outcome',
    HISTORICAL_CASE_JOB_OUTCOMES
  ) as HistoricalCaseJobOutcome;
  const worked = WORKED_SET.has(outcome);

  rejectUnknownKeys(record, COMPLETED_JOB_OUTCOME_KEYS);

  const completedAt = readInstant(
    record.completed_at,
    'completed_at'
  );
  const finalAmount = readOptionalNumber(
    record.final_amount_collected,
    'final_amount_collected'
  );
  const loadUnits = readOptionalNumber(
    record.actual_load_units,
    'actual_load_units'
  );
  const weightKg = readOptionalNumber(
    record.actual_disposal_weight_kg,
    'actual_disposal_weight_kg'
  );
  const weightSourceMessageId = readOptionalId(
    record.disposal_weight_source_message_id,
    'disposal_weight_source_message_id'
  );
  const arrivalAt = readInstant(record.arrival_at, 'arrival_at');
  const departedAt = readInstant(record.departed_at, 'departed_at');
  const crewCount = readOptionalInteger(record.crew_count, 'crew_count');
  const dismantling = readOptionalBoolean(
    record.actual_dismantling_required,
    'actual_dismantling_required'
  );
  const scopeChangeType = readOptionalEnum(
    record.scope_change_type,
    SCOPE_CHANGE_SET,
    'scope_change_type',
    HISTORICAL_CASE_SCOPE_CHANGE_TYPES
  );
  const scopeChangeReason = readOptionalText(
    record.scope_change_reason,
    'scope_change_reason'
  );
  const finalJobNotes = readOptionalText(
    record.final_job_notes,
    'final_job_notes'
  );

  // --- The two required rules -------------------------------------
  //
  // A worked job must say what was collected and when it finished:
  // without those it cannot be tier A, and a case that cannot be tier
  // A is not worth finalizing as a training example.
  if (worked) {
    if (completedAt === null) {
      throw invalid(
        'completed_at is required for a job that was carried out'
      );
    }
    if (finalAmount === null) {
      throw invalid(
        'final_amount_collected is required for a job that was carried out'
      );
    }
  }

  // The converse, and it is a real constraint rather than tidiness.
  // A no-show did not complete, so stamping `completed_at` on it would
  // put it one fact away from tier A on the strength of an absence.
  if (!worked && completedAt !== null) {
    throw invalid(
      `completed_at must not be set when the outcome is '${outcome}': the job did not complete`
    );
  }

  // --- Timing ------------------------------------------------------
  if (arrivalAt !== null && departedAt !== null) {
    if (Date.parse(departedAt) <= Date.parse(arrivalAt)) {
      throw invalid('departed_at must be after arrival_at');
    }
  }

  // --- Measurements ------------------------------------------------
  //
  // Negative is never meaningful for any of these, and a zero load is
  // not a real outcome either - a crew that removed nothing did not
  // remove "0.5 of a load", they recorded nothing.
  if (loadUnits !== null && (loadUnits <= 0 || loadUnits > MAX_LOAD_UNITS)) {
    throw invalid(
      `actual_load_units must be greater than 0 and at most ${MAX_LOAD_UNITS}`
    );
  }
  if (weightKg !== null && (weightKg < 0 || weightKg > MAX_DISPOSAL_WEIGHT_KG)) {
    throw invalid(
      `actual_disposal_weight_kg must be between 0 and ${MAX_DISPOSAL_WEIGHT_KG}`
    );
  }
  if (crewCount !== null && (crewCount < 1 || crewCount > MAX_CREW_COUNT)) {
    throw invalid(`crew_count must be between 1 and ${MAX_CREW_COUNT}`);
  }
  if (
    weightSourceMessageId !== null &&
    weightKg === null
  ) {
    throw invalid(
      'disposal_weight_source_message_id requires an actual_disposal_weight_kg to point at'
    );
  }

  const labourDurationMinutes = deriveLabourMinutes(arrivalAt, departedAt);

  // --- Facts -------------------------------------------------------
  //
  // Order is not cosmetic. The database re-derives
  // `actual_labour_minutes` from the stored timestamps on every write,
  // so the duration has to be written last or it would be rejected for
  // referring to a departure that is not recorded yet.
  const facts: HistoricalCaseFactInput[] = [];

  if (arrivalAt !== null) {
    facts.push({
      fact_key: 'arrival_at',
      value_source: 'captured',
      provenance: 'confirmed_outcome',
      value_timestamp: arrivalAt,
    });
  }
  if (departedAt !== null) {
    facts.push({
      fact_key: 'departed_at',
      value_source: 'captured',
      provenance: 'confirmed_outcome',
      value_timestamp: departedAt,
    });
  }
  if (labourDurationMinutes !== null) {
    // `system_derived`, not `confirmed_outcome`: nobody measured this.
    // WACRM computed it from two observed instants, and the difference
    // is arithmetic, not evidence.
    facts.push({
      fact_key: 'actual_labour_minutes',
      value_source: 'captured',
      provenance: 'system_derived',
      value_integer: labourDurationMinutes,
    });
  }
  if (finalAmount !== null) {
    facts.push({
      fact_key: 'final_amount_collected',
      value_source: 'captured',
      provenance: 'confirmed_outcome',
      value_number: finalAmount,
    });
  }
  if (loadUnits !== null) {
    facts.push({
      fact_key: 'actual_load_units',
      value_source: 'captured',
      provenance: 'confirmed_outcome',
      value_number: loadUnits,
    });
  }
  if (weightKg !== null) {
    facts.push({
      fact_key: 'actual_disposal_weight_kg',
      value_source: 'captured',
      provenance: 'confirmed_outcome',
      value_number: weightKg,
      source_message_id: weightSourceMessageId,
    });
  }
  if (crewCount !== null) {
    facts.push({
      fact_key: 'crew_count',
      value_source: 'captured',
      provenance: 'operator_entered',
      value_integer: crewCount,
    });
  }
  if (dismantling !== null) {
    facts.push({
      fact_key: 'actual_dismantling_required',
      value_source: 'captured',
      provenance: 'operator_entered',
      value_boolean: dismantling,
    });
  }
  if (scopeChangeType !== null) {
    facts.push({
      fact_key: 'scope_change_type',
      value_source: 'captured',
      provenance: 'operator_entered',
      value_text: scopeChangeType,
    });
    // The boolean is kept for the objective-01 vocabulary, and it is
    // derived from what the operator just said rather than from the
    // price gap. `no_material_change` is the only value that means
    // "no", and it is still written as `false` rather than omitted, so
    // "the crew said nothing changed" is a recorded fact and not an
    // absence.
    facts.push({
      fact_key: 'scope_changed',
      value_source: 'captured',
      provenance: 'operator_entered',
      value_boolean: scopeChangeType !== HISTORICAL_CASE_NO_SCOPE_CHANGE,
    });
  }
  if (scopeChangeReason !== null) {
    facts.push({
      fact_key: 'scope_change_reason',
      value_source: 'captured',
      provenance: 'operator_entered',
      value_text: scopeChangeReason,
    });
  }
  if (finalJobNotes !== null) {
    facts.push({
      fact_key: 'final_job_notes',
      value_source: 'captured',
      provenance: 'operator_entered',
      value_text: finalJobNotes,
    });
  }
  // Always recorded. The operational outcome is the one fact that says
  // whether a job happened, and it is written on every capture so a
  // case cannot be finalized without it.
  facts.push({
    fact_key: 'final_operational_outcome',
    value_source: 'captured',
    provenance: 'operator_entered',
    value_text: outcome,
  });

  return {
    final_operational_outcome: outcome,
    completedAt: worked ? completedAt : null,
    facts,
    labourDurationMinutes,
    timingComplete: arrivalAt !== null && departedAt !== null,
  };
}

/**
 * The TypeScript twin of `public.historical_case_derive_labour_minutes`.
 *
 * Truncating towards zero, `null` for an incomplete or non-positive
 * pair, for the same reason the SQL does it that way: two independent
 * implementations of "how many minutes" must not disagree about a
 * value the database will re-derive and reject.
 */
export function deriveLabourMinutes(
  arrivalAt: string | null,
  departedAt: string | null
): number | null {
  if (arrivalAt === null || departedAt === null) return null;
  const elapsedMs = Date.parse(departedAt) - Date.parse(arrivalAt);
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return null;
  return Math.floor(elapsedMs / 60_000);
}

// ---------------------------------------------------------------------------
// Lost business
// ---------------------------------------------------------------------------

export interface LostBusinessOutcomeInput {
  /** Why the business was lost. Must be a value in the lost set. */
  quote_decision: unknown;
  /** Optional free-text explanation for the customer or the crew. */
  final_job_notes?: unknown;
}

export interface LostBusinessOutcomePlan {
  quote_decision: HistoricalCaseLostDecision;
  facts: HistoricalCaseFactInput[];
}

/**
 * Validate a lost-business capture.
 *
 * The input shape is the enforcement. There is no field here for a
 * collected amount, a load quantity, a weight, or an arrival time,
 * because none of those exist for a job that did not happen, and a
 * shape that cannot express a value cannot have one invented into it.
 */
export function parseLostBusinessOutcome(input: unknown): LostBusinessOutcomePlan {
  const record = requireRecord(input, 'A lost business outcome');
  rejectUnknownKeys(record, LOST_BUSINESS_OUTCOME_KEYS);

  const decision = readRequiredEnum(
    record.quote_decision,
    LOST_SET,
    'quote_decision',
    HISTORICAL_CASE_LOST_DECISIONS
  ) as HistoricalCaseLostDecision;

  const notes = readOptionalText(record.final_job_notes, 'final_job_notes');

  const facts: HistoricalCaseFactInput[] = [
    {
      fact_key: 'quote_decision',
      value_source: 'captured',
      provenance: 'operator_entered',
      value_text: decision,
    },
  ];
  if (notes !== null) {
    facts.push({
      fact_key: 'final_job_notes',
      value_source: 'captured',
      provenance: 'operator_entered',
      value_text: notes,
    });
  }

  return { quote_decision: decision, facts };
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

export interface CaptureJobOutcomeInput {
  accountId: string;
  enquiryId: string;
  /** The agent recording this. Required: a learning fact has an author. */
  recordedByUserId: string;
  /** Required only when a canonical presented quote supplies a lost decision. */
  quoteDecisionIdempotencyKey?: string;
  /**
   * `completed` and `lost` are separate shapes on purpose.
   *
   * Both are typed `unknown` rather than as their documented shape,
   * because they arrive from an operator HTTP body and are validated by
   * the parsers below - which is the only place that decides what a
   * valid capture is. Typing them structurally would mean the type
   * system claimed a guarantee the runtime still has to enforce.
   */
  outcome:
    | { kind: 'completed'; completed: unknown }
    | { kind: 'lost'; lost: unknown };
}

export interface CaptureJobOutcomeResult {
  case: HistoricalCase;
  created: boolean;
  classification: HistoricalCaseClassification;
  population: HistoricalCaseLearningPopulation;
  factsWritten: number;
}

/**
 * Record what happened to an enquiry, and recompute its evidence tier.
 *
 * The case is created if it does not exist, because an enquiry that
 * reaches the end of its life with no case has silently dropped the
 * only chance to learn from it. Creation is still explicit - it happens
 * here, in an operator-driven workflow, and nowhere in the inbound
 * message path.
 *
 * Idempotent by construction: every fact is an upsert on
 * `(case_id, fact_key)`, so re-submitting the same capture changes
 * nothing. Omitted fields are NOT written, which is what makes a
 * partial correction safe - recording a disposal weight tomorrow does
 * not erase the notes written today.
 */
export async function captureJobOutcome(
  db: SupabaseClient,
  input: CaptureJobOutcomeInput
): Promise<CaptureJobOutcomeResult> {
  const { case: ensured, created } = await ensureHistoricalCase(db, {
    accountId: input.accountId,
    enquiryId: input.enquiryId,
    createdByUserId: input.recordedByUserId,
  });

  if (ensured.finalized_at !== null) {
    throw new HistoricalCaseRepositoryError(
      'conflict',
      'This historical case is finalized and cannot be changed'
    );
  }

  const plan =
    input.outcome.kind === 'completed'
      ? parseCompletedJobOutcome(input.outcome.completed)
      : null;
  const lostPlan =
    input.outcome.kind === 'lost'
      ? parseLostBusinessOutcome(input.outcome.lost)
      : null;

  let facts = plan?.facts ?? lostPlan?.facts ?? [];

  // Canonical quotes own customer decisions going forward. Legacy cases with
  // no quote row retain the pre-052 fact path so old snapshots and imports stay
  // valid; when a quote exists, no duplicate quote_decision fact is written.
  if (lostPlan) {
    const quoteService = createQuoteService(db);
    const currentQuote = await quoteService.getCurrentQuote(
      input.accountId,
      input.enquiryId
    );
    if (currentQuote) {
      if (!input.quoteDecisionIdempotencyKey) {
        throw invalid(
          'An Idempotency-Key is required when recording a canonical quote decision'
        );
      }
      await quoteService.recordQuoteDecision({
        accountId: input.accountId,
        quoteId: currentQuote.id,
        actorUserId: input.recordedByUserId,
        idempotencyKey: input.quoteDecisionIdempotencyKey,
        decision: lostPlan.quote_decision,
      });
      facts = [];
    }
  }

  // Check the merged timing pair BEFORE writing anything. This is the
  // case where a stored duration exists and the new call supplies only
  // one half of the pair: it has to be refused rather than written,
  // because the fact table has no representation for "duration unknown"
  // once a duration is on record.
  if (plan && !plan.timingComplete) {
    const existing = await getHistoricalCaseFacts(db, {
      accountId: input.accountId,
      caseId: ensured.id,
    });
    assertNoOrphanedLabourDuration(existing, plan);
  }

  for (const fact of facts) {
    await recordHistoricalCaseFact(db, {
      accountId: input.accountId,
      caseId: ensured.id,
      fact: { ...fact, recorded_by_user_id: input.recordedByUserId },
    });
  }

  if (plan) {
    await setHistoricalCaseCompleted(db, {
      accountId: input.accountId,
      caseId: ensured.id,
      completedAt: plan.completedAt,
    });
  }

  const { case: classified, classification } = await classifyHistoricalCase(
    db,
    {
      accountId: input.accountId,
      caseId: ensured.id,
      recordedByUserId: input.recordedByUserId,
    }
  );

  return {
    case: classified,
    created,
    classification,
    population: historicalCaseLearningPopulation({
      learningEligibility: classified.learning_eligibility,
      classification,
    }),
    factsWritten: facts.length,
  };
}

/**
 * Refuse a capture that would orphan a derived labour duration.
 *
 * `actual_labour_minutes` is the one value in this vocabulary with no
 * way to say "unknown" after the fact: the fact table stores one value
 * per key and there is no delete. So the failure is raised at capture
 * time, where the operator is still looking at the form, rather than
 * being discovered later as a duration that disagrees with the
 * timestamps above it.
 */
function assertNoOrphanedLabourDuration(
  existing: readonly HistoricalCaseFact[],
  plan: CompletedJobOutcomePlan
): void {
  const storedLabour = existing.find(
    (fact) => fact.fact_key === 'actual_labour_minutes'
  );
  if (!storedLabour) return;

  const suppliesArrival = plan.facts.some(
    (fact) => fact.fact_key === 'arrival_at'
  );
  const suppliesDeparture = plan.facts.some(
    (fact) => fact.fact_key === 'departed_at'
  );
  if (suppliesArrival && suppliesDeparture) return;

  throw invalid(
    'this case already has a recorded labour duration, so arrival_at and departed_at must both be supplied again'
  );
}

// ---------------------------------------------------------------------------
// Finalization
// ---------------------------------------------------------------------------

export interface FinalizeHistoricalCaseResult {
  case: HistoricalCase;
  /** Snapshot kinds actually written by this call. */
  snapshotKinds: HistoricalCaseSnapshot['snapshot_kind'][];
  /** True when the case was already finalized and nothing was written. */
  replayed: boolean;
}

/**
 * Freeze a case into an immutable learning example.
 *
 * Four snapshots, one per designed category, each written only if the
 * facts for it exist. A case with no image observations gets no
 * `image_analysis` snapshot, because an empty section in a training
 * example reads as "we looked and found nothing" rather than "we never
 * looked" - and only one of those is true.
 *
 * Idempotent three ways over, deliberately:
 *
 *   - a case that is already finalized returns immediately;
 *   - a kind that already has a snapshot is skipped, so an interrupted
 *     run resumes instead of failing;
 *   - the database holds a unique index on one snapshot per
 *     finalization kind, so a replayed or concurrent finalize cannot
 *     leave two competing answers;
 *   - and the freeze itself is a compare-and-set on `case_state`, so
 *     exactly one caller wins and the loser reads the winner's answer.
 */
export async function finalizeHistoricalCase(
  db: SupabaseClient,
  input: {
    accountId: string;
    caseId: string;
    recordedByUserId: string;
  }
): Promise<FinalizeHistoricalCaseResult> {
  const current = await getHistoricalCase(db, input.accountId, input.caseId);
  if (!current) {
    throw new HistoricalCaseRepositoryError(
      'not_found',
      'Historical case not found'
    );
  }
  if (current.finalized_at !== null) {
    return {
      case: current,
      snapshotKinds: [],
      replayed: true,
    };
  }

  const facts = await getHistoricalCaseFacts(db, {
    accountId: input.accountId,
    caseId: input.caseId,
  });
  const enquiry = await loadEnquiryFactsForCapture(db, input.accountId, {
    enquiryId: current.enquiry_id,
  });
  const quoteHistory = await getCanonicalQuoteHistory(db, {
    accountId: input.accountId,
    enquiryId: current.enquiry_id,
  });

  // A case with nothing recorded and nothing terminal would freeze into
  // a permanently empty shell that no correction could ever fill.
  const hasCapturedFacts = facts.some(
    (fact) => fact.value_source === 'captured'
  );
  const enquiryTerminal =
    enquiry?.workflow_state === 'completed' ||
    enquiry?.workflow_state === 'cancelled';
  if (!hasCapturedFacts && quoteHistory.length === 0 && !enquiryTerminal) {
    throw invalid(
      'This case has no recorded outcome and its enquiry is still open, so there is nothing to freeze'
    );
  }

  const existing = await getHistoricalCaseSnapshots(db, {
    accountId: input.accountId,
    caseId: input.caseId,
    limit: HISTORICAL_CASE_FINALIZATION_SNAPSHOT_KINDS.length * 4,
  });
  const alreadyFrozen = new Set(
    existing
      .filter((snapshot) =>
        HISTORICAL_CASE_FINALIZATION_SNAPSHOT_KINDS.includes(
          snapshot.snapshot_kind as (typeof HISTORICAL_CASE_FINALIZATION_SNAPSHOT_KINDS)[number]
        )
      )
      .map((snapshot) => snapshot.snapshot_kind)
  );

  // Canonical per-image observations, when this case has any. Read
  // through the image-observation domain rather than derived from
  // `image_observed` facts, so the frozen snapshot is a copy of a
  // durable validated record rather than a re-derivation. A read failure
  // falls back to the facts form rather than failing finalization: losing
  // the canonical enrichment is regrettable, refusing to freeze a
  // completed job is worse.
  const imageAnalyses = await loadFinalizationImageAnalyses(db, {
    accountId: input.accountId,
    caseId: current.id,
  });

  const written: HistoricalCaseSnapshot['snapshot_kind'][] = [];
  for (const [kind, payload] of buildFinalizationPayloads(
    current,
    facts,
    enquiry,
    quoteHistory,
    imageAnalyses
  )) {
    if (alreadyFrozen.has(kind)) continue;
    if (payload === null) continue;
    try {
      await appendHistoricalCaseSnapshot(db, {
        accountId: input.accountId,
        caseId: input.caseId,
        snapshotKind: kind,
        payload,
        sourceVersion: HISTORICAL_CASE_FINALIZATION_VERSION,
        recordedByUserId: input.recordedByUserId,
      });
      written.push(kind);
    } catch (error) {
      // A concurrent finalize won the race for this kind. Its answer is
      // the answer; fall through to the compare-and-set below and let
      // the loser read the winner's frozen case.
      if (!isUniqueViolation(error)) throw error;
    }
  }

  const finalized = await freezeHistoricalCase(db, {
    accountId: input.accountId,
    caseId: input.caseId,
    finalizedAt: new Date().toISOString(),
  });
  if (finalized === null) {
    const winner = await getHistoricalCase(db, input.accountId, input.caseId);
    if (winner?.finalized_at != null) {
      return { case: winner, snapshotKinds: [], replayed: true };
    }
    throw new HistoricalCaseRepositoryError(
      'conflict',
      'The historical case changed while it was being finalized'
    );
  }

  return { case: finalized, snapshotKinds: written, replayed: false };
}

/**
 * The canonical per-image analyses of one case, for freezing.
 *
 * Never returns an observation for a withheld run. An excluded case's
 * analyses are retained for audit and are not retrievable, and freezing
 * them into a training snapshot would undo the exclusion that the
 * migration-054 trigger applied.
 *
 * Fail-soft by design. The canonical store is an enrichment, and the
 * `image_observed` facts remain the fallback representation; if the read
 * fails the case still freezes exactly as it did before this objective.
 * The failure is logged without any customer content, because the
 * alternative is that a transient read error makes a completed job
 * unfinalizable.
 */
async function loadFinalizationImageAnalyses(
  db: SupabaseClient,
  input: { accountId: string; caseId: string }
): Promise<FinalizationImageAnalysis[]> {
  try {
    const runs = await listImageAnalysisRunsForCase(db, {
      accountId: input.accountId,
      caseId: input.caseId,
    });
    const aggregates: FinalizationImageAnalysis[] = [];
    for (const run of runs) {
      if (run.status !== 'succeeded' || run.state === 'withheld') continue;
      const aggregate = await loadImageAnalysisAggregate(db, {
        accountId: input.accountId,
        runId: run.id,
      });
      aggregates.push({
        run: {
          id: run.id,
          analysis_schema_version: run.analysis_schema_version,
          prompt_version: run.prompt_version,
          analyzer_id: run.analyzer_id,
          provider: run.provider,
          model: run.model,
          result_content_hash: run.result_content_hash,
        },
        images: aggregate.images.map((image) => ({
          ordinal: image.ordinal,
          source_message_id: image.source_message_id,
          source_media_id: image.source_media_id,
        })),
        observations: aggregate.observations.map((observation) => ({
          id: observation.id,
          finding_kind: observation.finding_kind,
          ordinal_in_result: observation.ordinal_in_result,
          finding_ref: observation.finding_ref,
          kind: observation.kind,
          label: observation.label,
          confidence: observation.confidence,
          basis: observation.basis,
          detail: observation.detail,
          payload: observation.payload,
        })),
        sources: aggregate.sources.map((source) => ({
          observation_id: source.observation_id,
          source_ordinal: source.source_ordinal,
        })),
      });
    }
    return aggregates;
  } catch (error) {
    console.warn(
      '[historical-cases] canonical image observations could not be read for finalization; freezing from recorded image_observed facts instead',
      {
        account_id: input.accountId,
        case_id: input.caseId,
        error: error instanceof Error ? error.name : 'unknown',
      }
    );
    return [];
  }
}

// ---------------------------------------------------------------------------
// Snapshot payloads
// ---------------------------------------------------------------------------

/**
 * Facts that describe money, split from facts that describe the day.
 *
 * A learning pipeline that wants "what did we charge" reads the
 * commercial snapshot; one that wants "what did it involve" reads the
 * outcome snapshot. Keeping them apart is what stops a price question
 * from being answered with a load count.
 */
const COMMERCIAL_FACT_KEYS = [
  'ai_suggested_amount',
  'human_approved_amount',
  'customer_facing_quote_amount',
  'quote_decision',
  'final_amount_collected',
  'quote_adjustment_amount',
  'quote_adjustment_reason',
] as const;

// Historical snapshots are bounded to 16 KiB by the database. The canonical
// quote tables retain the full immutable audit; the learning snapshot keeps a
// compact tail and reports truncation rather than failing finalization after a
// long negotiation.
const MAX_QUOTE_REVISIONS_IN_COMMERCIAL_SNAPSHOT = 16;

const OUTCOME_FACT_KEYS = [
  'crew_count',
  'actual_load_units',
  'actual_disposal_weight_kg',
  'arrival_at',
  'departed_at',
  'actual_labour_minutes',
  'actual_dismantling_required',
  'final_operational_outcome',
  'outcome_no_show',
  'scope_changed',
  'scope_change_type',
  'scope_change_reason',
  'final_job_notes',
] as const;

/**
 * Canonical `enquiries` columns that a case may annotate.
 *
 * The snapshot copies their values as they stood at finalization and
 * separately records, per column, the provenance the case attached. A
 * frozen training example therefore answers both "what did the enquiry
 * say" and "did the customer say it, or did an operator type it".
 */
const CANONICAL_ENQUIRY_FIELDS = [
  'customer_intent',
  'postcode',
  'address',
  'property_type',
  'floor',
  'lift_available',
  'parking',
  'access_constraints',
  'item_descriptions',
  'waste_type',
  'estimated_volume',
  'heavy_special_items',
  'photos_received',
] as const;

/**
 * Build the four finalization payloads, or `null` for a category whose
 * facts do not exist.
 *
 * Exported so a test can assert what is and is not frozen without
 * standing up a database.
 */
export function buildFinalizationPayloads(
  historicalCase: HistoricalCase,
  facts: readonly HistoricalCaseFact[],
  enquiry: HistoricalCaseEnquirySnapshotRow | null,
  quoteHistory: readonly Quote[] = [],
  /**
   * The canonical persisted per-image observations for this case, when
   * any exist.
   *
   * Supplied by the caller rather than read here, for two reasons: the
   * pure builder stays testable without a database, and the case's
   * observations may be attached to it AFTER an earlier analysis was
   * recorded, so the caller is the only party that knows what is
   * currently linked.
   */
  imageAnalyses: readonly FinalizationImageAnalysis[] = []
): Array<[
  (typeof HISTORICAL_CASE_FINALIZATION_SNAPSHOT_KINDS)[number],
  Record<string, unknown> | null,
]> {
  const entries: Array<
    [
      (typeof HISTORICAL_CASE_FINALIZATION_SNAPSHOT_KINDS)[number],
      Record<string, unknown> | null,
    ]
  > = [];

  entries.push([
    'enquiry_facts',
    enquiry === null ? null : buildEnquiryFactsPayload(enquiry, facts),
  ]);
  entries.push([
    'image_analysis',
    buildImageAnalysisPayload(facts, imageAnalyses),
  ]);
  entries.push([
    'commercial',
    buildCommercialPayload(facts, quoteHistory),
  ]);
  entries.push([
    'outcome',
    buildOutcomePayload(historicalCase, facts),
  ]);

  return entries;
}

function buildCommercialPayload(
  facts: readonly HistoricalCaseFact[],
  quoteHistory: readonly Quote[]
): Record<string, unknown> | null {
  const legacy = buildKeyedPayload(COMMERCIAL_FACT_KEYS, facts);
  if (quoteHistory.length === 0) return legacy;

  const finalAmount = indexFactsByKey(facts).get('final_amount_collected');
  const quoteRevisions = quoteHistory.slice(
    -MAX_QUOTE_REVISIONS_IN_COMMERCIAL_SNAPSHOT
  );
  const totalQuoteRevisions = quoteHistory.at(-1)?.revision_number ?? 0;
  return {
    quote_source: 'canonical_quotes',
    quote_revision_count: totalQuoteRevisions,
    quote_revisions_truncated:
      (quoteRevisions[0]?.revision_number ?? 1) > 1,
    quote_revisions: quoteRevisions.map((quote) => ({
      quote_id: quote.id,
      revision_number: quote.revision_number,
      origin: quote.origin,
      status: quote.status,
      currency: quote.currency,
      amount_type: quote.amount_type,
      fixed_amount_minor: quote.fixed_amount_minor,
      range_min_minor: quote.range_min_minor,
      range_max_minor: quote.range_max_minor,
      recommendation_quote_id: quote.recommendation_quote_id,
      approved_at: quote.approved_at,
      approved_by_user_id: quote.approved_by_user_id,
      presented_at: quote.presented_at,
      presented_by_user_id: quote.presented_by_user_id,
      customer_decision: quote.customer_decision,
      decision_recorded_at: quote.decision_recorded_at,
      override_reason: quote.override_reason,
      source_observed_at: quote.source_observed_at,
    })),
    // This value remains outcome-domain truth. It is included alongside the
    // quote snapshot for comparison, never copied back into a quote.
    final_amount_collected:
      finalAmount === undefined ? null : factValue(finalAmount),
  };
}

function buildEnquiryFactsPayload(
  enquiry: HistoricalCaseEnquirySnapshotRow,
  facts: readonly HistoricalCaseFact[]
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of CANONICAL_ENQUIRY_FIELDS) {
    values[field] = enquiry[field] ?? null;
  }

  const provenance: Record<string, string> = {};
  for (const fact of facts) {
    if (fact.value_source !== 'canonical') continue;
    provenance[fact.fact_key] = fact.provenance;
  }

  const payload: Record<string, unknown> = {
    enquiry_id: enquiry.id,
    workflow_state: enquiry.workflow_state,
    state_changed_at: enquiry.state_changed_at ?? null,
    values,
  };
  if (Object.keys(provenance).length > 0) payload.provenance = provenance;
  return payload;
}

/**
 * The minimum a caller must supply for one canonical analysis to be
 * freezable.
 *
 * Declared structurally so this module does not import the
 * image-observation domain: finalization must not depend on how
 * observations are stored, and the observation domain must not be able
 * to depend on how a case is finalized.
 */
export interface FinalizationImageAnalysis {
  run: {
    id: string;
    analysis_schema_version: string;
    prompt_version: string;
    analyzer_id: string;
    provider: string;
    model: string;
    result_content_hash: string | null;
  };
  images: ReadonlyArray<{
    ordinal: number;
    source_message_id: string;
    source_media_id: string;
  }>;
  observations: ReadonlyArray<{
    /** The canonical row id, which is what a source link references. */
    id: string;
    finding_kind: 'observation' | 'ambiguous_item' | 'image_quality';
    ordinal_in_result: number;
    finding_ref: string;
    kind: string | null;
    label: string | null;
    confidence: number | null;
    basis: string | null;
    detail: string | null;
    payload: Record<string, unknown>;
  }>;
  sources: ReadonlyArray<{
    observation_id: string;
    source_ordinal: number;
  }>;
}

/**
 * The frozen `image_analysis` snapshot.
 *
 * Two sources, and the order matters.
 *
 * **Canonical persisted observations come first.** When a case has
 * canonical per-image observations (migration 054), the snapshot is
 * built from those. That is the whole point of them being canonical:
 * the frozen training example is then a copy of a durable, validated,
 * source-traceable record, so it can be reproduced from stored data
 * rather than by re-running a live vision model. Re-running a vision
 * call to reconstruct a snapshot would be both expensive and
 * non-deterministic — the same model on the same photographs can
 * legitimately produce different wording — which is the opposite of
 * reproducible.
 *
 * **`image_observed` facts are the fallback.** A case whose observations
 * were recorded as operator-visible facts before the canonical store
 * existed still freezes exactly what it froze before. Nothing about an
 * old case changes, and no old case breaks.
 *
 * Every entry names the message and media object it came from, because
 * the fact table refuses an `image_observed` fact without both, and the
 * canonical store refuses an observation with no surviving source
 * image. A snapshot of "the model saw a sofa" that cannot be traced
 * back to a photograph is not evidence.
 */
function buildImageAnalysisPayload(
  facts: readonly HistoricalCaseFact[],
  analyses: readonly FinalizationImageAnalysis[] = []
): Record<string, unknown> | null {
  const observed = facts.filter(
    (fact) => fact.provenance === 'image_observed'
  );
  const canonical = buildCanonicalImageAnalysisEntries(analyses);

  if (canonical.length === 0 && observed.length === 0) return null;
  if (canonical.length === 0) {
    return {
      source: 'image_observed_facts',
      observations: observed.map((fact) => ({
        fact_key: fact.fact_key,
        value:
          fact.value_text ??
          fact.value_number ??
          fact.value_integer ??
          fact.value_boolean ??
          fact.value_timestamp ??
          null,
        source_message_id: fact.source_message_id,
        source_media_id: fact.source_media_id,
        observed_at: fact.observed_at,
      })),
    };
  }

  const payload: Record<string, unknown> = {
    // Named explicitly so a reader knows which representation this
    // snapshot was built from, and so an old v1 snapshot with no marker
    // is unambiguously the facts form.
    source: 'canonical_image_analysis',
    analyses: canonical,
  };
  if (observed.length > 0) payload.observed_facts = observed.length;
  return payload;
}

/**
 * Per-run observation entries for the frozen snapshot.
 *
 * The version tags come along because a frozen training example that
 * does not say which observation contract and which prompt produced it
 * cannot be re-derived after either changes — which is precisely the
 * reproducibility property the snapshot exists to provide.
 */
function buildCanonicalImageAnalysisEntries(
  analyses: readonly FinalizationImageAnalysis[]
): Array<Record<string, unknown>> {
  return analyses.map((analysis) => {
    const imageByOrdinal = new Map(
      analysis.images.map((image) => [image.ordinal, image])
    );
    // Grouped once per run rather than per observation, so an
    // observation spanning three photographs is resolved from one pass
    // over the links rather than three.
    const ordinalsByObservation = new Map<string, Set<number>>();
    for (const source of analysis.sources) {
      const ordinals = ordinalsByObservation.get(source.observation_id) ?? new Set<number>();
      ordinals.add(source.source_ordinal);
      ordinalsByObservation.set(source.observation_id, ordinals);
    }

    return {
      run_id: analysis.run.id,
      analyzer_id: analysis.run.analyzer_id,
      provider: analysis.run.provider,
      model: analysis.run.model,
      analysis_schema_version: analysis.run.analysis_schema_version,
      prompt_version: analysis.run.prompt_version,
      result_content_hash: analysis.run.result_content_hash,
      images: analysis.images.map((image) => ({
        ordinal: image.ordinal,
        source_message_id: image.source_message_id,
        source_media_id: image.source_media_id,
      })),
      observations: analysis.observations.map((observation) => ({
        finding_kind: observation.finding_kind,
        ordinal_in_result: observation.ordinal_in_result,
        finding_ref: observation.finding_ref,
        kind: observation.kind,
        label: observation.label,
        confidence: observation.confidence,
        basis: observation.basis,
        detail: observation.detail,
        // The validated fields, unchanged. No live model is consulted to
        // rebuild this, which is what makes the snapshot reproducible.
        payload: observation.payload,
        // The per-image provenance, resolved exactly. An observation
        // whose links cannot be resolved gets an empty list rather than
        // an invented one: the whole value of this entry is that its
        // provenance is exact.
        sources: [...(ordinalsByObservation.get(observation.id) ?? new Set<number>())]
          .sort((left, right) => left - right)
          .map((ordinal) => {
            const image = imageByOrdinal.get(ordinal);
            return {
              source_ordinal: ordinal,
              source_message_id: image?.source_message_id ?? null,
              source_media_id: image?.source_media_id ?? null,
            };
          }),
      })),
    };
  });
}

function buildKeyedPayload(
  keys: readonly string[],
  facts: readonly HistoricalCaseFact[]
): Record<string, unknown> | null {
  const byKey = indexFactsByKey(facts);
  const payload: Record<string, unknown> = {};
  for (const key of keys) {
    const fact = byKey.get(key);
    if (!fact) continue;
    payload[key] = factValue(fact);
  }
  return Object.keys(payload).length === 0 ? null : payload;
}

function buildOutcomePayload(
  historicalCase: HistoricalCase,
  facts: readonly HistoricalCaseFact[]
): Record<string, unknown> | null {
  const payload = buildKeyedPayload(OUTCOME_FACT_KEYS, facts);
  if (payload === null) return null;
  // `completed_at` lives on the case row, not in the fact table, but it
  // is the single most important thing in an outcome snapshot: without
  // it a frozen example cannot claim the job happened.
  payload.completed_at = historicalCase.completed_at;
  return payload;
}

function indexFactsByKey(
  facts: readonly HistoricalCaseFact[]
): Map<string, HistoricalCaseFact> {
  const byKey = new Map<string, HistoricalCaseFact>();
  for (const fact of facts) {
    if (fact.value_source === 'captured') byKey.set(fact.fact_key, fact);
  }
  return byKey;
}

/**
 * The value of a fact, in its declared column.
 *
 * Exported as a helper because a snapshot has to carry the value
 * without inventing a second type system: the null that means unknown
 * has to survive the trip.
 */
function factValue(fact: HistoricalCaseFact): unknown {
  return (
    fact.value_text ??
    fact.value_number ??
    fact.value_integer ??
    fact.value_boolean ??
    fact.value_timestamp ??
    null
  );
}

// ---------------------------------------------------------------------------
// Correction
// ---------------------------------------------------------------------------

/**
 * Withdraw a FINALIZED case from training, or put it back.
 *
 * The one correction path a frozen case has. Everything the case
 * recorded stays frozen and readable, because a training example that
 * can be edited after the fact is not a training example - what this
 * changes is whether the example may be used at all.
 *
 * Reversible on purpose: `learning_eligibility` was designed as a
 * decision rather than a derivation, and a decision that cannot be
 * undone is not one an operator should be afraid to make.
 *
 * A `correction` snapshot is appended in both directions, so the trail
 * shows who changed the decision, when, and why.
 */
export async function setFinalizedCaseLearningEligibility(
  db: SupabaseClient,
  input: {
    accountId: string;
    caseId: string;
    eligibility: 'included' | 'excluded';
    reason: HistoricalCaseExclusionReason | null;
    basis: HistoricalCaseEligibilityBasis;
    recordedByUserId: string;
    /** Why this correction is being made, in the operator's words. */
    note: string;
  }
): Promise<HistoricalCase> {
  const current = await getHistoricalCase(db, input.accountId, input.caseId);
  if (!current) {
    throw new HistoricalCaseRepositoryError(
      'not_found',
      'Historical case not found'
    );
  }
  if (current.finalized_at === null) {
    // An open case uses the ordinary path, which needs no correction
    // snapshot and is not restricted by the freeze.
    return setHistoricalCaseLearningEligibility(db, {
      accountId: input.accountId,
      caseId: input.caseId,
      eligibility: input.eligibility,
      reason: input.reason,
      basis: input.basis,
    });
  }

  const note = requireBoundedText(input.note, 'note');

  const eligibility = parseLearningEligibility({
    eligibility: input.eligibility,
    reason: input.reason,
    basis: input.basis,
  });

  await appendHistoricalCaseSnapshot(db, {
    accountId: input.accountId,
    caseId: input.caseId,
    snapshotKind: 'correction',
    payload: {
      previous_eligibility: current.learning_eligibility,
      previous_exclusion_reason: current.learning_exclusion_reason,
      learning_eligibility: eligibility.eligibility,
      learning_exclusion_reason: eligibility.reason,
      learning_eligibility_basis: eligibility.basis,
      note,
    },
    sourceVersion: HISTORICAL_CASE_FINALIZATION_VERSION,
    recordedByUserId: input.recordedByUserId,
  });

  const { data, error } = await db
    .from('historical_cases')
    .update({
      learning_eligibility: eligibility.eligibility,
      learning_exclusion_reason: eligibility.reason,
      learning_eligibility_basis: eligibility.basis,
    })
    .eq('account_id', input.accountId)
    .eq('id', input.caseId)
    .select(HISTORICAL_CASE_COLUMNS)
    .maybeSingle();

  if (error) {
    throw new HistoricalCaseRepositoryError(
      'database_error',
      'Could not correct the finalized historical case'
    );
  }
  if (!data) {
    throw new HistoricalCaseRepositoryError(
      'conflict',
      'Historical case changed while it was being corrected'
    );
  }
  // Reuse the one case parser rather than re-implementing it, so a
  // corrected row is validated exactly as strictly as a freshly read one.
  return parseHistoricalCase(data);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const COMPLETED_JOB_OUTCOME_KEYS: readonly string[] = [
  'final_operational_outcome',
  'completed_at',
  'final_amount_collected',
  'actual_load_units',
  'actual_disposal_weight_kg',
  'disposal_weight_source_message_id',
  'arrival_at',
  'departed_at',
  'crew_count',
  'actual_dismantling_required',
  'scope_change_type',
  'scope_change_reason',
  'final_job_notes',
];

const LOST_BUSINESS_OUTCOME_KEYS: readonly string[] = [
  'quote_decision',
  'final_job_notes',
];

function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[]
): void {
  for (const key of Object.keys(record)) {
    if (allowed.includes(key)) continue;
    throw invalid(`Unexpected field '${key}' in a job outcome capture`);
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

function invalid(message: string): HistoricalCaseRepositoryError {
  return new HistoricalCaseRepositoryError('invalid_input', message);
}

function requireRecord(
  input: unknown,
  label: string
): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw invalid(`${label} must be an object`);
  }
  return input as Record<string, unknown>;
}

function readRequiredEnum(
  value: unknown,
  allowed: ReadonlySet<string>,
  field: string,
  vocabulary: readonly string[]
): string {
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw invalid(`${field} must be one of: ${vocabulary.join(', ')}`);
  }
  return value;
}

function readOptionalEnum(
  value: unknown,
  allowed: ReadonlySet<string>,
  field: string,
  vocabulary: readonly string[]
): string | null {
  if (value === undefined || value === null) return null;
  return readRequiredEnum(value, allowed, field, vocabulary);
}

function readOptionalNumber(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalid(`${field} must be a number or null`);
  }
  return value;
}

function readOptionalInteger(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw invalid(`${field} must be a whole number or null`);
  }
  return value;
}

function readOptionalBoolean(value: unknown, field: string): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') {
    throw invalid(`${field} must be true, false, or null`);
  }
  return value;
}

function readOptionalText(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw invalid(`${field} must be text or null`);
  }
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > MAX_NOTES_LENGTH) {
    throw invalid(`${field} must be at most ${MAX_NOTES_LENGTH} characters`);
  }
  return trimmed;
}

function requireBoundedText(value: unknown, field: string): string {
  const text = readOptionalText(value, field);
  if (text === null) {
    throw invalid(`${field} is required`);
  }
  return text;
}

function readOptionalId(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalid(`${field} must be an identifier or null`);
  }
  return value.trim();
}

/**
 * A timestamp an operator typed.
 *
 * A timezone designator is mandatory. "09:00 on site" is not an
 * instant, and accepting one would make the derived labour duration
 * depend on which server happened to read it.
 */
function readInstant(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalid(`${field} must be a timestamp or null`);
  }
  const trimmed = value.trim();
  const hasZone = /[zZ]$/.test(trimmed) || /[+-]\d{2}:?\d{2}$/.test(trimmed);
  if (!hasZone || Number.isNaN(Date.parse(trimmed))) {
    throw invalid(
      `${field} must be an ISO-8601 timestamp with a timezone designator, for example 2026-03-01T09:00:00Z`
    );
  }
  // Normalised to canonical UTC so the stored fact is one string rather
  // than whatever notation the crew's phone happened to produce. The
  // instant is what matters; the spelling is WACRM's business.
  return new Date(trimmed).toISOString();
}
