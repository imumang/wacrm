/**
 * Objective 01 — the narrow, account-scoped repository for historical cases.
 *
 * Every function here is deliberately specific. There is no generic
 * `search()`, no caller-supplied filter object, and no way to reach another
 * account's learning data. That is intentional: the future similar-job
 * retrieval service is supposed to consume a deliberate query with bounded
 * limits and an explicit eligibility rule, not to run SQL that a prompt
 * influenced.
 *
 * Two concepts that look alike are kept apart:
 *
 * - `listTrainingEligibleCases` reads only cases an operator has
 *   explicitly marked `included`. This is the model-training population.
 * - `listRetrievalCases` reads cases that are not operator-excluded and
 *   have a classified tier. A case can be a useful comparable without ever
 *   training a model, so the two filters are not the same query.
 *
 * Creation is explicit. Nothing in this module runs from the inbound
 * message path: a case exists because a human (or a future outcome-capture
 * objective) asked for one, not because somebody typed.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { getCanonicalQuoteEvidence } from '@/lib/quotes/service';

import {
  classifyHistoricalCaseEvidence,
  HISTORICAL_CASE_RULE_VERSION,
  historicalCaseFactPayload,
  parseHistoricalCase,
  parseHistoricalCaseFact,
  parseHistoricalCaseFactInput,
  parseLearningEligibility,
  parseSnapshotPayload,
  HistoricalCaseValidationError,
  isHistoricalCaseSnapshotKind,
  type HistoricalCase,
  type HistoricalCaseClassification,
  type HistoricalCaseEvidenceTier,
  type HistoricalCaseEligibilityBasis,
  type HistoricalCaseExclusionReason,
  type HistoricalCaseFact,
  type HistoricalCaseFactInput,
  type HistoricalCaseLearningEligibility,
  type HistoricalCaseSnapshot,
  type HistoricalCaseSnapshotKind,
  type HistoricalCaseSource,
} from './model';

export const HISTORICAL_CASE_COLUMNS = [
  'id',
  'account_id',
  'enquiry_id',
  'conversation_id',
  'contact_id',
  'source_kind',
  'case_state',
  'completed_at',
  'evidence_quality_tier',
  'evidence_rule_version',
  'evidence_reasons',
  'evidence_classified_at',
  'learning_eligibility',
  'learning_exclusion_reason',
  'learning_eligibility_basis',
  'finalized_at',
  'created_by_user_id',
  'created_at',
  'updated_at',
].join(',');

export const HISTORICAL_CASE_FACT_COLUMNS = [
  'id',
  'account_id',
  'case_id',
  'fact_key',
  'value_source',
  'value_text',
  'value_number',
  'value_integer',
  'value_boolean',
  // Objective 02 added a timestamp value kind (arrival_at /
  // departed_at). Omitting it here did not fail loudly: PostgREST
  // simply left the column out of every returned row, `parseHistoricalCaseFact`
  // read `undefined`, and the value became null. That is the worst
  // shape of bug - the on-site timing survived in the database and
  // vanished on the way into a finalization snapshot, which is exactly
  // the snapshot that has to be reproducible.
  'value_timestamp',
  'provenance',
  'source_message_id',
  'source_media_id',
  'observed_at',
  'recorded_by_user_id',
  'created_at',
  'updated_at',
].join(',');

export const HISTORICAL_CASE_SNAPSHOT_COLUMNS = [
  'id',
  'account_id',
  'case_id',
  'snapshot_kind',
  'payload',
  'source_version',
  'recorded_by_user_id',
  'created_at',
].join(',');

/**
 * Bounded reads. Learning jobs run over an account's whole history, so an
 * unbounded `SELECT` is not an option; the repository always applies a
 * limit inside these bounds and always orders deterministically.
 */
export const HISTORICAL_CASE_LIST_MIN_LIMIT = 1;
export const HISTORICAL_CASE_LIST_MAX_LIMIT = 200;
export const HISTORICAL_CASE_DEFAULT_LIMIT = 50;

export type HistoricalCaseRepositoryErrorCode =
  'not_found' | 'conflict' | 'invalid_input' | 'database_error';

export class HistoricalCaseRepositoryError extends Error {
  readonly code: HistoricalCaseRepositoryErrorCode;

