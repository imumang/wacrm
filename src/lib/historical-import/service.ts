/**
 * Objective 02 (Historical Import and Normalization) - the server-side
 * import service.
 *
 * Four operations, and no others:
 *
 *   `inspectHistoricalImport` - what historical evidence exists, and
 *                               what may safely become a case.
 *   `dryRunHistoricalImport`  - plan and report. Writes nothing to the
 *                               case model.
 *   `executeHistoricalImport` - apply the same plan.
 *   `getHistoricalImportSummary` - read back a stored run.
 *
 * It is a narrow service on purpose. It is not an AI tool, it accepts
 * no query, no table name and no filter, and it never calls a language
 * model or an image-analysis provider. Everything it decides comes from
 * the pure planner in `plan.ts`.
 *
 * ## Dry run first
 *
 * `dryRunHistoricalImport` and `executeHistoricalImport` call the same
 * `planEnquiryImport` for the same inputs and differ only in whether the
 * plan is applied. That is the whole safety argument for the workflow,
 * so it is enforced structurally rather than by discipline: there is no
 * second mapping implementation that could drift from the first.
 *
 * A dry run still writes an `historical_import_runs` row. That is not a
 * historical-case mutation - no case, no fact, no source ledger row
 * moves - and it is what makes "we dry-ran this and it said 412 cases"
 * an answerable question months later. The database enforces the
 * counters that matter: a dry run cannot record a created or updated
 * case.
 *
 * ## What is never done here
 *
 * - No price is ever written. There is no structured monetary source in
 *   WACRM to write one from, and message text is not a source.
 * - No outcome is ever inferred. Not from an enquiry's age, not from a
 *   conversation going quiet, not from a deal's status.
 * - No image is analysed and no AI provider is called.
 * - No conversation is split into jobs. That needs a deterministic
 *   segmentation decision by an operator.
 * - Nothing is overwritten. See `decideImportedFact`.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  classifyHistoricalCase,
  ensureHistoricalCase,
  recordHistoricalCaseFact,
  setHistoricalCaseLearningEligibility,
} from '../historical-cases/repository';
import type { HistoricalCaseFact } from '../historical-cases/model';
import {
  HISTORICAL_IMPORT_MAX_ERROR_DETAILS,
  HISTORICAL_IMPORT_MAX_MEDIA_PER_CASE,
  HISTORICAL_IMPORT_MAX_OFFSET,
  HISTORICAL_IMPORT_MAX_SAMPLE_REF_LENGTH,
  buildImportSummary,
  countConflict,
  countEvidenceTier,
  countQuality,
  countSkip,
  emptyImportSummaryCounters,
  isHistoricalImportSourceType,
  sourceRef,
  type HistoricalImportErrorDetail,
  type HistoricalImportFinding,
  type HistoricalImportProjection,
  type HistoricalImportQuality,
  type HistoricalImportRun,
  type HistoricalImportSourceType,
  type HistoricalImportSummary,
  type HistoricalCaseSource,
  type HistoricalImportSummaryCounters,
} from './model';
import {
  IMPORT_SOURCE_SYSTEM_ENQUIRY,
  IMPORT_SOURCE_SYSTEM_MESSAGE,
  planDeal,
  planEnquiryImport,
  planLegacyConversation,
} from './plan';
import {
  HistoricalImportRepositoryError,
  boundedPageSize,
  completeHistoricalImportRun,
  getHistoricalImportRun,
  listHistoricalCaseSourcesForCase,
  listHistoricalImportRuns,
  readAttributedSourceRecords,
  readCasesForEnquiries,
  readConversationPage,
  readDealPage,
  readEnquiryConversationIds,
  readEnquiryPage,
  readFactsForCases,
  readInboundMediaReferences,
  recordHistoricalCaseSource,
  startHistoricalImportRun,
} from './repository';

export interface HistoricalImportRequest {
  accountId: string;
  sourceType: HistoricalImportSourceType;
  /** True plans and reports; false applies. */
  dryRun: boolean;
  /** The agent running the import. Recorded on the run and every fact. */
  triggeredByUserId: string;
  /** Bounded page offset, for paging a large account. */
  offset?: number;
  /** Bounded page size. Clamped to the repository's maximum. */
  limit?: number;
}

