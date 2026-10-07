/**
 * Objective 03 — the vector-memory service.
 *
 * Three capabilities, and nothing else:
 *
 *  1. `ensureCaseTextEmbedding` — make one case's canonical job
 *     description exist as a current vector, idempotently.
 *  2. `runCaseEmbeddingOperation` — a bounded, resumable, dry-runnable
 *     pass over an account's cases. This is the re-embedding entry
 *     point for a model change, and it is the only thing in the
 *     objective that spends money in bulk.
 *  3. `buildTransientQueryEmbedding` — a vector for a live enquiry,
 *     computed and returned but never persisted.
 *
 * Deliberately absent, and belonging to later objectives: any nearest
 * neighbour search, any similarity score, any ranking, any weighting,
 * any quote, any confidence. This module produces and stores vectors so
 * objective 04 has something well-defined to search.
 */

import { randomUUID } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  getHistoricalCaseFacts,
  loadEnquiryFactsForCapture,
} from '@/lib/historical-cases/repository';
import type { HistoricalCaseFact } from '@/lib/historical-cases/model';
import {
  loadImageAnalysisAggregate,
} from '@/lib/image-observations/repository';
import { validatePersistedFindings } from '@/lib/image-observations/model';

import {
  VectorMemoryError,
  boundedBatchLimit,
  evaluateVectorMemoryEligibility,
  type CaseEmbedding,
  type GeneratedCaseEmbedding,
} from './model';
import { generateEmbedding } from './provider';
import {
  CaseEmbeddingRepositoryError,
  listEmbeddingEligibleCases,
  loadCurrentEmbedding,
  markEmbeddingStale,
  storeCaseEmbedding,
  type EmbeddingCandidateCase,
} from './repository';
import {
  buildCaseSemanticInput,
  imageObservationRecordsFromSnapshot,
  buildImageObservationSemanticInput,
  type SemanticCaseSource,
  type SemanticEnquiryFacts,
  type SemanticInput,
} from './semantic-input';
import {
  buildPerImageObservationSemanticInput,
  perImageSemanticSources,
} from './per-image-semantic-input';

/** What a bounded operation was asked to do. */
export const VECTOR_MEMORY_OPERATION_MODES = ['missing', 'stale', 'all'] as const;
export type VectorMemoryOperationMode = (typeof VECTOR_MEMORY_OPERATION_MODES)[number];

/**
 * Upper bound on how many pages one operation will read.
 *
 * An operation is bounded on purpose: it runs on a paid API, from an
 * admin request, and "keep going until the account is done" is how a
 * dataset gets re-embedded by accident at full cost. Hitting this limit
 * reports `has_more` so the operator can run the next page.
 */
const MAX_PAGES_PER_OPERATION = 5;

export interface CaseEmbeddingOutcome {
  case_id: string;
  /** `up_to_date`, `generated`, `skipped`, or `ineligible`. */
  outcome: 'up_to_date' | 'generated' | 'skipped' | 'ineligible';
  kind: 'case_text' | 'image_observation_text';
  reason?: string;
  embedding_id?: string;
  /** True when a previous current vector was retired in this call. */
  superseded_previous?: boolean;
}

export interface CaseEmbeddingOperationResult {
  /** One id per run, safe to log. Contains no customer data. */
  correlation_id: string;
  dry_run: boolean;
  mode: VectorMemoryOperationMode;
  /** True when more cases remain and the operator should run again. */
  has_more: boolean;
  /** Offset to pass to the next call. */
  next_offset: number;
  examined: number;
  generated: number;
  up_to_date: number;
  skipped: number;
  ineligible: number;
  outcomes: CaseEmbeddingOutcome[];
  /** Human-readable findings. Never contains semantic content. */
  findings: string[];
}

export interface RunCaseEmbeddingOperationArgs {
  accountId: string;
  mode?: VectorMemoryOperationMode;
  limit?: number;
  offset?: number;
  /**
   * Defaults to true. An operation that forgets to say whether it is
   * real gets a plan, which is the only safe default for something that
   * spends the account's money on a paid API.
   */
  dryRun?: boolean;
  signal?: AbortSignal;
}