  constructor(code: HistoricalCaseRepositoryErrorCode, message: string) {
    super(message);
    this.name = 'HistoricalCaseRepositoryError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Ensure / read
// ---------------------------------------------------------------------------

export interface EnsureHistoricalCaseResult {
  case: HistoricalCase;
  /** True only when this call inserted the row. */
  created: boolean;
}

/**
 * Get the one historical case for an enquiry, creating it if absent.
 *
 * The enquiry is the only input that matters: its conversation comes from
 * the enquiry row and the contact from the conversation, so a caller cannot
 * pass a mismatched reference and the database checks the same thing again.
 *
 * Race safety comes from `historical_cases_one_per_enquiry`, not from this
 * read: a concurrent insert fails with 23505 and the winner is adopted.
 */
export async function ensureHistoricalCase(
  db: SupabaseClient,
  input: {
    accountId: string;
    enquiryId: string;
    createdByUserId: string | null;
    sourceKind?: HistoricalCaseSource;
  }
): Promise<EnsureHistoricalCaseResult> {
  const existing = await getHistoricalCaseByEnquiry(
    db,
    input.accountId,
    input.enquiryId
  );
  if (existing) {
    return { case: existing, created: false };
  }

  const enquiry = await loadEnquiryReference(
    db,
    input.accountId,
    input.enquiryId
  );
  if (!enquiry) {
    throw new HistoricalCaseRepositoryError('not_found', 'Enquiry not found');
  }

  const payload = {
    account_id: input.accountId,
    enquiry_id: enquiry.id,
    conversation_id: enquiry.conversation_id,
    contact_id: enquiry.contact_id,
    source_kind: input.sourceKind ?? 'live_enquiry',
    created_by_user_id: input.createdByUserId,
  };

  const { data, error } = await db
    .from('historical_cases')
    .insert(payload)
    .select(HISTORICAL_CASE_COLUMNS)
    .single();

  if (error?.code === '23505') {
    const winner = await getHistoricalCaseByEnquiry(
      db,
      input.accountId,
      input.enquiryId
    );
    if (winner) {
      return { case: winner, created: false };
    }
  }
  if (error || !data) {
    throw databaseError('Could not create historical case');
  }

  return { case: parseHistoricalCase(data), created: true };
}

export async function getHistoricalCaseByEnquiry(
  db: SupabaseClient,
  accountId: string,
  enquiryId: string
): Promise<HistoricalCase | null> {
  const { data, error } = await db
    .from('historical_cases')
    .select(HISTORICAL_CASE_COLUMNS)
    .eq('account_id', accountId)
    .eq('enquiry_id', enquiryId)
    .maybeSingle();

  if (error) {
    throw databaseError('Could not load historical case');
  }
  return data ? parseHistoricalCase(data) : null;
}

export async function getHistoricalCase(
  db: SupabaseClient,
  accountId: string,
  caseId: string
): Promise<HistoricalCase | null> {
  const { data, error } = await db
    .from('historical_cases')
    .select(HISTORICAL_CASE_COLUMNS)
    .eq('account_id', accountId)
    .eq('id', caseId)
    .maybeSingle();

  if (error) {
    throw databaseError('Could not load historical case');
  }
  return data ? parseHistoricalCase(data) : null;
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

/**
 * Record or replace one learning fact, with its own provenance.
 *
 * Re-recording a key overwrites the value, which is what makes a correction
 * possible while a case is open. It never widens what is knowable: the
 * validator refuses a provenance the key cannot carry, so a recorded value
 * cannot be promoted from a prediction into an outcome by re-writing it.
 */
export async function recordHistoricalCaseFact(
  db: SupabaseClient,
  input: {
    accountId: string;
    caseId: string;
    fact: HistoricalCaseFactInput | unknown;
  }
): Promise<HistoricalCaseFact> {
  const fact = validateFactInput(input.fact);

  const { data, error } = await db
    .from('historical_case_facts')
    .upsert(historicalCaseFactPayload(fact, input.accountId, input.caseId), {
      onConflict: 'case_id,fact_key',
    })
    .select(HISTORICAL_CASE_FACT_COLUMNS)
    .single();

  if (error) {
    throw databaseError('Could not record historical case fact');
  }
  if (!data) {
    throw databaseError('Could not record historical case fact');
  }
  return parseHistoricalCaseFact(data);
}

export async function getHistoricalCaseFacts(
  db: SupabaseClient,
  input: {
    accountId: string;
    caseId: string;
    limit?: number;
  }
): Promise<HistoricalCaseFact[]> {
  const { data, error } = await db
    .from('historical_case_facts')
    .select(HISTORICAL_CASE_FACT_COLUMNS)
    .eq('account_id', input.accountId)
    .eq('case_id', input.caseId)
    .order('fact_key', { ascending: true })
    .limit(boundedLimit(input.limit));

  if (error) {
    throw databaseError('Could not load historical case facts');
  }
  return ((data ?? []) as unknown[]).map(parseHistoricalCaseFact);
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export interface ClassifyHistoricalCaseResult {
  case: HistoricalCase;
  classification: HistoricalCaseClassification;
}

/**
 * Recompute the evidence tier from the case's stored evidence.
 *
 * Purely deterministic and safe to re-run: the same facts always produce
 * the same tier, so this is also how a case is re-classified after the rule
 * set changes. Every run appends an immutable classification snapshot, so
 * the current answer and the reasoning history both survive.
 *
 * `null` tier means UNCLASSIFIED. It is written as an explicit
 * classification (`evidence_classified_at` set, tier null) rather than as an
 * absent classification, because "we looked and could not tell" is a
 * finding worth keeping.
 */
export async function classifyHistoricalCase(
  db: SupabaseClient,
  input: { accountId: string; caseId: string; recordedByUserId?: string | null }
): Promise<ClassifyHistoricalCaseResult> {
  const current = await getHistoricalCase(db, input.accountId, input.caseId);
  if (!current) {
    throw new HistoricalCaseRepositoryError(
      'not_found',
      'Historical case not found'
    );
  }

  const facts = await getHistoricalCaseFacts(db, {
    accountId: input.accountId,
    caseId: input.caseId,
  });

  const enquiryOutcome = await loadEnquiryOutcome(
    db,
    input.accountId,
    current.enquiry_id
  );

  const classification = classifyHistoricalCaseEvidence({
    enquiryOutcome,
    completedAt: current.completed_at,
    facts,
    quoteEvidence: await getCanonicalQuoteEvidence(db, {
      accountId: input.accountId,
      enquiryId: current.enquiry_id,
    }),
  });

  const { data, error } = await db
    .from('historical_cases')
    .update({
      evidence_quality_tier: classification.tier,
      evidence_rule_version: classification.rule_version,
      evidence_reasons: classification.reasons,
      evidence_classified_at: new Date().toISOString(),
    })
    .eq('account_id', input.accountId)
    .eq('id', input.caseId)
    .select(HISTORICAL_CASE_COLUMNS)
    .maybeSingle();

  if (error) {
    throw databaseError('Could not classify historical case');
  }
  if (!data) {
    throw new HistoricalCaseRepositoryError(
      'conflict',
      'Historical case changed while it was being classified'
    );
  }

  await appendHistoricalCaseSnapshot(db, {
    accountId: input.accountId,
    caseId: input.caseId,
    snapshotKind: 'evidence_classification',
    payload: {
      evidence_quality_tier: classification.tier,
      evidence_rule_version: classification.rule_version,
      evidence_reasons: classification.reasons,
    },
    sourceVersion: classification.rule_version,
    recordedByUserId: input.recordedByUserId ?? null,
  });

  return { case: parseHistoricalCase(data), classification };
}

// ---------------------------------------------------------------------------
// Learning metadata
// ---------------------------------------------------------------------------

/**
 * Record when the job completed.
 *
 * This is a case-level timestamp rather than a copy of the enquiry's
 * workflow state: the learning question is "when did this job actually
 * finish", which a terminal `cancelled` enquiry cannot answer.
 */
export async function setHistoricalCaseCompleted(
  db: SupabaseClient,
  input: { accountId: string; caseId: string; completedAt: string | null }
): Promise<HistoricalCase> {
  if (
    input.completedAt !== null &&
    Number.isNaN(Date.parse(input.completedAt))
  ) {
    throw new HistoricalCaseRepositoryError(
      'invalid_input',
      'completedAt must be a timestamp or null'
    );
  }

  const { data, error } = await db
    .from('historical_cases')
    .update({ completed_at: input.completedAt })
    .eq('account_id', input.accountId)
    .eq('id', input.caseId)
    .select(HISTORICAL_CASE_COLUMNS)
    .maybeSingle();

  if (error) {
    throw databaseError('Could not record historical case completion');
  }
  if (!data) {
    throw new HistoricalCaseRepositoryError(
      'not_found',
      'Historical case not found'
    );
  }
  return parseHistoricalCase(data);
}

/**
 * Include or exclude a case from model training.
 *
 * Exclusion never deletes anything: the case stays readable as history and
 * remains available for retrieval, it simply stops being training evidence.
 * That is what makes an exclusion reversible and auditable, and it is why a
 * privacy request can withhold a case without destroying the audit trail
 * around it.
 */
export async function setHistoricalCaseLearningEligibility(
  db: SupabaseClient,
  input: {
    accountId: string;
    caseId: string;
    eligibility: HistoricalCaseLearningEligibility;
    reason: HistoricalCaseExclusionReason | null;
    basis: HistoricalCaseEligibilityBasis;
  }
): Promise<HistoricalCase> {
  const eligibility = validateLearningEligibility({
    eligibility: input.eligibility,
    reason: input.reason,
    basis: input.basis,
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
    throw databaseError('Could not update learning eligibility');
  }
  if (!data) {
    throw new HistoricalCaseRepositoryError(
      'not_found',
      'Historical case not found'
    );
  }
  return parseHistoricalCase(data);
}

// ---------------------------------------------------------------------------
// Bounded list reads
// ---------------------------------------------------------------------------

/**
 * The model-training population: cases an operator explicitly included.
 *
 * Tier is deliberately not part of the filter. Deciding what may train a
 * model is the operator's call, and silently hiding an included case from
 * this query would make the flag a lie.
 */
export async function listTrainingEligibleCases(
  db: SupabaseClient,
  input: { accountId: string; limit?: number }
): Promise<HistoricalCase[]> {
  const { data, error } = await db
    .from('historical_cases')
    .select(HISTORICAL_CASE_COLUMNS)
    .eq('account_id', input.accountId)
    .eq('learning_eligibility', 'included')
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(boundedLimit(input.limit));

  if (error) {
    throw databaseError('Could not list training-eligible cases');
  }
  return ((data ?? []) as unknown[]).map(parseHistoricalCase);
}

/**
 * The retrieval population: classified cases that are not excluded.
 *
 * Wider than the training set on purpose. A `pending` case with good
 * evidence is a legitimate comparable; what it must never become is
 * training truth without a decision.
 */
export async function listRetrievalCases(
  db: SupabaseClient,
  input: {
    accountId: string;
    limit?: number;
    /** Optional floor, for callers that only want strong evidence. */
    minimumTier?: HistoricalCaseEvidenceTier | null;
  }
): Promise<HistoricalCase[]> {
  let query = db
    .from('historical_cases')
    .select(HISTORICAL_CASE_COLUMNS)
    .eq('account_id', input.accountId)
    .neq('learning_eligibility', 'excluded')
    .not('evidence_quality_tier', 'is', null);

  if (input.minimumTier) {
    query = query.in('evidence_quality_tier', [
      input.minimumTier,
      ...tiersFrom(input.minimumTier),
    ]);
  }

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(boundedLimit(input.limit));

  if (error) {
    throw databaseError('Could not list retrieval cases');
  }
  return ((data ?? []) as unknown[]).map(parseHistoricalCase);
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

/**
 * Freeze a case: set `finalized_at` and `case_state` together, once.
 *
 * The compare-and-set on `case_state` is what makes a concurrent double
 * finalize safe. A finalized case reads `case_state = 'finalized'`, so
 * the loser's update matches no row and returns `null` instead of
 * overwriting the winner's freeze. Returning `null` is therefore a
 * normal outcome, not an error, and the caller decides whether the
 * winner's answer is acceptable.
 */
export async function freezeHistoricalCase(
  db: SupabaseClient,
  input: {
    accountId: string;
    caseId: string;
    finalizedAt: string;
  }
): Promise<HistoricalCase | null> {
  const { data, error } = await db
    .from('historical_cases')
    .update({
      case_state: 'finalized',
      finalized_at: input.finalizedAt,
    })
    .eq('account_id', input.accountId)
    .eq('id', input.caseId)
    .eq('case_state', 'open')
    .select(HISTORICAL_CASE_COLUMNS)
    .maybeSingle();

  if (error) {
    throw databaseError('Could not finalize historical case');
  }
  return data ? parseHistoricalCase(data) : null;
}

/**
 * The enquiry columns a finalization snapshot copies.
 *
 * A second, explicit read rather than a widened column list on
 * `getHistoricalCase`: this is the only place the learning layer needs
 * the operational enquiry's own field values, and naming them here
 * keeps "what do we freeze about an enquiry" a decision somebody made
 * rather than whatever the table happens to gain next quarter.
 */
export const HISTORICAL_CASE_ENQUIRY_SNAPSHOT_FIELDS = [
  'workflow_state',
  'state_changed_at',
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

export interface HistoricalCaseEnquirySnapshotRow {
  id: string;
  workflow_state: string;
  state_changed_at: string | null;
  [field: string]: unknown;
}

/**
 * Read the enquiry for a finalization snapshot, account-scoped.
 *
 * Returns null rather than throwing when the enquiry is gone: a case
 * whose enquiry was removed is still finalizable, and the `enquiry_facts`
 * snapshot is simply the one category that cannot be written. That is
 * the "snapshot only what exists" rule applied to the reference itself.
 */
export async function loadEnquiryFactsForCapture(
  db: SupabaseClient,
  accountId: string,
  input: { enquiryId: string }
): Promise<HistoricalCaseEnquirySnapshotRow | null> {
  const { data, error } = await db
    .from('enquiries')
    .select(['id', ...HISTORICAL_CASE_ENQUIRY_SNAPSHOT_FIELDS].join(','))
    .eq('account_id', accountId)
    .eq('id', input.enquiryId)
    .maybeSingle();

  if (error) {
    throw databaseError('Could not load the enquiry for finalization');
  }
  return (data as HistoricalCaseEnquirySnapshotRow | null) ?? null;
}

/**
 * Append an immutable learning snapshot.
 *
 * Used for classification history, for the four finalization snapshots,
 * and for the post-finalization `correction` snapshot. All three are
 * append-only; the only difference is which one a given kind is allowed
 * to repeat.
 */
export async function appendHistoricalCaseSnapshot(
  db: SupabaseClient,
  input: {
    accountId: string;
    caseId: string;
    snapshotKind: HistoricalCaseSnapshotKind;
    payload: Record<string, unknown>;
    sourceVersion: string;
    recordedByUserId?: string | null;
  }
): Promise<HistoricalCaseSnapshot> {
  const payload = parseSnapshotPayload(input.payload);

  if (input.sourceVersion.trim().length === 0) {
    throw new HistoricalCaseRepositoryError(
      'invalid_input',
      'A snapshot must record the version that produced it'
    );
  }

  const { data, error } = await db
    .from('historical_case_snapshots')
    .insert({
      account_id: input.accountId,
      case_id: input.caseId,
      snapshot_kind: input.snapshotKind,
      payload,
      source_version: input.sourceVersion,
      recorded_by_user_id: input.recordedByUserId ?? null,
    })
    .select(HISTORICAL_CASE_SNAPSHOT_COLUMNS)
    .single();

  if (error) {
    throw databaseError('Could not append historical case snapshot');
  }
  if (!data) {
    throw databaseError('Could not append historical case snapshot');
  }
  return parseHistoricalCaseSnapshot(data);
}

export async function getHistoricalCaseSnapshots(
  db: SupabaseClient,
  input: { accountId: string; caseId: string; limit?: number }
): Promise<HistoricalCaseSnapshot[]> {
  const { data, error } = await db
    .from('historical_case_snapshots')
    .select(HISTORICAL_CASE_SNAPSHOT_COLUMNS)
    .eq('account_id', input.accountId)
    .eq('case_id', input.caseId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(boundedLimit(input.limit));

  if (error) {
    throw databaseError('Could not load historical case snapshots');
  }
  return ((data ?? []) as unknown[]).map(parseHistoricalCaseSnapshot);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface EnquiryRow {
  id: string;
  conversation_id: string;
  workflow_state: string;
}

interface ConversationRow {
  id: string;
  contact_id: string;
}

interface EnquiryReferenceRow extends EnquiryRow {
  contact_id: string;
}

/**
 * The canonical reference set for one enquiry: its conversation and, from
 * that, its contact.
 *
 * Two account-scoped reads rather than a joined select, because the case's
 * composite foreign keys already prove both references belong to the
 * account inside the database — this read exists to derive the values, not
 * to enforce the boundary.
 */
async function loadEnquiryReference(
  db: SupabaseClient,
  accountId: string,
  enquiryId: string
): Promise<EnquiryReferenceRow | null> {
  const { data, error } = await db
    .from('enquiries')
    .select('id, conversation_id, workflow_state')
    .eq('account_id', accountId)
    .eq('id', enquiryId)
    .maybeSingle();

  if (error) {
    throw databaseError('Could not verify the historical case enquiry');
  }
  const enquiry = data as EnquiryRow | null;
  if (!enquiry) return null;

  const { data: conversationData, error: conversationError } = await db
    .from('conversations')
    .select('id, contact_id')
    .eq('account_id', accountId)
    .eq('id', enquiry.conversation_id)
    .maybeSingle();

  if (conversationError) {
    throw databaseError('Could not verify the historical case conversation');
  }
  const conversation = conversationData as ConversationRow | null;
  if (!conversation) {
    throw new HistoricalCaseRepositoryError(
      'not_found',
      'The enquiry conversation was not found in this account'
    );
  }

  return {
    id: enquiry.id,
    conversation_id: enquiry.conversation_id,
    workflow_state: enquiry.workflow_state,
    contact_id: conversation.contact_id,
  };
}

async function loadEnquiryOutcome(
  db: SupabaseClient,
  accountId: string,
  enquiryId: string
): Promise<'completed' | 'cancelled' | null> {
  const { data, error } = await db
    .from('enquiries')
    .select('workflow_state')
    .eq('account_id', accountId)
    .eq('id', enquiryId)
    .maybeSingle();

  if (error) {
    throw databaseError('Could not read the historical case enquiry outcome');
  }
  const state = (data as { workflow_state?: string } | null)?.workflow_state;
  if (state === 'completed') return 'completed';
  if (state === 'cancelled') return 'cancelled';
  return null;
}

function parseHistoricalCaseSnapshot(input: unknown): HistoricalCaseSnapshot {
  if (typeof input !== 'object' || input === null) {
    throw new HistoricalCaseValidationError(
      'historical case snapshot must be an object'
    );
  }
  const row = input as Record<string, unknown>;
  if (!isHistoricalCaseSnapshotKind(row.snapshot_kind)) {
    throw new HistoricalCaseValidationError('Invalid snapshot_kind');
  }
  return {
    id: String(row.id),
    account_id: String(row.account_id),
    case_id: String(row.case_id),
    snapshot_kind: row.snapshot_kind,
    payload: parseSnapshotPayload(row.payload),
    source_version: String(row.source_version),
    recorded_by_user_id:
      row.recorded_by_user_id === null || row.recorded_by_user_id === undefined
        ? null
        : String(row.recorded_by_user_id),
    created_at: String(row.created_at),
  };
}

function tiersFrom(
  tier: HistoricalCaseEvidenceTier
): HistoricalCaseEvidenceTier[] {
  const order: HistoricalCaseEvidenceTier[] = ['A', 'B', 'C', 'D', 'E', 'F'];
  return order.slice(order.indexOf(tier) + 1);
}

function validateFactInput(
  input: HistoricalCaseFactInput | unknown
): HistoricalCaseFactInput {
  return asRepositoryError(() => parseHistoricalCaseFactInput(input));
}

function validateLearningEligibility(input: {
  eligibility: HistoricalCaseLearningEligibility;
  reason: HistoricalCaseExclusionReason | null;
  basis: HistoricalCaseEligibilityBasis;
}): {
  eligibility: HistoricalCaseLearningEligibility;
  reason: HistoricalCaseExclusionReason | null;
  basis: HistoricalCaseEligibilityBasis;
} {
  return asRepositoryError(() => parseLearningEligibility(input));
}

/** Surface a domain validation failure as a typed repository rejection. */
function asRepositoryError<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof HistoricalCaseValidationError) {
      throw new HistoricalCaseRepositoryError('invalid_input', error.message);
    }
    throw error;
  }
}

function boundedLimit(limit?: number): number {
  if (limit === undefined) return HISTORICAL_CASE_DEFAULT_LIMIT;
  if (!Number.isInteger(limit)) {
    throw new HistoricalCaseRepositoryError(
      'invalid_input',
      'limit must be a whole number'
    );
  }
  return Math.min(
    HISTORICAL_CASE_LIST_MAX_LIMIT,
    Math.max(HISTORICAL_CASE_LIST_MIN_LIMIT, limit)
  );
}

function databaseError(message: string): HistoricalCaseRepositoryError {
  return new HistoricalCaseRepositoryError('database_error', message);
}

export { HISTORICAL_CASE_RULE_VERSION };
