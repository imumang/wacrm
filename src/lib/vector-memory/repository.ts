/**
 * Objective 03 — the account-scoped vector store.
 *
 * Every function is specific and takes the account id as its first
 * argument. There is no generic `search()`, no caller-supplied filter
 * object, and no way to run a similarity query, because objective 04
 * owns ranking and this objective must not be able to hand that
 * decision to a caller that supplied the weights.
 *
 * Two conventions are worth stating once:
 *
 * - **Staleness is expressed, never deleted.** A changed source, a new
 *   semantic input version, or a new model produces a new row and moves
 *   the previous one to `stale`. History is what makes a past
 *   retrieval result explainable and a bad re-embedding reversible.
 * - **Retrieval metadata is joined, never copied.** Evidence tier and
 *   learning eligibility are canonical columns on `historical_cases`
 *   that legitimately change while a case is open. Duplicating them on
 *   the vector row would let retrieval filter on a value the case no
 *   longer holds, so `loadCurrentEmbedding` reads both and reports the
 *   case's current answer.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { HistoricalCase } from '@/lib/historical-cases/model';
import { getHistoricalCase } from '@/lib/historical-cases/repository';

import {
  VECTOR_MEMORY_BATCH_MAX_LIMIT,
  parseCaseEmbedding,
  type CaseEmbedding,
  type CaseEmbeddingRetrievalEntry,
  type GeneratableVectorEmbeddingKind,
  type GeneratedCaseEmbedding,
  type VectorEmbeddingSourceEntity,
} from './model';

export const CASE_EMBEDDING_COLUMNS = [
  'id',
  'account_id',
  'historical_case_id',
  'embedding_kind',
  'source_entity',
  'source_reference',
  'semantic_input_version',
  'content_hash',
  'provider',
  'embedding_model',
  'model_version',
  'dimensions',
  'state',
  'superseded_by',
  'created_at',
  'refreshed_at',
].join(',');

export type CaseEmbeddingRepositoryErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'conflict'
  | 'database_error';

export class CaseEmbeddingRepositoryError extends Error {
  readonly code: CaseEmbeddingRepositoryErrorCode;

  constructor(code: CaseEmbeddingRepositoryErrorCode, message: string) {
    super(message);
    this.name = 'CaseEmbeddingRepositoryError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface StoreCaseEmbeddingArgs {
  accountId: string;
  historicalCaseId: string;
  kind: GeneratableVectorEmbeddingKind;
  sourceEntity: VectorEmbeddingSourceEntity;
  sourceReference: string | null;
  generated: GeneratedCaseEmbedding;
}

export interface StoreCaseEmbeddingResult {
  embedding: CaseEmbedding;
  /** True when this call inserted the row rather than finding an existing one. */
  created: boolean;
}

/**
 * Insert a generated vector, or return the row that already holds it.
 *
 * Idempotent on the identity tuple (account, case, kind, semantic input
 * version, provider, model, model version, content hash) rather than on
 * "is there a current row for this case". That distinction matters
 * during a model upgrade: re-running the same model against unchanged
 * content must be a no-op even while a *different* model's rows exist
 * alongside it, and the unique index in migration 053
 * (`idx_case_embeddings_identity_unique`) is the database half of this.
 *
 * A row that already exists in a non-current state is re-activated.
 * That is safe precisely because the identity tuple includes the
 * content hash: the vector being restored is the vector that content
 * produces under this model, so nothing is being re-labelled as
 * something it is not.
 */
