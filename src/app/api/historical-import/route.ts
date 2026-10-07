import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { canImportHistoricalData } from '@/lib/auth/roles';
import {
  HISTORICAL_IMPORT_SOURCE_TYPES,
  type HistoricalImportSourceType,
} from '@/lib/historical-import/model';
import { HistoricalImportRepositoryError } from '@/lib/historical-import/repository';
import {
  dryRunHistoricalImport,
  executeHistoricalImport,
  listHistoricalImportSummaries,
} from '@/lib/historical-import/service';
import { inspectHistoricalSources } from '@/lib/historical-import/source-inventory';

/**
 * GET  /api/historical-import  - inspect the available history
 * POST /api/historical-import  - dry-run or execute an import
 *
 * The operator entry point for roadmap objective 02. There is no import
 * UI in this application and there is not going to be one in this
 * objective, so the surface is JSON. What it deliberately is NOT:
 *
 *   - Not an AI tool. Nothing here reaches a model, an image analyser
 *     or any external service. The mapping is the pure planner in
 *     `src/lib/historical-import/plan.ts`.
 *   - Not a query interface. The only inputs are a source type, a
 *     `dry_run` flag and a bounded page position. There is no table
 *     name, no filter object and no way to ask the service a question
 *     it was not written to answer.
 *   - Not account-selectable. The account comes from the caller's
 *     profile. A body field cannot redirect a read or a write at
 *     another tenant, so there is nothing to validate away.
 *
 * Authorization is `admin`, matching the RLS write policy the writes
 * actually run under (migration 051). The caller's own Supabase client
 * is used, so RLS applies on top of the explicit account filter the
 * repository already applies - defence in depth rather than one or the
 * other.
 *
 * `dry_run` defaults to true. An import that forgets to say what it is
 * gets a plan instead of a write, which is the only safe default for an
 * operation that rewrites a learning dataset.
 */

interface ImportRequestBody {
  source_type?: unknown;
  dry_run?: unknown;
  offset?: unknown;
  limit?: unknown;
}

export async function GET(request: Request) {
  let ctx;
  try {
    ctx = await requireRole('viewer');
  } catch (err) {
    return toErrorResponse(err);
  }

  const url = new URL(request.url);
  const runId = url.searchParams.get('run_id');
  const limit = readBoundedInteger(url.searchParams.get('limit'));

  try {
    if (runId) {
      const runs = await listHistoricalImportSummaries(ctx.supabase, {
        accountId: ctx.accountId,
        limit: 1,
      });
      const found = runs.find((run) => run.id === runId);
      return Response.json({ run: found ?? null });
    }

    const inspection = await inspectHistoricalSources(ctx.supabase, {
      accountId: ctx.accountId,
      limit: limit ?? 200,
    });

    return Response.json({
      account_id: inspection.account_id,
      counts: inspection.counts,
      mappable: inspection.mappable,
      unmappable: inspection.unmappable,
      findings: inspection.findings,
      inventory: inspection.inventory,
      absent_sources: inspection.absent_sources,
      recent_runs: await listHistoricalImportSummaries(ctx.supabase, {
        accountId: ctx.accountId,
        limit: limit ?? 20,
      }),
    });
  } catch (error) {
    return importErrorResponse(error);
  }
}

export async function POST(request: Request) {
  let ctx;
  try {
    // Refused before any query runs, and refused on the role rather than
    // on a body flag.
    ctx = await requireRole('viewer');
  } catch (err) {
    return toErrorResponse(err);
  }

  if (!canImportHistoricalData(ctx.role)) {
    return Response.json(
      {
        error:
          "This action requires the 'admin' role or higher: a historical import changes what the account's training set will contain",
      },
      { status: 403 }
    );
  }

  const body = (await request
    .json()
    .catch(() => null)) as ImportRequestBody | null;

  if (!body || typeof body !== 'object') {
    return Response.json({ error: 'A JSON body is required' }, { status: 400 });
  }

  const sourceType = readSourceType(body.source_type);
  if (sourceType === null) {
    return Response.json(
      {
        error: `source_type must be one of: ${HISTORICAL_IMPORT_SOURCE_TYPES.join(', ')}`,
      },
      { status: 400 }
    );
  }

  // Defaults to a dry run. An import has to be asked for explicitly.
  const dryRun = body.dry_run === undefined ? true : body.dry_run !== false;
  const offset = readBoundedInteger(body.offset) ?? 0;
  const limit = readBoundedInteger(body.limit) ?? undefined;

  try {
    const result = dryRun
      ? await dryRunHistoricalImport(ctx.supabase, {
          accountId: ctx.accountId,
          sourceType,
          triggeredByUserId: ctx.userId,
          offset,
          limit,
        })
      : await executeHistoricalImport(ctx.supabase, {
          accountId: ctx.accountId,
          sourceType,
          triggeredByUserId: ctx.userId,
          offset,
          limit,
        });

    return Response.json(boundedRunResponse(result));
  } catch (error) {
    return importErrorResponse(error);
  }
}

/**
 * The response body.
 *
 * Bounded on purpose: the run row, the paging hint, and the findings.
 * The raw plan is not returned - a 200-record plan is not something an
 * operator reads in a JSON response, and the facts it contains are
 * derived from the canonical enquiry columns that are already visible
 * in WACRM.
 */
function boundedRunResponse(result: {
  run: Awaited<ReturnType<typeof dryRunHistoricalImport>>['run'];
  has_more: boolean;
  next_offset: number;
  findings: readonly string[];
}) {
  const { run } = result;
  return {
    run_id: run.id,
    source_type: run.source_type,
    dry_run: run.dry_run,
    status: run.status,
    started_at: run.started_at,
    completed_at: run.completed_at,
    importer_version: run.importer_version,
    records_examined: run.records_examined,
    cases_created: run.cases_created,
    cases_updated: run.cases_updated,
    cases_reused: run.cases_reused,
    facts_imported: run.facts_imported,
    records_skipped: run.records_skipped,
    ambiguous_records: run.ambiguous_records,
    conflicts: run.conflicts,
    errors: run.errors,
    summary: run.summary,
    error_metadata: run.error_metadata,
    has_more: result.has_more,
    next_offset: result.next_offset,
    findings: result.findings,
  };
}

function readSourceType(value: unknown): HistoricalImportSourceType | null {
  if (
    typeof value === 'string' &&
    (HISTORICAL_IMPORT_SOURCE_TYPES as readonly string[]).includes(value)
  ) {
    return value as HistoricalImportSourceType;
  }
  return null;
}

function readBoundedInteger(value: unknown): number | null {
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
  }
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value;
  }
  return null;
}

/**
 * Map a domain error onto a response.
 *
 * The domain's own message is returned for the three classified codes -
 * an operator who passed a bad offset needs to be told so - while an
 * unclassified error collapses to a generic 500. A Postgres error
 * string echoes constraint names and row values, and this is not a
 * place to leak one.
 */
function importErrorResponse(error: unknown): Response {
  if (error instanceof HistoricalImportRepositoryError) {
    const status =
      error.code === 'invalid_input'
        ? 400
        : error.code === 'not_found'
          ? 404
          : 500;
    return Response.json({ error: error.message }, { status });
  }
  console.error('[historical-import] uncategorized error:', error);
  return Response.json({ error: 'Historical import failed' }, { status: 500 });
}