export interface HistoricalImportResult {
  run: HistoricalImportRun;
  /** True when the page was full and more rows remain. */
  has_more: boolean;
  next_offset: number;
  findings: HistoricalImportFinding[];
}

/**
 * Findings that are properties of the installation rather than of any
 * record, and therefore true of every WACRM schema to date.
 *
 * Reported on every run so an operator reading only a run summary still
 * learns the two things that shape the whole dataset: there is no
 * structured quote source, and there is no structured outcome source.
 */
const ENQUIRY_ADAPTER_FINDINGS: HistoricalImportFinding[] = [
  'no_structured_quote_source',
  'no_structured_outcome_source',
];

const DEAL_ADAPTER_FINDINGS: HistoricalImportFinding[] = [
  'no_structured_quote_source',
];

/**
 * Plan one bounded page and, unless this is a dry run, apply it.
 *
 * On a dry run nothing in the case model is touched. On a real run the
 * plan is applied record by record, and a record that fails is recorded
 * as a bounded error detail while the rest of the page continues - a
 * single unreadable row must not abandon an import that has already
 * written a hundred good ones, and must not be hidden either.
 */
export async function runHistoricalImport(
  db: SupabaseClient,
  request: HistoricalImportRequest
): Promise<HistoricalImportResult> {
  if (!isHistoricalImportSourceType(request.sourceType)) {
    throw new HistoricalImportRepositoryError(
      'invalid_input',
      'source_type is not a known historical import source'
    );
  }
  const limit = boundedPageSize(request.limit);
  const offset = request.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0 || offset > HISTORICAL_IMPORT_MAX_OFFSET) {
    throw new HistoricalImportRepositoryError(
      'invalid_input',
      `offset must be between 0 and ${HISTORICAL_IMPORT_MAX_OFFSET}`
    );
  }

  const run = await startHistoricalImportRun(db, {
    accountId: request.accountId,
    sourceType: request.sourceType,
    dryRun: request.dryRun,
    triggeredByUserId: request.triggeredByUserId,
  });

  const counters = emptyImportSummaryCounters();
  const errors: HistoricalImportErrorDetail[] = [];
  let examined = 0;
  let created = 0;
  let updated = 0;
  let reused = 0;
  let factsImported = 0;
  let conflicts = 0;
  let ambiguous = 0;
  let findings: HistoricalImportFinding[] = [];
  let hasMore = false;
  // The projection is what a dry run reports: what it *would* do. It
  // lives in the summary rather than in `cases_created`, because those
  // two columns are the written counters and the database refuses to
  // record a non-zero one on a dry run.
  const projection: HistoricalImportProjection = {
    cases_to_create: 0,
    cases_to_update: 0,
    cases_to_reuse: 0,
    facts_to_import: 0,
    media_references_to_record: 0,
  };

  try {
    switch (request.sourceType) {
      case 'enquiries': {
        findings = [...ENQUIRY_ADAPTER_FINDINGS];
        const page = await readEnquiryPage(db, {
          accountId: request.accountId,
          offset,
          limit,
        });
        hasMore = page.length === limit;
        examined = page.length;

        const enquiryIds = page.map((row) => String(row.id));
        const [attributed, existingCases] = await Promise.all([
          readAttributedSourceRecords(db, {
            accountId: request.accountId,
            sourceKind: 'enquiry',
            sourceRecordIds: enquiryIds,
          }),
          readCasesForEnquiries(db, {
            accountId: request.accountId,
            enquiryIds,
          }),
        ]);

        const factsByCase = await readFactsForCases(db, {
          accountId: request.accountId,
          caseIds: existingCases.map((entry) => entry.id),
        });
        const factsIndex = indexFactsByCase(factsByCase);
        const caseIndex = new Map(
          existingCases.map((entry) => [entry.enquiry_id, entry])
        );

        // Media references are read once for the whole page rather than
        // per enquiry, and capped per case so one thread cannot dominate
        // an import.
        const media = await readInboundMediaReferences(db, {
          accountId: request.accountId,
          conversationIds: [
            ...new Set(
              page.map((row) => String(row.conversation_id ?? ''))
            ),
          ].filter((id) => id !== ''),
          limit: limit * HISTORICAL_IMPORT_MAX_MEDIA_PER_CASE,
        });
        const mediaIndex = indexMediaByConversation(media);

        for (const row of page) {
          const enquiryId = String(row.id ?? '');
          const conversationId = String(row.conversation_id ?? '');
          const existingCase = caseIndex.get(enquiryId) ?? null;
          const outcome = planEnquiryImport({
            enquiry: row,
            existingCase: existingCase
              ? { finalizedAt: existingCase.finalized_at }
              : null,
            existingFacts: existingCase
              ? (factsIndex.get(existingCase.id) ?? [])
              : [],
            alreadyAttributed: attributed.has(enquiryId),
            mediaReferences: mediaIndex.get(conversationId) ?? [],
          });

          if (outcome.outcome === 'skip') {
            ambiguous += countAmbiguous(outcome.quality);
            countSkip(counters, outcome.reason, outcome.ref);
            countQuality(counters, outcome.quality);
            continue;
          }

          if (outcome.outcome === 'conflict') {
            ambiguous += countAmbiguous(outcome.quality);
            conflicts += countConflict(counters, outcome.reason, outcome.ref);
            countQuality(counters, outcome.quality);
            continue;
          }

          for (const conflict of outcome.conflicts) {
            conflicts += countConflict(
              counters,
              conflict.reason,
              sourceRef('enquiry', enquiryId)
            );
          }

          if (outcome.reusingCase) {
            reused += 1;
            projection.cases_to_reuse += 1;
            if (outcome.facts.length > 0) {
              updated += 1;
              projection.cases_to_update += 1;
            }
          } else {
            created += 1;
            projection.cases_to_create += 1;
          }
          projection.facts_to_import += outcome.facts.length;
          projection.media_references_to_record += outcome.media.length;

          countQuality(counters, outcome.quality);

          if (request.dryRun) {
            // The plan is the whole answer for a dry run. Nothing is
            // written - not a case, not a fact, not a source ledger row,
            // and not a classification, so a dry run cannot move a
            // case's tier either.
            continue;
          }

          try {
            const { case: historicalCase } = await ensureHistoricalCase(db, {
              accountId: request.accountId,
              enquiryId: outcome.enquiryId,
              createdByUserId: request.triggeredByUserId,
              sourceKind: 'imported_historical',
            });

            for (const fact of outcome.facts) {
              await recordHistoricalCaseFact(db, {
                accountId: request.accountId,
                caseId: historicalCase.id,
                fact: {
                  ...fact,
                  recorded_by_user_id: request.triggeredByUserId,
                },
              });
              factsImported += 1;
            }

            const enquiryRecord = await recordHistoricalCaseSource(db, {
              accountId: request.accountId,
              caseId: historicalCase.id,
              sourceKind: 'enquiry',
              sourceRecordId: outcome.enquiryId,
              sourceSystem: IMPORT_SOURCE_SYSTEM_ENQUIRY,
              sourceVersion: null,
              sourceObservedAt: outcome.observedAt,
              importRunId: run.id,
              importQuality: outcome.quality,
              importQualityReasons: outcome.qualityReasons,
            });
            if (!enquiryRecord.recorded) {
              // A concurrent run got there first. The database refused
              // the attribution, so this run did not create a duplicate
              // - it reports the clash and moves on, which is exactly
              // what two simultaneous imports should do.
              conflicts += countConflict(
                counters,
                'source_record_already_attributed',
                outcome.ref
              );
            }

            for (const reference of outcome.media) {
              await recordHistoricalCaseSource(db, {
                accountId: request.accountId,
                caseId: historicalCase.id,
                sourceKind: 'message',
                sourceRecordId: reference.sourceRecordId,
                sourceSystem: IMPORT_SOURCE_SYSTEM_MESSAGE,
                sourceVersion: null,
                sourceObservedAt: reference.observedAt,
                importRunId: run.id,
                importQuality: reference.quality,
                importQualityReasons: reference.qualityReasons,
              });
            }

            if (outcome.eligibility) {
              // Trust policy. Unreachable from today's single mapping
              // adapter, because an enquiry maps `exact` or `partial`
              // and both stay `pending` - but the moment a second
              // adapter can produce an `ambiguous` or `unusable` plan,
              // this is what stops it being trusted into training by
              // arriving. See `eligibilityForImportQuality`.
              await setHistoricalCaseLearningEligibility(db, {
                accountId: request.accountId,
                caseId: historicalCase.id,
                eligibility: outcome.eligibility.eligibility,
                reason: outcome.eligibility.reason,
                basis: outcome.eligibility.basis,
              });
            }

            // The deterministic classifier, never a manual tier. An
            // imported case with nothing but annotations classifies as
            // unclassified, which is the honest answer and the one that
            // keeps it out of every price-learning population.
            const { classification } = await classifyHistoricalCase(db, {
              accountId: request.accountId,
              caseId: historicalCase.id,
              recordedByUserId: request.triggeredByUserId,
            });
            countEvidenceTier(counters, classification.tier);
          } catch (error) {
            errors.push({
              source_kind: 'enquiry',
              source_record_id: trimRef(outcome.enquiryId),
              reason: describeError(error),
            });
          }
        }
        break;
      }

      case 'legacy_conversations': {
        const page = await readConversationPage(db, {
          accountId: request.accountId,
          offset,
          limit,
        });
        hasMore = page.length === limit;
        examined = page.length;

        const covered = await readEnquiryConversationIds(db, {
          accountId: request.accountId,
          conversationIds: page.map((row) => row.id),
        });

        for (const row of page) {
          if (covered.has(row.id)) continue;
          const outcome = planLegacyConversation(row.id);
          ambiguous += countAmbiguous(outcome.quality);
          countSkip(counters, outcome.reason, outcome.ref);
          countQuality(counters, outcome.quality);
        }

        if (examined > covered.size) {
          findings = ['legacy_conversations_require_segmentation'];
        }
        // Nothing is imported by this adapter, in a dry run or otherwise.
        break;
      }

      case 'deals': {
        findings = [...DEAL_ADAPTER_FINDINGS];
        const page = await readDealPage(db, {
          accountId: request.accountId,
          offset,
          limit,
        });
        hasMore = page.length === limit;
        examined = page.length;

        for (const deal of page) {
          const outcome = planDeal(deal);
          ambiguous += countAmbiguous(outcome.quality);
          countSkip(counters, outcome.reason, outcome.ref);
          countQuality(counters, outcome.quality);
        }
        // Nothing is imported by this adapter, in a dry run or otherwise.
        break;
      }
    }

    for (const finding of findings) counters.findings.add(finding);

    const summary: HistoricalImportSummary = buildImportSummary(
      counters,
      projection
    );
    const completed = await completeHistoricalImportRun(db, {
      accountId: request.accountId,
      runId: run.id,
      status: errors.length > 0 ? 'completed_with_errors' : 'completed',
      recordsExamined: examined,
      casesCreated: request.dryRun ? 0 : created,
      casesUpdated: request.dryRun ? 0 : updated,
      casesReused: reused,
      factsImported: request.dryRun ? 0 : factsImported,
      recordsSkipped: totalSkips(counters),
      ambiguousRecords: ambiguous,
      conflicts,
      errors: errors.length,
      summary,
      errorMetadata: errors.slice(0, HISTORICAL_IMPORT_MAX_ERROR_DETAILS),
    });

    return {
      run: completed,
      has_more: hasMore,
      next_offset: hasMore ? offset + limit : offset,
      findings,
    };
  } catch (error) {
    // A failure here is a failure of the run, not of one record. The
    // counters already gathered are still written, because a partial
    // report of what was examined is more useful than nothing - and a
    // report that cannot be written must not replace the real error with
    // a bookkeeping one.
    counters.findings.add('import_run_failed');
    try {
      await completeHistoricalImportRun(db, {
        accountId: request.accountId,
        runId: run.id,
        status: 'failed',
        recordsExamined: examined,
        casesCreated: request.dryRun ? 0 : created,
        casesUpdated: request.dryRun ? 0 : updated,
        casesReused: reused,
        factsImported: request.dryRun ? 0 : factsImported,
        recordsSkipped: totalSkips(counters),
        ambiguousRecords: ambiguous,
        conflicts,
        errors: errors.length + 1,
        summary: buildImportSummary(counters, projection),
        errorMetadata: [
          {
            source_kind: 'enquiry',
            source_record_id: request.sourceType,
            reason: describeError(error),
          },
        ],
      });
    } catch (bookkeepingError) {
      console.error(
        '[historical-import] could not close a failed run:',
        bookkeepingError
      );
    }
    throw error;
  }
}