export async function storeCaseEmbedding(
  db: SupabaseClient,
  args: StoreCaseEmbeddingArgs
): Promise<StoreCaseEmbeddingResult> {
  const existing = await findCaseEmbeddingByIdentity(db, {
    accountId: args.accountId,
    historicalCaseId: args.historicalCaseId,
    kind: args.kind,
    semanticInputVersion: args.generated.semantic_input_version,
    provider: args.generated.provider,
    embeddingModel: args.generated.embedding_model,
    modelVersion: args.generated.model_version,
    contentHash: args.generated.content_hash,
  });

  if (existing) {
    if (existing.state === 'current') {
      return { embedding: existing, created: false };
    }
    if (existing.state === 'withheld') {
      throw new CaseEmbeddingRepositoryError(
        'conflict',
        'This embedding is withheld because its historical case is excluded from learning. Include the case before generating embeddings for it again.'
      );
    }
    const reactivated = await setCaseEmbeddingState(db, {
      accountId: args.accountId,
      embeddingId: existing.id,
      state: 'current',
    });
    return { embedding: reactivated, created: false };
  }

  const payload = {
    account_id: args.accountId,
    historical_case_id: args.historicalCaseId,
    embedding_kind: args.kind,
    source_entity: args.sourceEntity,
    source_reference: args.sourceReference,
    semantic_input_version: args.generated.semantic_input_version,
    content_hash: args.generated.content_hash,
    provider: args.generated.provider,
    embedding_model: args.generated.embedding_model,
    model_version: args.generated.model_version,
    dimensions: args.generated.dimensions,
    vector: toVectorLiteral(args.generated.vector),
    state: 'current',
    superseded_by: null,
  };

  const first = await insertCurrent(db, payload);

  if (!first.error) {
    return { embedding: parseCaseEmbedding(first.data), created: true };
  }

  // A concurrent writer inserted the same identity first. Adopt their row
  // rather than failing: two workers computing the same content under the
  // same model produce the same vector, so there is nothing to reconcile.
  if (isUniqueViolation(first.error)) {
    const winner = await findCaseEmbeddingByIdentity(db, {
      accountId: args.accountId,
      historicalCaseId: args.historicalCaseId,
      kind: args.kind,
      semanticInputVersion: args.generated.semantic_input_version,
      provider: args.generated.provider,
      embeddingModel: args.generated.embedding_model,
      modelVersion: args.generated.model_version,
      contentHash: args.generated.content_hash,
    });
    if (winner) return { embedding: winner, created: false };

    // Otherwise the collision is `idx_case_embeddings_one_current`: this
    // case already has an active vector, and it was written under a
    // DIFFERENT model version or semantic input version. That is a model
    // upgrade or a builder change, and the "at most one current vector
    // per (case, kind)" rule has to be honoured by handing the slot over.
    //
    // The incumbent is retired FIRST and the new row inserted second,
    // because the alternative — insert, then retire — cannot work: the
    // insert itself is what the unique index rejects. The window in which
    // the case has no current vector is safe, because every read of a
    // missing current vector is "not embedded yet", and the bounded
    // operation is idempotent and resumable.
    const incumbent = await loadCurrentEmbedding(db, {
      accountId: args.accountId,
      historicalCaseId: args.historicalCaseId,
      kind: args.kind,
    });
    if (incumbent) {
      if (incumbent.embedding.state === 'withheld') {
        throw new CaseEmbeddingRepositoryError(
          'conflict',
          'This historical case is excluded from learning, so its embeddings cannot be made current.'
        );
      }
      await markEmbeddingStale(db, {
        accountId: args.accountId,
        embeddingId: incumbent.embedding.id,
      });
    }

    const second = await insertCurrent(db, payload);
    if (!second.error) {
      return { embedding: parseCaseEmbedding(second.data), created: true };
    }
    if (isExclusionViolation(second.error)) {
      throw new CaseEmbeddingRepositoryError(
        'conflict',
        'This historical case is excluded from learning, so its embeddings cannot be made current.'
      );
    }
    throw databaseError('Could not store the case embedding');
  }

  if (isExclusionViolation(first.error)) {
    throw new CaseEmbeddingRepositoryError(
      'conflict',
      'This historical case is excluded from learning, so its embeddings cannot be made current.'
    );
  }
  throw databaseError('Could not store the case embedding');
}

async function insertCurrent(
  db: SupabaseClient,
  payload: Record<string, unknown>
): Promise<{ data: unknown; error: unknown }> {
  return db
    .from('case_embeddings')
    .insert(payload)
    .select(CASE_EMBEDDING_COLUMNS)
    .single();
}

export interface FindCaseEmbeddingByIdentityArgs {
  accountId: string;
  historicalCaseId: string;
  kind: GeneratableVectorEmbeddingKind;
  semanticInputVersion: string;
  provider: string;
  embeddingModel: string;
  modelVersion: string;
  contentHash: string;
}