/**
 * Bounded generation / re-embedding over an account's cases.
 *
 * The decision for each case is made from data, not from a flag: the
 * canonical semantic input is rebuilt and compared against the stored
 * content hash and semantic input version. That single comparison
 * covers every trigger the roadmap lists — source changed, derived
 * summary changed, embedding model changed — without the operation
 * needing to be told which of them happened, and it makes a re-run
 * after an interruption a no-op for everything already done.
 *
 * `mode` only narrows which cases are considered, so an operator can
 * backfill without touching existing vectors or refresh only what is
 * out of date.
 *
 * Nothing here runs automatically. A migration does not generate
 * vectors, a webhook does not, and outcome capture does not; the paid
 * call happens only when an admin asks for it.
 */
export async function runCaseEmbeddingOperation(
  db: SupabaseClient,
  args: RunCaseEmbeddingOperationArgs
): Promise<CaseEmbeddingOperationResult> {
  const mode = args.mode ?? 'missing';
  if (!VECTOR_MEMORY_OPERATION_MODES.includes(mode)) {
    throw new VectorMemoryError(
      'invalid_input',
      `mode must be one of: ${VECTOR_MEMORY_OPERATION_MODES.join(', ')}`
    );
  }
  const limit = boundedBatchLimit(args.limit);
  const dryRun = args.dryRun ?? true;
  const startOffset = args.offset ?? 0;
  const correlationId = randomUUID();

  const outcomes: CaseEmbeddingOutcome[] = [];
  const findings: string[] = [];
  let offset = startOffset;
  let examined = 0;
  let generated = 0;
  let upToDate = 0;
  let skipped = 0;
  let ineligible = 0;
  let hasMore = false;

  for (let page = 0; page < MAX_PAGES_PER_OPERATION; page += 1) {
    const remaining = limit - examined;
    if (remaining <= 0) {
      hasMore = true;
      break;
    }

    const candidates = await listEmbeddingEligibleCases(db, {
      accountId: args.accountId,
      pageSize: remaining,
      offset,
    });
    if (candidates.length === 0) break;

    offset += candidates.length;
    examined += candidates.length;

    for (const candidate of candidates) {
      const outcome = await ensureCaseTextEmbedding(db, {
        accountId: args.accountId,
        candidate,
        dryRun,
        mode,
        correlationId,
        signal: args.signal,
      });
      outcomes.push(outcome);
      switch (outcome.outcome) {
        case 'generated':
          generated += 1;
          break;
        case 'up_to_date':
          upToDate += 1;
          break;
        case 'ineligible':
          ineligible += 1;
          break;
        default:
          skipped += 1;
      }
    }
  }

  if (examined >= limit) {
    hasMore = true;
    if (findings.length === 0) {
      findings.push(
        `examined the requested ${limit} case(s); run again with a higher offset to continue`
      );
    }
  }

  return {
    correlation_id: correlationId,
    dry_run: dryRun,
    mode,
    has_more: hasMore,
    next_offset: offset,
    examined,
    generated,
    up_to_date: upToDate,
    skipped,
    ineligible,
    outcomes,
    findings,
  };
}

export interface EnsureCaseTextEmbeddingArgs {
  accountId: string;
  candidate?: EmbeddingCandidateCase;
  caseId?: string;
  dryRun?: boolean;
  mode?: VectorMemoryOperationMode;
  correlationId?: string;
  signal?: AbortSignal;
}

/**
 * Make one case's canonical job description exist as a current vector.
 *
 * Reads canonical data only — the frozen `enquiry_facts` snapshot for a
 * finalized case, the live `enquiries` row for an open one, and the
 * case's own facts. It never reads a quote, a payment, or a message
 * body.
 */
