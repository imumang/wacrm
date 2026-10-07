import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { canGenerateVectorMemory } from '@/lib/auth/roles';
import { CaseEmbeddingRepositoryError } from '@/lib/vector-memory/repository';
import { VectorMemoryError } from '@/lib/vector-memory/model';
import { countEmbeddingCoverage } from '@/lib/vector-memory/repository';
import {
  VECTOR_MEMORY_OPERATION_MODES,
  runCaseEmbeddingOperation,
  type VectorMemoryOperationMode,
} from '@/lib/vector-memory/service';

/**
 * GET  /api/vector-memory  - inspect vector memory (read-only)
 * POST /api/vector-memory  - dry-run or run a bounded generation pass
 *
 * The operator entry point for roadmap objective 03. There is no vector
 * UI in this application and there is not going to be one in this
 * objective, so the surface is JSON.
 *
 * What it deliberately is NOT:
 *
 *   - Not a search interface. There is no query vector, no similarity,
 *     no top-k, no weights. Objective 04 owns retrieval; this route
 *     cannot return a comparable job even if asked, because it has no
 *     code path that could.
 *   - Not an arbitrary embedding source. The only accepted inputs are a
 *     mode, a bound and a page offset. Semantic content is always
 *     rebuilt from canonical data inside the domain layer, so nobody
 *     can write arbitrary text into this account's vector memory
 *     through this route.
 *   - Not account-selectable. The account comes from the caller's
 *     profile. There is no body field that can redirect a write at
 *     another tenant, so there is nothing to validate away.
 *   - Not automatic. No migration, webhook, or outcome-capture path
 *     calls this. The paid API is reached only when a human asks.
 *
 * Authorization is `admin` for POST, matching the RLS write policy the
 * writes run under (migration 053) and `canGenerateVectorMemory`. The
 * caller's own Supabase client is used, so RLS applies on top of the
 * explicit account filter the repository already applies.
 *
 * `dry_run` defaults to true. An operation that forgets to say whether
 * it is real gets a plan instead of a paid call, which is the only safe
 * default for something that spends the account's money.
 */

interface VectorMemoryRequestBody {
  mode?: unknown;
  dry_run?: unknown;
  limit?: unknown;
  offset?: unknown;
}

export async function GET() {
  let ctx;
  try {
    // Viewer can see coverage: it is a read of account data the member
    // can already read. The vector payloads themselves are never
    // returned.
    ctx = await requireRole('viewer');
  } catch (err) {
    return toErrorResponse(err);
  }

  try {
    return Response.json({
      account_id: ctx.accountId,
      coverage: await countEmbeddingCoverage(ctx.supabase, {
        accountId: ctx.accountId,
      }),
      modes: VECTOR_MEMORY_OPERATION_MODES,
    });
  } catch (error) {
    return vectorMemoryErrorResponse(error);
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

  if (!canGenerateVectorMemory(ctx.role)) {
    return Response.json(
      {
        error:
          "This action requires the 'admin' role or higher: generating vector memory spends the account's embeddings key over its whole learning dataset",
      },
      { status: 403 }
    );
  }

  const body = (await request
    .json()
    .catch(() => null)) as VectorMemoryRequestBody | null;

  if (!body || typeof body !== 'object') {
    return Response.json({ error: 'A JSON body is required' }, { status: 400 });
  }

  const mode = readMode(body.mode);
  if (mode === null) {
    return Response.json(
      {
        error: `mode must be one of: ${VECTOR_MEMORY_OPERATION_MODES.join(', ')}`,
      },
      { status: 400 }
    );
  }

  // Defaults to a dry run. Generating embeddings has to be asked for.
  const dryRun = body.dry_run === undefined ? true : body.dry_run !== false;
  const limit = readBoundedInteger(body.limit) ?? undefined;
  const offset = readBoundedInteger(body.offset) ?? 0;

  try {
    const result = await runCaseEmbeddingOperation(ctx.supabase, {
      accountId: ctx.accountId,
      mode,
      dryRun,
      limit,
      offset,
    });

    return Response.json({
      correlation_id: result.correlation_id,
      mode: result.mode,
      dry_run: result.dry_run,
      has_more: result.has_more,
      next_offset: result.next_offset,
      examined: result.examined,
      generated: result.generated,
      up_to_date: result.up_to_date,
      skipped: result.skipped,
      ineligible: result.ineligible,
      findings: result.findings,
      // Per-case outcomes carry a case id, a reason, and a state. They
      // deliberately carry no semantic content, no amounts, and no
      // vector values.
      outcomes: result.outcomes,
    });
  } catch (error) {
    return vectorMemoryErrorResponse(error);
  }
}

function readMode(value: unknown): VectorMemoryOperationMode | null {
  if (
    typeof value === 'string' &&
    (VECTOR_MEMORY_OPERATION_MODES as readonly string[]).includes(value)
  ) {
    return value as VectorMemoryOperationMode;
  }
  return null;
}

/**
 * Non-negative whole number, or null.
 *
 * A malformed limit is treated as absent rather than as an error, so a
 * bad query string produces the documented default instead of a
 * confusing rejection. The domain still clamps the value into its
 * bounds, so this cannot be used to ask for an unbounded batch.
 */
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
 * The domain's own message is returned for the classified codes — an
 * operator who passed a bad mode needs to be told so. A `database_error`
 * deliberately does not surface the driver message: Postgres errors echo
 * constraint names and row values.
 */
function vectorMemoryErrorResponse(error: unknown): Response {
  if (error instanceof VectorMemoryError) {
    if (error.code === 'invalid_input') {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error.code === 'unavailable') {
      return Response.json({ error: error.message }, { status: 409 });
    }
    if (error.code === 'unsupported') {
      return Response.json({ error: error.message }, { status: 501 });
    }
    if (error.code === 'not_found') {
      return Response.json({ error: error.message }, { status: 404 });
    }
    return Response.json({ error: 'Vector memory operation failed' }, { status: 500 });
  }
  if (error instanceof CaseEmbeddingRepositoryError) {
    const status =
      error.code === 'invalid_input'
        ? 400
        : error.code === 'not_found'
          ? 404
          : error.code === 'conflict'
            ? 409
            : 500;
    return Response.json({ error: error.message }, { status });
  }
  console.error('[vector-memory] uncategorized error:', error);
  return Response.json({ error: 'Vector memory operation failed' }, { status: 500 });
}