/** Look up the one row that holds this exact content under this exact model. */
export async function findCaseEmbeddingByIdentity(
  db: SupabaseClient,
  args: FindCaseEmbeddingByIdentityArgs
): Promise<CaseEmbedding | null> {
  const { data, error } = await db
    .from('case_embeddings')
    .select(CASE_EMBEDDING_COLUMNS)
    .eq('account_id', args.accountId)
    .eq('historical_case_id', args.historicalCaseId)
    .eq('embedding_kind', args.kind)
    .eq('semantic_input_version', args.semanticInputVersion)
    .eq('provider', args.provider)
    .eq('embedding_model', args.embeddingModel)
    .eq('model_version', args.modelVersion)
    .eq('content_hash', args.contentHash)
    .maybeSingle();

  if (error) {
    throw databaseError('Could not look up the case embedding');
  }
  return data ? parseCaseEmbedding(data) : null;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * The case's active embedding for one kind, plus the canonical
 * retrieval metadata.
 *
 * Returns `null` when there is no current embedding. An excluded case
 * has no current embedding — the migration-053 trigger withholds them —
 * so exclusion is enforced by storage, not merely by a filter this
 * function forgot to apply.
 */
export async function loadCurrentEmbedding(
  db: SupabaseClient,
  input: {
    accountId: string;
    historicalCaseId: string;
    kind: GeneratableVectorEmbeddingKind;
  }
): Promise<CaseEmbeddingRetrievalEntry | null> {
  const { data, error } = await db
    .from('case_embeddings')
    .select(CASE_EMBEDDING_COLUMNS)
    .eq('account_id', input.accountId)
    .eq('historical_case_id', input.historicalCaseId)
    .eq('embedding_kind', input.kind)
    .eq('state', 'current')
    .maybeSingle();

  if (error) {
    throw databaseError('Could not load the current case embedding');
  }
  if (!data) return null;

  const historicalCase = await getHistoricalCase(
    db,
    input.accountId,
    input.historicalCaseId
  );
  return {
    embedding: parseCaseEmbedding(data),
    ...canonicalRetrievalMetadata(historicalCase),
  };
}

/** Every current embedding of one kind for one case. */
export async function listCurrentEmbeddings(
  db: SupabaseClient,
  input: {
    accountId: string;
    historicalCaseId: string;
    limit?: number;
  }
): Promise<CaseEmbedding[]> {
  const { data, error } = await db
    .from('case_embeddings')
    .select(CASE_EMBEDDING_COLUMNS)
    .eq('account_id', input.accountId)
    .eq('historical_case_id', input.historicalCaseId)
    .eq('state', 'current')
    .order('embedding_kind', { ascending: true })
    .limit(Math.min(input.limit ?? VECTOR_MEMORY_BATCH_MAX_LIMIT, VECTOR_MEMORY_BATCH_MAX_LIMIT));

  if (error) {
    throw databaseError('Could not list the current case embeddings');
  }
  return ((data ?? []) as unknown[]).map(parseCaseEmbedding);
}

/**
 * A bounded page of cases eligible to hold vector memory.
 *
 * "Eligible" here is only the coarse, SQL-cheap part: not excluded, and
 * an account-scoped read. The semantic sufficiency rule lives in the
 * service, because it needs the built text to evaluate.
 *
 * Paged with a deterministic order so an interrupted bounded operation
 * can be resumed and two concurrent runs walk the same sequence.
 */
export async function listEmbeddingEligibleCases(
  db: SupabaseClient,
  input: { accountId: string; pageSize: number; offset: number }
): Promise<EmbeddingCandidateCase[]> {
  const pageSize = Math.min(
    Math.max(1, input.pageSize),
    VECTOR_MEMORY_BATCH_MAX_LIMIT
  );
  const { data, error } = await db
    .from('historical_cases')
    .select(HISTORICAL_CASE_COLUMNS_FOR_EMBEDDING)
    .eq('account_id', input.accountId)
    .neq('learning_eligibility', 'excluded')
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(input.offset, input.offset + pageSize - 1);

  if (error) {
    throw databaseError('Could not list historical cases for vector memory');
  }
  return ((data ?? []) as unknown[]).map((row) => {
    const record = row as Record<string, unknown>;
    return {
      id: String(record.id),
      account_id: String(record.account_id),
      learning_eligibility: String(
        record.learning_eligibility
      ) as EmbeddingCandidateCase['learning_eligibility'],
      case_state: String(record.case_state) as EmbeddingCandidateCase['case_state'],
      evidence_quality_tier:
        record.evidence_quality_tier === null ||
        record.evidence_quality_tier === undefined
          ? null
          : String(record.evidence_quality_tier),
      completed_at: readNullableString(record.completed_at),
      finalized_at: readNullableString(record.finalized_at),
      source_kind: String(record.source_kind),
      enquiry_id: String(record.enquiry_id),
    };
  });
}

/** An embedding-eligible case: identity plus what the eligibility rule reads. */
export interface EmbeddingCandidateCase {
  id: string;
  account_id: string;
  learning_eligibility: 'pending' | 'included' | 'excluded';
  case_state: 'open' | 'finalized';
  evidence_quality_tier: string | null;
  completed_at: string | null;
  finalized_at: string | null;
  source_kind: string;
  enquiry_id: string;
}

const HISTORICAL_CASE_COLUMNS_FOR_EMBEDDING = [
  'id',
  'account_id',
  'enquiry_id',
  'source_kind',
  'case_state',
  'completed_at',
  'evidence_quality_tier',
  'learning_eligibility',
  'finalized_at',
  'created_at',
].join(',');

/** Account-level coverage counts, for the operator's dry-run output. */
export async function countEmbeddingCoverage(
  db: SupabaseClient,
  input: { accountId: string }
): Promise<Record<string, number>> {
  const { data, error } = await db
    .from('case_embeddings')
    .select('embedding_kind,state', { count: 'exact' })
    .eq('account_id', input.accountId);

  if (error) {
    throw databaseError('Could not read vector memory coverage');
  }
  const counts: Record<string, number> = {};
  for (const row of (data ?? []) as Array<{
    embedding_kind?: string;
    state?: string;
  }>) {
    const key = `${row.embedding_kind ?? 'unknown'}:${row.state ?? 'unknown'}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Retire
// ---------------------------------------------------------------------------

/**
 * Move a row to `stale`, optionally recording what replaced it.
 *
 * Stale rather than superseded unless the caller knows the successor's
 * id: "the source changed" and "this specific row replaced that one"
 * are different facts, and only the second is worth pointing at.
 *
 * Refuses to touch a `withheld` row. A vector withheld for a privacy
 * exclusion must not be quietly retired into an ordinary state by an
 * embedding run.
 */
export async function markEmbeddingStale(
  db: SupabaseClient,
  input: {
    accountId: string;
    embeddingId: string;
    supersededBy?: string | null;
  }
): Promise<CaseEmbedding | null> {
  const state = input.supersededBy ? 'superseded' : 'stale';
  const { data, error } = await db
    .from('case_embeddings')
    .update({ state, superseded_by: input.supersededBy ?? null })
    .eq('account_id', input.accountId)
    .eq('id', input.embeddingId)
    .neq('state', 'withheld')
    .select(CASE_EMBEDDING_COLUMNS)
    .maybeSingle();

  if (error) {
    throw databaseError('Could not retire the previous case embedding');
  }
  return data ? parseCaseEmbedding(data) : null;
}

async function setCaseEmbeddingState(
  db: SupabaseClient,
  input: { accountId: string; embeddingId: string; state: 'current' }
): Promise<CaseEmbedding> {
  const { data, error } = await db
    .from('case_embeddings')
    .update({ state: input.state, superseded_by: null })
    .eq('account_id', input.accountId)
    .eq('id', input.embeddingId)
    .select(CASE_EMBEDDING_COLUMNS)
    .maybeSingle();

  if (error) {
    throw databaseError('Could not re-activate the case embedding');
  }
  if (!data) {
    throw new CaseEmbeddingRepositoryError(
      'not_found',
      'The case embedding to re-activate was not found'
    );
  }
  return parseCaseEmbedding(data);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * The canonical retrieval metadata for a case.
 *
 * Read from `historical_cases` rather than copied onto the vector row,
 * so a reclassified or re-included case is reported as it is now.
 */
function canonicalRetrievalMetadata(
  historicalCase: HistoricalCase | null
): Pick<
  CaseEmbeddingRetrievalEntry,
  'evidence_quality_tier' | 'learning_eligibility' | 'case_state' | 'completed_at'
> {
  return {
    evidence_quality_tier: historicalCase?.evidence_quality_tier ?? null,
    learning_eligibility: historicalCase?.learning_eligibility ?? 'pending',
    case_state: historicalCase?.case_state ?? 'open',
    completed_at: historicalCase?.completed_at ?? null,
  };
}

/**
 * pgvector literal.
 *
 * PostgREST will not reliably bind a JSON array to a `vector` column, so
 * the value is sent as the canonical `[0.1,0.2]` text. Reuses the same
 * formatting the knowledge base already relies on.
 */
function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}

function isUniqueViolation(error: unknown): boolean {
  return readCode(error) === '23505';
}

/** Postgres 23514 is a CHECK violation; the exclusion guards use it. */
function isExclusionViolation(error: unknown): boolean {
  const code = readCode(error);
  return code === '23514';
}

function readCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code as string | undefined
    : undefined;
}

function databaseError(message: string): CaseEmbeddingRepositoryError {
  return new CaseEmbeddingRepositoryError('database_error', message);
}

function readNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}
