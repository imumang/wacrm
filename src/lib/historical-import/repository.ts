/**
 * Objective 02 (Historical Import and Normalization) - the narrow,
 * account-scoped data access for historical import.
 *
 * Every read and write here is scoped by `account_id` and bounded by a
 * limit, for the same reason the objective-01 repository is: a learning
 * import runs across an account's whole history, so an unbounded query
 * is not an option and a caller-supplied filter object is not a
 * surface worth having.
 *
 * What is deliberately NOT here:
 *
 * - No generic `query()`, no caller-supplied table name, no arbitrary
 *   filter. The importer reads a named set of columns from a named set
 *   of tables, and a future change to what it reads is a reviewed diff
 *   rather than a string a caller supplied.
 * - No `account_id` from a request body. Every function takes the
 *   account as an argument, and the caller - an authenticated route -
 *   takes it from the profile.
 * - No media reads. The importer records references to `messages` rows;
 *   it never fetches bytes, never calls an AI provider, and never runs
 *   image analysis.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  HISTORICAL_CASE_FACT_COLUMNS,
} from '../historical-cases/repository';
import {
  parseHistoricalCaseFact,
  type HistoricalCaseFact,
} from '../historical-cases/model';
import {
  HISTORICAL_IMPORT_MAX_PAGE_SIZE,
  HISTORICAL_IMPORT_PAGE_SIZE,
  HISTORICAL_IMPORT_VERSION,
  parseHistoricalCaseSource,
  parseHistoricalImportRun,
  type HistoricalImportRun,
  type HistoricalImportRunStatus,
  type HistoricalImportSourceKind,
  type HistoricalImportSourceType,
  type HistoricalImportSummary,
  type HistoricalCaseSource,
  type HistoricalImportQuality,
} from './model';

export const HISTORICAL_IMPORT_RUN_COLUMNS = [
  'id',
  'account_id',
  'source_type',
  'status',
  'started_at',
  'completed_at',
  'dry_run',
  'records_examined',
  'cases_created',
  'cases_updated',
  'cases_reused',
  'facts_imported',
  'records_skipped',
  'ambiguous_records',
  'conflicts',
  'errors',
  'summary',
  'error_metadata',
  'importer_version',
  'triggered_by_user_id',
  'created_at',
].join(',');

export const HISTORICAL_CASE_SOURCE_COLUMNS = [
  'id',
  'account_id',
  'case_id',
  'source_kind',
  'source_record_id',
  'source_system',
  'source_version',
  'source_observed_at',
  'import_run_id',
  'imported_at',
  'import_quality',
  'import_quality_reasons',
].join(',');

/**
 * The `enquiries` columns the importer reads.
 *
 * Named rather than `select('*')`, for the same reason objective 01
 * named its snapshot fields: "what does an import read from the
 * operational record" should be a decision somebody made, not whatever
 * the table happens to gain next quarter.
 */
export const HISTORICAL_IMPORT_ENQUIRY_COLUMNS = [
  'id',
  'account_id',
  'conversation_id',
  'workflow_state',
  'state_changed_at',
  'created_at',
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
].join(',');

export type HistoricalImportEnquiryRow = Record<string, unknown>;

export type HistoricalImportRepositoryErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'database_error';

export class HistoricalImportRepositoryError extends Error {
  readonly code: HistoricalImportRepositoryErrorCode;