export async function ensureCaseTextEmbedding(
  db: SupabaseClient,
  args: EnsureCaseTextEmbeddingArgs
): Promise<CaseEmbeddingOutcome> {
  const candidate = args.candidate ?? (await loadCandidate(db, args));
  if (!candidate) {
    throw new CaseEmbeddingRepositoryError(
      'not_found',
      'Historical case not found'
    );
  }

  const current = await loadCurrentEmbedding(db, {
    accountId: args.accountId,
    historicalCaseId: candidate.id,
    kind: 'case_text',
  });

  const semantic = await buildSemanticInputForCase(db, args.accountId, candidate);

  const decision = evaluateVectorMemoryEligibility(
    {
      learning_eligibility: candidate.learning_eligibility,
      case_state: candidate.case_state,
      evidence_quality_tier: candidate.evidence_quality_tier,
    },
    semantic.signal_count
  );

  if (!decision.eligible) {
    return {
      case_id: candidate.id,
      outcome: 'ineligible',
      kind: 'case_text',
      reason: decision.reasons.join(' '),
    };
  }

  const mode = args.mode ?? 'all';
  const isOutOfDate = current === null || !isSameEmbeddingIdentity(current.embedding, semantic);

  if (mode === 'missing' && current !== null && !isOutOfDate) {
    return upToDate(candidate.id, 'case_text', current.embedding);
  }
  if (mode === 'stale' && current === null) {
    return {
      case_id: candidate.id,
      outcome: 'skipped',
      kind: 'case_text',
      reason: 'no current embedding exists for this case',
    };
  }
  if (!isOutOfDate) {
    return upToDate(candidate.id, 'case_text', current!.embedding);
  }

  if (args.dryRun) {
    return {
      case_id: candidate.id,
      outcome: 'skipped',
      kind: 'case_text',
      reason: current
        ? 'the stored vector no longer matches the current canonical description'
        : 'no vector has been generated for this case yet',
    };
  }

  const generated = await generateEmbedding(db, {
    accountId: args.accountId,
    kind: 'case_text',
    text: semantic.text,
    semanticInputVersion: semantic.semantic_input_version,
    signal: args.signal,
    correlationId: args.correlationId,
  });

  const stored = await storeCaseEmbedding(db, {
    accountId: args.accountId,
    historicalCaseId: candidate.id,
    kind: 'case_text',
    sourceEntity: semantic.source_entity,
    sourceReference: semantic.source_reference,
    generated,
  });

  // Retire the previous vector only after the replacement is durably
  // stored, so an interruption leaves the case with either the old
  // vector or both — never with neither.
  let supersededPrevious = false;
  if (current && current.embedding.id !== stored.embedding.id) {
    const retired = await markEmbeddingStale(db, {
      accountId: args.accountId,
      embeddingId: current.embedding.id,
      supersededBy: stored.embedding.id,
    });
    supersededPrevious = retired !== null;
  }

  return {
    case_id: candidate.id,
    outcome: 'generated',
    kind: 'case_text',
    embedding_id: stored.embedding.id,
    superseded_previous: supersededPrevious,
  };
}

/**
 * Store the image-observation embedding for a finalized case.
 *
 * Only ever derived from the case's frozen `image_analysis` snapshot —
 * the validated structured observations WACRM itself recorded at
 * finalization. There is deliberately no path that accepts observation
 * JSON from a request body: an "arbitrary embedding source" is exactly
 * the thing that would let somebody write anything into the dataset's
 * semantic memory.
 */
export async function ensureImageObservationEmbedding(
  db: SupabaseClient,
  args: {
    accountId: string;
    caseId: string;
    snapshotId: string;
    snapshotPayload: unknown;
    dryRun?: boolean;
    signal?: AbortSignal;
    correlationId?: string;
  }
): Promise<CaseEmbeddingOutcome> {
  const semantic = buildImageObservationSemanticInput(
    imageObservationRecordsFromSnapshot(args.snapshotPayload)
  );

  const current = await loadCurrentEmbedding(db, {
    accountId: args.accountId,
    historicalCaseId: args.caseId,
    kind: 'image_observation_text',
  });
  if (current && isSameEmbeddingIdentity(current.embedding, semantic)) {
    return upToDate(args.caseId, 'image_observation_text', current.embedding);
  }

  if (args.dryRun) {
    return {
      case_id: args.caseId,
      outcome: 'skipped',
      kind: 'image_observation_text',
      reason: current
        ? 'the stored observation vector no longer matches the frozen observations'
        : 'no observation vector has been generated for this case yet',
    };
  }

  const generated = await generateEmbedding(db, {
    accountId: args.accountId,
    kind: 'image_observation_text',
    text: semantic.text,
    semanticInputVersion: semantic.semantic_input_version,
    signal: args.signal,
    correlationId: args.correlationId,
  });

  const stored = await storeCaseEmbedding(db, {
    accountId: args.accountId,
    historicalCaseId: args.caseId,
    kind: 'image_observation_text',
    sourceEntity: 'historical_case_snapshot',
    sourceReference: args.snapshotId,
    generated,
  });

  if (current && current.embedding.id !== stored.embedding.id) {
    await markEmbeddingStale(db, {
      accountId: args.accountId,
      embeddingId: current.embedding.id,
      supersededBy: stored.embedding.id,
    });
  }

  return {
    case_id: args.caseId,
    outcome: 'generated',
    kind: 'image_observation_text',
    embedding_id: stored.embedding.id,
  };
}