/** Plan and report without writing anything to the case model. */
export async function dryRunHistoricalImport(
  db: SupabaseClient,
  request: Omit<HistoricalImportRequest, 'dryRun'>
): Promise<HistoricalImportResult> {
  return runHistoricalImport(db, { ...request, dryRun: true });
}

/** Apply the plan the dry run reported. */
export async function executeHistoricalImport(
  db: SupabaseClient,
  request: Omit<HistoricalImportRequest, 'dryRun'>
): Promise<HistoricalImportResult> {
  return runHistoricalImport(db, { ...request, dryRun: false });
}

/** Read one stored run back. Account-scoped, so no cross-tenant read. */
export async function getHistoricalImportSummary(
  db: SupabaseClient,
  input: { accountId: string; runId: string }
): Promise<HistoricalImportRun | null> {
  return getHistoricalImportRun(db, input);
}

/** The bounded list of recent runs an operator reviews before approving. */
export async function listHistoricalImportSummaries(
  db: SupabaseClient,
  input: { accountId: string; limit?: number }
): Promise<HistoricalImportRun[]> {
  return listHistoricalImportRuns(db, input);
}

/** The source ledger for one case. Exposed for the operator review path. */
export async function listCaseSources(
  db: SupabaseClient,
  input: { accountId: string; caseId: string; limit?: number }
): Promise<HistoricalCaseSource[]> {
  return listHistoricalCaseSourcesForCase(db, input);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function indexFactsByCase(
  facts: readonly HistoricalCaseFact[]
): Map<string, HistoricalCaseFact[]> {
  const index = new Map<string, HistoricalCaseFact[]>();
  for (const fact of facts) {
    const bucket = index.get(fact.case_id);
    if (bucket) {
      bucket.push(fact);
    } else {
      index.set(fact.case_id, [fact]);
    }
  }
  return index;
}

function indexMediaByConversation(
  media: ReadonlyArray<{
    id: string;
    conversation_id: string;
    created_at: string;
  }>
): Map<string, Array<{ id: string; created_at: string }>> {
  const index = new Map<string, Array<{ id: string; created_at: string }>>();
  for (const entry of media) {
    const bucket = index.get(entry.conversation_id);
    const reference = { id: entry.id, created_at: entry.created_at };
    if (!bucket) {
      index.set(entry.conversation_id, [reference]);
      continue;
    }
    if (bucket.length < HISTORICAL_IMPORT_MAX_MEDIA_PER_CASE) {
      bucket.push(reference);
    }
  }
  return index;
}

/**
 * `ambiguous` and `unusable` are the two qualities that must not train
 * anything, so they are what the run's headline "ambiguous records"
 * counter counts.
 */
function countAmbiguous(quality: HistoricalImportQuality): number {
  return quality === 'ambiguous' || quality === 'unusable' ? 1 : 0;
}

function totalSkips(counters: HistoricalImportSummaryCounters): number {
  let total = 0;
  for (const count of counters.skip_reasons.values()) total += count;
  return total;
}

function trimRef(value: string): string {
  return value.length > HISTORICAL_IMPORT_MAX_SAMPLE_REF_LENGTH
    ? value.slice(0, HISTORICAL_IMPORT_MAX_SAMPLE_REF_LENGTH)
    : value;
}

/**
 * A bounded, content-free description of a failure.
 *
 * The database message is deliberately not used: Postgres errors echo
 * constraint names and row values, and an import log is not somewhere
 * customer data should be duplicated into. The class name is enough to
 * tell an operator whether to retry or to investigate.
 */
function describeError(error: unknown): string {
  if (error instanceof HistoricalImportRepositoryError) {
    return `repository_${error.code}`;
  }
  if (error instanceof Error) {
    return error.name || 'error';
  }
  return 'unknown_error';
}

/** Re-exported so the route can narrow a source type without re-importing. */
export { HISTORICAL_IMPORT_SOURCE_TYPES } from './model';