  constructor(code: HistoricalImportRepositoryErrorCode, message: string) {
    super(message);
    this.name = 'HistoricalImportRepositoryError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Source reads
// ---------------------------------------------------------------------------

/**
 * One bounded, deterministically ordered page of an account's enquiries.
 *
 * Ordering by `created_at` then `id` and paging by offset is what makes
 * a repeated run read the same rows in the same order, and the offset
 * ceiling is what stops an enormous account from turning one import into
 * an unbounded scan.
 */
export async function readEnquiryPage(
  db: SupabaseClient,
  input: { accountId: string; offset: number; limit: number }
): Promise<HistoricalImportEnquiryRow[]> {
  const { data, error } = await db
    .from('enquiries')
    .select(HISTORICAL_IMPORT_ENQUIRY_COLUMNS)
    .eq('account_id', input.accountId)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .range(input.offset, input.offset + input.limit - 1);

  if (error) {
    throw databaseError('Could not read enquiries for historical import');
  }
  return (data ?? []) as unknown as HistoricalImportEnquiryRow[];
}

/**
 * One bounded page of conversations, for the legacy-conversation report.
 */
export async function readConversationPage(
  db: SupabaseClient,
  input: { accountId: string; offset: number; limit: number }
): Promise<{ id: string }[]> {
  const { data, error } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', input.accountId)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .range(input.offset, input.offset + input.limit - 1);

  if (error) {
    throw databaseError(
      'Could not read conversations for historical import'
    );
  }
  return ((data ?? []) as { id: string }[]).map((row) => ({ id: row.id }));
}

/**
 * Which of the given enquiries already have a case, and whether it is
 * frozen.
 *
 * One bounded read for a whole page, because the importer needs this to
 * decide reuse versus conflict and doing it per enquiry would turn a
 * 200-row page into 200 round trips. Only the three columns the
 * decision actually reads are selected: the case's own identity comes
 * from the enquiry id and the parser is deliberately not used on a
 * partial row.
 */
export async function readCasesForEnquiries(
  db: SupabaseClient,
  input: { accountId: string; enquiryIds: readonly string[] }
): Promise<Array<{ id: string; enquiry_id: string; finalized_at: string | null }>> {
  if (input.enquiryIds.length === 0) return [];

  const { data, error } = await db
    .from('historical_cases')
    .select('id, enquiry_id, finalized_at')
    .eq('account_id', input.accountId)
    .in('enquiry_id', [...input.enquiryIds]);

  if (error) {
    throw databaseError('Could not read historical cases for import');
  }
  return ((data ?? []) as {
    id: string;
    enquiry_id: string;
    finalized_at: string | null;
  }[]).map((row) => ({
    id: row.id,
    enquiry_id: row.enquiry_id,
    finalized_at: row.finalized_at,
  }));
}

/**
 * The facts already recorded on a set of cases, for conflict resolution.
 *
 * Bounded by the caller's case list, which is bounded by the page size,
 * so this cannot become an unbounded scan of the account's learning
 * data.
 */
export async function readFactsForCases(
  db: SupabaseClient,
  input: { accountId: string; caseIds: readonly string[] }
): Promise<HistoricalCaseFact[]> {
  if (input.caseIds.length === 0) return [];

  const { data, error } = await db
    .from('historical_case_facts')
    .select(HISTORICAL_CASE_FACT_COLUMNS)
    .eq('account_id', input.accountId)
    .in('case_id', [...input.caseIds]);

  if (error) {
    throw databaseError('Could not read historical case facts for import');
  }
  return ((data ?? []) as unknown[]).map(parseHistoricalCaseFact);
}

/**
 * Which of the given conversations already have an enquiry row.
 *
 * A second bounded read rather than an anti-join, because PostgREST has
 * no "has no matching row" filter and inventing one through an embed
 * would make the importer depend on PostgREST's relationship cache.
 */
export async function readEnquiryConversationIds(
  db: SupabaseClient,
  input: { accountId: string; conversationIds: readonly string[] }
): Promise<Set<string>> {
  if (input.conversationIds.length === 0) return new Set();

  const { data, error } = await db
    .from('enquiries')
    .select('conversation_id')
    .eq('account_id', input.accountId)
    .in('conversation_id', [...input.conversationIds]);

  if (error) {
    throw databaseError(
      'Could not read enquiry conversations for historical import'
    );
  }
  return new Set(
    ((data ?? []) as { conversation_id: string }[]).map(
      (row) => row.conversation_id
    )
  );
}

/**
 * One bounded page of deals, for the report-only adapter.
 *
 * Read and counted, never mapped. See
 * `HISTORICAL_SOURCE_INVENTORY` for why a pipeline row is not a quote.
 */
export async function readDealPage(
  db: SupabaseClient,
  input: { accountId: string; offset: number; limit: number }
): Promise<{ id: string; value: number | null; status: string | null }[]> {
  const { data, error } = await db
    .from('deals')
    .select('id, value, status')
    .eq('account_id', input.accountId)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .range(input.offset, input.offset + input.limit - 1);

  if (error) {
    throw databaseError('Could not read deals for historical import');
  }
  return ((data ?? []) as {
    id: string;
    value: number | null;
    status: string | null;
  }[]).map((row) => ({
    id: row.id,
    value: row.value === null ? null : Number(row.value),
    status: row.status,
  }));
}

/**
 * Inbound media message references for a set of conversations.
 *
 * A reference, nothing more: the row id is the canonical pointer back
 * to the attachment, and the `messages` row keeps its own timestamp and
 * media type. No bytes are fetched and no analysis is run, so this
 * function cannot call an AI provider even by accident.
 */
export async function readInboundMediaReferences(
  db: SupabaseClient,
  input: {
    accountId: string;
    conversationIds: readonly string[];
    limit: number;
  }
): Promise<
  Array<{
    id: string;
    conversation_id: string;
    created_at: string;
    media_type: string | null;
  }>
> {
  if (input.conversationIds.length === 0) return [];

  const { data, error } = await db
    .from('messages')
    .select('id, conversation_id, created_at, media_type')
    .in('conversation_id', [...input.conversationIds])
    .eq('sender_type', 'customer')
    .not('media_url', 'is', null)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(input.limit);

  if (error) {
    throw databaseError(
      'Could not read inbound media references for historical import'
    );
  }
  return ((data ?? []) as {
    id: string;
    conversation_id: string;
    created_at: string;
    media_type: string | null;
  }[]).map((row) => ({
    id: row.id,
    conversation_id: row.conversation_id,
    created_at: row.created_at,
    media_type: row.media_type,
  }));
}

// ---------------------------------------------------------------------------
// Source ledger reads
// ---------------------------------------------------------------------------

/**
 * Which of the given source records are already attributed to a case.
 *
 * The hot path of idempotency. A record in this set is skipped
 * entirely, so a second run of the importer examines everything,
 * writes nothing, and reports the same numbers.
 */
export async function readAttributedSourceRecords(
  db: SupabaseClient,
  input: {
    accountId: string;
    sourceKind: HistoricalImportSourceKind;
    sourceRecordIds: readonly string[];
  }
): Promise<Set<string>> {
  if (input.sourceRecordIds.length === 0) return new Set();

  const { data, error } = await db
    .from('historical_case_sources')
    .select('source_record_id')
    .eq('account_id', input.accountId)
    .eq('source_kind', input.sourceKind)
    .in('source_record_id', [...input.sourceRecordIds]);

  if (error) {
    throw databaseError('Could not read the historical case source ledger');
  }
  return new Set(
    ((data ?? []) as { source_record_id: string }[]).map(
      (row) => row.source_record_id
    )
  );
}

export async function listHistoricalCaseSourcesForCase(
  db: SupabaseClient,
  input: { accountId: string; caseId: string; limit?: number }
): Promise<HistoricalCaseSource[]> {
  const { data, error } = await db
    .from('historical_case_sources')
    .select(HISTORICAL_CASE_SOURCE_COLUMNS)
    .eq('account_id', input.accountId)
    .eq('case_id', input.caseId)
    .order('source_kind', { ascending: true })
    .order('imported_at', { ascending: true })
    .limit(bounded(input.limit));

  if (error) {
    throw databaseError('Could not read historical case sources');
  }
  return ((data ?? []) as unknown[]).map(parseHistoricalCaseSource);
}

// ---------------------------------------------------------------------------
// Source ledger write
// ---------------------------------------------------------------------------

export interface RecordHistoricalCaseSourceInput {
  accountId: string;
  caseId: string;
  sourceKind: HistoricalImportSourceKind;
  sourceRecordId: string;
  sourceSystem: string;
  sourceVersion: string | null;
  sourceObservedAt: string | null;
  importRunId: string | null;
  importQuality: HistoricalImportQuality;
  importQualityReasons: readonly string[];
}

export type RecordHistoricalCaseSourceResult =
  | { recorded: true; source: HistoricalCaseSource }
  /**
   * The record is already attributed. Not an error: it is exactly what
   * a repeated import produces, and the caller reports it as a skip
   * rather than a failure.
   */
  | { recorded: false; reason: 'already_attributed' };

/**
 * Attribute one source record to one case.
 *
 * Returns "already attributed" instead of throwing when the uniqueness
 * constraint fires, because that is the idempotency mechanism working,
 * not an error. The database refuses the write either way, so a
 * concurrent or racing import cannot attribute a record twice.
 */
export async function recordHistoricalCaseSource(
  db: SupabaseClient,
  input: RecordHistoricalCaseSourceInput
): Promise<RecordHistoricalCaseSourceResult> {
  const { data, error } = await db
    .from('historical_case_sources')
    .insert({
      account_id: input.accountId,
      case_id: input.caseId,
      source_kind: input.sourceKind,
      source_record_id: input.sourceRecordId,
      source_system: input.sourceSystem,
      source_version: input.sourceVersion,
      source_observed_at: input.sourceObservedAt,
      import_run_id: input.importRunId,
      import_quality: input.importQuality,
      import_quality_reasons: [...input.importQualityReasons],
    })
    .select(HISTORICAL_CASE_SOURCE_COLUMNS)
    .single();

  if (error) {
    if (error.code === '23505') {
      return { recorded: false, reason: 'already_attributed' };
    }
    throw databaseError('Could not record a historical case source');
  }
  if (!data) {
    throw databaseError('Could not record a historical case source');
  }
  return { recorded: true, source: parseHistoricalCaseSource(data) };
}

// ---------------------------------------------------------------------------
// Import run reads and writes
// ---------------------------------------------------------------------------

export interface StartHistoricalImportRunInput {
  accountId: string;
  sourceType: HistoricalImportSourceType;
  dryRun: boolean;
  triggeredByUserId: string;
}

/**
 * Open an import run.
 *
 * Written before any planning begins, so an import that is interrupted
 * leaves a `running` row behind. A run that vanishes on a crash is an
 * import nobody can audit.
 */
export async function startHistoricalImportRun(
  db: SupabaseClient,
  input: StartHistoricalImportRunInput
): Promise<HistoricalImportRun> {
  const { data, error } = await db
    .from('historical_import_runs')
    .insert({
      account_id: input.accountId,
      source_type: input.sourceType,
      status: 'running',
      dry_run: input.dryRun,
      importer_version: HISTORICAL_IMPORT_VERSION,
      triggered_by_user_id: input.triggeredByUserId,
    })
    .select(HISTORICAL_IMPORT_RUN_COLUMNS)
    .single();

  if (error) {
    throw databaseError('Could not start a historical import run');
  }
  if (!data) {
    throw databaseError('Could not start a historical import run');
  }
  return parseHistoricalImportRun(data);
}

export interface CompleteHistoricalImportRunInput {
  accountId: string;
  runId: string;
  status: HistoricalImportRunStatus;
  recordsExamined: number;
  casesCreated: number;
  casesUpdated: number;
  casesReused: number;
  factsImported: number;
  recordsSkipped: number;
  ambiguousRecords: number;
  conflicts: number;
  errors: number;
  summary: HistoricalImportSummary;
  errorMetadata: readonly unknown[];
}

/**
 * Close an import run with its counters, its bounded summary and its
 * bounded error list.
 *
 * `cases_created` / `cases_updated` are zero for a dry run, and the
 * database enforces that as a CHECK - so a dry run cannot report work it
 * did not do even if this function were called wrongly.
 */
export async function completeHistoricalImportRun(
  db: SupabaseClient,
  input: CompleteHistoricalImportRunInput
): Promise<HistoricalImportRun> {
  if (input.status === 'running') {
    throw new HistoricalImportRepositoryError(
      'invalid_input',
      'An import run cannot be completed as running'
    );
  }

  const { data, error } = await db
    .from('historical_import_runs')
    .update({
      status: input.status,
      completed_at: new Date().toISOString(),
      records_examined: input.recordsExamined,
      cases_created: input.casesCreated,
      cases_updated: input.casesUpdated,
      cases_reused: input.casesReused,
      facts_imported: input.factsImported,
      records_skipped: input.recordsSkipped,
      ambiguous_records: input.ambiguousRecords,
      conflicts: input.conflicts,
      errors: input.errors,
      summary: input.summary,
      error_metadata: [...input.errorMetadata],
    })
    .eq('account_id', input.accountId)
    .eq('id', input.runId)
    .select(HISTORICAL_IMPORT_RUN_COLUMNS)
    .maybeSingle();

  if (error) {
    throw databaseError('Could not complete a historical import run');
  }
  if (!data) {
    throw new HistoricalImportRepositoryError(
      'not_found',
      'Historical import run not found'
    );
  }
  return parseHistoricalImportRun(data);
}

export async function getHistoricalImportRun(
  db: SupabaseClient,
  input: { accountId: string; runId: string }
): Promise<HistoricalImportRun | null> {
  const { data, error } = await db
    .from('historical_import_runs')
    .select(HISTORICAL_IMPORT_RUN_COLUMNS)
    .eq('account_id', input.accountId)
    .eq('id', input.runId)
    .maybeSingle();

  if (error) {
    throw databaseError('Could not read a historical import run');
  }
  return data ? parseHistoricalImportRun(data) : null;
}

/**
 * The most recent runs for an account, newest first. Bounded, and
 * deterministic, because this is the list an operator reads before
 * approving anything.
 */
export async function listHistoricalImportRuns(
  db: SupabaseClient,
  input: { accountId: string; limit?: number }
): Promise<HistoricalImportRun[]> {
  const { data, error } = await db
    .from('historical_import_runs')
    .select(HISTORICAL_IMPORT_RUN_COLUMNS)
    .eq('account_id', input.accountId)
    .order('started_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(bounded(input.limit));

  if (error) {
    throw databaseError('Could not list historical import runs');
  }
  return ((data ?? []) as unknown[]).map(parseHistoricalImportRun);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

export function boundedPageSize(limit?: number): number {
  if (limit === undefined) return HISTORICAL_IMPORT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new HistoricalImportRepositoryError(
      'invalid_input',
      'limit must be a positive whole number'
    );
  }
  return Math.min(HISTORICAL_IMPORT_MAX_PAGE_SIZE, limit);
}

function bounded(limit?: number): number {
  if (limit === undefined) return HISTORICAL_IMPORT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1) return HISTORICAL_IMPORT_PAGE_SIZE;
  return Math.min(HISTORICAL_IMPORT_MAX_PAGE_SIZE, limit);
}

function databaseError(message: string): HistoricalImportRepositoryError {
  return new HistoricalImportRepositoryError('database_error', message);
}