// ---------------------------------------------------------------------------
// Per-image observation embeddings
// ---------------------------------------------------------------------------

export interface PerImageObservationEmbeddingSource {
  /** The canonical run the observations came from. */
  run_id: string;
  /** The historical case the run is attached to, when it has one. */
  historical_case_id: string | null;
  /** Row metadata: which photograph, and the stable reference for it. */
  ordinal: number;
  source_media_id: string;
  source_message_id: string;
  /** The exact text that would be handed to the provider. */
  text: string;
  /** SHA-256 of `text`. The idempotency key for a per-image vector. */
  content_hash: string;
  semantic_input_version: string;
  /** How many independent signals this photograph's description carries. */
  signal_count: number;
}

/**
 * Deterministic per-image semantic inputs for one canonical analysis.
 *
 * This is the Objective-03 extension objective 04 needs: the exact text a
 * per-image `image_observation_text` vector would be built from, one
 * entry per analysed photograph, derived only from canonical persisted
 * per-image observations (migration 054).
 *
 * What this deliberately does NOT do:
 *
 *   - It does not generate a vector. Nothing here calls the provider and
 *     spends nothing.
 *   - It does not search, rank, or return neighbours. That is objective
 *     04.
 *   - It does not accept observation JSON from a request body. The
 *     observations are read from WACRM's own validated rows, which is the
 *     same rule `ensureImageObservationEmbedding` follows.
 *
 * A photograph with no validated observations is omitted rather than
 * emitted empty. `buildPerImageObservationSemanticInput` throws on an
 * empty description, so an empty entry could only ever become a
 * placeholder — and a placeholder description matches everything.
 */
export async function buildPerImageObservationInputs(
  db: SupabaseClient,
  args: { accountId: string; runId: string }
): Promise<PerImageObservationEmbeddingSource[]> {
  const aggregate = await loadImageAnalysisAggregate(db, {
    accountId: args.accountId,
    runId: args.runId,
  });

  const ordinalsByObservation = new Map<string, number[]>();
  for (const source of aggregate.sources) {
    const existing = ordinalsByObservation.get(source.observation_id) ?? [];
    existing.push(source.source_ordinal);
    ordinalsByObservation.set(source.observation_id, existing);
  }

  const imagesByOrdinal = new Map(
    aggregate.images.map((image) => [image.ordinal, image])
  );
  const findings = validatePersistedFindings(
    aggregate.observations,
    ordinalsByObservation,
    imagesByOrdinal
  );

  return perImageSemanticSources(aggregate, findings).map((entry) => {
    const semantic = buildPerImageObservationSemanticInput(entry);
    return {
      run_id: aggregate.run.id,
      historical_case_id: aggregate.run.historical_case_id,
      ordinal: semantic.ordinal,
      source_media_id: entry.source.source_media_id,
      source_message_id: entry.source.source_message_id,
      text: semantic.text,
      content_hash: semantic.content_hash,
      semantic_input_version: semantic.semantic_input_version,
      signal_count: semantic.signal_count,
    };
  });
}

// ---------------------------------------------------------------------------
// Transient query embeddings
// ---------------------------------------------------------------------------

export interface TransientQuerySource {
  /** The live enquiry's own facts. */
  enquiry: SemanticEnquiryFacts;
  /** Optional captured facts already on the enquiry's case, if any. */
  facts?: readonly HistoricalCaseFact[];
}

