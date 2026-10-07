import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { toHistoricalCaseApiResponse } from '@/lib/historical-cases/api-error';
import { finalizeHistoricalCase } from '@/lib/historical-cases/outcome';

/**
 * POST /api/historical-cases/[caseId]/finalize
 *
 * Freeze a case into an immutable learning example. Operator-driven and
 * explicit: nothing in WACRM finalizes a case on its own, because a
 * case frozen too early is a training example that can never be
 * corrected, and WACRM has no way yet to know when that moment is. The
 * capture workflow writes; this only freezes.
 *
 * Idempotent. A second call on an already-finalized case returns the
 * same case with `replayed: true` and writes nothing, so a double click,
 * a retried request, or two agents closing the same job at the same
 * time all converge on one frozen answer.
 *
 * `replayed: true` is reported rather than hidden so a caller can tell
 * "you just froze this" from "this was frozen earlier", which matters
 * when the response is what a human reads to confirm the job is closed.
 */

export async function POST(
  _request: Request,
  context: { params: Promise<{ caseId: string }> }
) {
  let ctx;
  try {
    ctx = await requireRole('agent');
  } catch (err) {
    return toErrorResponse(err);
  }

  const { caseId } = await context.params;
  if (!caseId) {
    return Response.json({ error: 'caseId is required' }, { status: 400 });
  }

  try {
    const result = await finalizeHistoricalCase(ctx.supabase, {
      accountId: ctx.accountId,
      caseId,
      recordedByUserId: ctx.userId,
    });

    return Response.json({
      case_id: result.case.id,
      finalized_at: result.case.finalized_at,
      evidence_quality_tier: result.case.evidence_quality_tier,
      snapshot_kinds: result.snapshotKinds,
      replayed: result.replayed,
    });
  } catch (error) {
    return toHistoricalCaseApiResponse(error);
  }
}