/**
 * A query vector for a current enquiry, computed and returned but not
 * stored.
 *
 * Three things this must not do, and does not:
 *
 * - **It does not create a historical case.** A live enquiry is not a
 *   learning example; it is a question. Persisting one so that a query
 *   could be answered would grow the training dataset with every
 *   message that arrives.
 * - **It does not persist the vector.** Nothing is written, so a
 *   customer's current enquiry leaves no trace in the vector store.
 * - **It does not retrieve.** It returns the vector so objective 04 can
 *   search with it.
 *
 * The text is produced by the same builder and the same version tag as
 * a stored case vector, which is what makes a query vector comparable
 * with the corpus at all. A query built by a different builder would
 * silently compare two different languages.
 */
export async function buildTransientQueryEmbedding(
  db: SupabaseClient,
  args: { accountId: string; source: TransientQuerySource; signal?: AbortSignal }
): Promise<GeneratedCaseEmbedding> {
  const facts = args.source.facts ?? [];
  const signalCount = countQuerySignals(args.source.enquiry);

  if (signalCount === 0) {
    throw new VectorMemoryError(
      'invalid_input',
      'There is nothing to search with yet: this enquiry has no items, access facts or waste description yet.'
    );
  }

  // The builders work on a case-shaped source. A query is projected onto
  // the same shape so it is guaranteed to be described in the same
  // vocabulary as a stored case — that is the whole reason a query
  // vector is comparable with the corpus.
  const source: SemanticCaseSource = {
    case_id: 'transient-query',
    account_id: args.accountId,
    case_state: 'open',
    source_kind: 'live_enquiry',
    evidence_quality_tier: null,
    learning_eligibility: 'pending',
    completed_at: null,
    finalized_at: null,
    enquiry: args.source.enquiry,
    facts,
    source_entity: 'historical_case',
    source_reference: null,
  };

  const semantic = buildCaseSemanticInput(source);
  return generateEmbedding(db, {
    accountId: args.accountId,
    kind: 'case_text',
    text: semantic.text,
    semanticInputVersion: semantic.semantic_input_version,
    signal: args.signal,
  });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Is the stored vector still the right vector for this content and this
 * model?
 *
 * All four compatibility values plus the content hash must match. Any
 * one of them differing means the stored vector describes something
 * else — different words, or the same words in a different coordinate
 * system — and must be regenerated rather than reused.
 */
function isSameEmbeddingIdentity(
  embedding: CaseEmbedding,
  semantic: SemanticInput
): boolean {
  return (
    embedding.semantic_input_version === semantic.semantic_input_version &&
    embedding.content_hash === semantic.content_hash
  );
}

function upToDate(
  caseId: string,
  kind: CaseEmbeddingOutcome['kind'],
  embedding: CaseEmbedding
): CaseEmbeddingOutcome {
  return {
    case_id: caseId,
    outcome: 'up_to_date',
    kind,
    embedding_id: embedding.id,
  };
}

/**
 * Assemble the canonical semantic input for one case.
 *
 * A finalized case is described by its frozen `enquiry_facts` snapshot:
 * that snapshot is what a training example was actually built from, and
 * using it means a later correction to the live enquiry row cannot
 * silently change what the case means.
 */
async function buildSemanticInputForCase(
  db: SupabaseClient,
  accountId: string,
  candidate: EmbeddingCandidateCase
): Promise<SemanticInput> {
  const facts = await getHistoricalCaseFacts(db, {
    accountId,
    caseId: candidate.id,
  });

  let enquiry: SemanticEnquiryFacts | null = null;
  let sourceEntity: 'historical_case' | 'historical_case_snapshot' = 'historical_case';
  let sourceReference: string | null = null;

  if (candidate.case_state === 'finalized') {
    const snapshot = await loadEnquiryFactsSnapshot(db, {
      accountId,
      caseId: candidate.id,
    });
    if (snapshot) {
      enquiry = snapshot.values;
      sourceEntity = 'historical_case_snapshot';
      sourceReference = snapshot.id;
    }
  }

  if (enquiry === null) {
    const row = await loadEnquiryFactsForCapture(db, accountId, {
      enquiryId: candidate.enquiry_id,
    });
    if (row) {
      enquiry = row as unknown as SemanticEnquiryFacts;
      sourceEntity = 'historical_case';
      sourceReference = null;
    }
  }

  return buildCaseSemanticInput({
    case_id: candidate.id,
    account_id: accountId,
    case_state: candidate.case_state,
    source_kind: candidate.source_kind,
    evidence_quality_tier: candidate.evidence_quality_tier,
    learning_eligibility: candidate.learning_eligibility,
    completed_at: candidate.completed_at,
    finalized_at: candidate.finalized_at,
    enquiry,
    facts,
    source_entity: sourceEntity,
    source_reference: sourceReference,
  });
}

interface EnquiryFactsSnapshot {
  id: string;
  values: SemanticEnquiryFacts;
}

/**
 * The case's frozen `enquiry_facts` snapshot, or null.
 *
 * Read directly rather than through `getHistoricalCaseSnapshots` so a
 * bounded operation does not page every snapshot kind of every case; the
 * row is unique per kind per case (migration 050), so `maybeSingle` is
 * unambiguous.
 */
async function loadEnquiryFactsSnapshot(
  db: SupabaseClient,
  input: { accountId: string; caseId: string }
): Promise<EnquiryFactsSnapshot | null> {
  const { data, error } = await db
    .from('historical_case_snapshots')
    .select('id, payload')
    .eq('account_id', input.accountId)
    .eq('case_id', input.caseId)
    .eq('snapshot_kind', 'enquiry_facts')
    .maybeSingle();

  if (error) {
    throw new CaseEmbeddingRepositoryError(
      'database_error',
      'Could not read the frozen enquiry facts snapshot'
    );
  }
  if (!data) return null;
  const payload = (data as { payload?: unknown }).payload;
  if (typeof payload !== 'object' || payload === null) return null;
  const values = (payload as { values?: unknown }).values;
  if (typeof values !== 'object' || values === null) return null;
  return {
    id: String((data as { id?: unknown }).id),
    values: values as SemanticEnquiryFacts,
  };
}

async function loadCandidate(
  db: SupabaseClient,
  args: EnsureCaseTextEmbeddingArgs
): Promise<EmbeddingCandidateCase | null> {
  if (!args.caseId) {
    throw new VectorMemoryError('invalid_input', 'caseId is required');
  }
  return getHistoricalCaseSnapshotRow(db, args.accountId, args.caseId);
}

async function getHistoricalCaseSnapshotRow(
  db: SupabaseClient,
  accountId: string,
  caseId: string
): Promise<EmbeddingCandidateCase | null> {
  const { data, error } = await db
    .from('historical_cases')
    .select([
      'id',
      'account_id',
      'enquiry_id',
      'source_kind',
      'case_state',
      'completed_at',
      'evidence_quality_tier',
      'learning_eligibility',
      'finalized_at',
    ].join(','))
    .eq('account_id', accountId)
    .eq('id', caseId)
    .maybeSingle();

  if (error) {
    throw new CaseEmbeddingRepositoryError(
      'database_error',
      'Could not load the historical case'
    );
  }
  if (!data) return null;
  const record = data as unknown as Record<string, unknown>;
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
    completed_at:
      record.completed_at === null || record.completed_at === undefined
        ? null
        : String(record.completed_at),
    finalized_at:
      record.finalized_at === null || record.finalized_at === undefined
        ? null
        : String(record.finalized_at),
    source_kind: String(record.source_kind),
    enquiry_id: String(record.enquiry_id),
  };
}

/**
 * How much a live enquiry says, for the "nothing to search with yet"
 * check.
 *
 * Counts populated enquiry fields only. It is deliberately a cheap
 * pre-check: `buildCaseSemanticInput` remains the authority on whether
 * the text is usable, and this exists so an operator gets "add some
 * details first" rather than a paid API call on an empty enquiry.
 */
function countQuerySignals(enquiry: SemanticEnquiryFacts): number {
  let count = 0;
  for (const value of Object.values(enquiry)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length > 0) count += 1;
    } else if (typeof value === 'string') {
      if (value.trim() !== '') count += 1;
    } else {
      count += 1;
    }
  }
  return count;
}
