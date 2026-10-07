import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { toHistoricalCaseApiResponse } from '@/lib/historical-cases/api-error';
import { setFinalizedCaseLearningEligibility } from '@/lib/historical-cases/outcome';
import {
  HISTORICAL_CASE_ELIGIBILITY_BASES,
  HISTORICAL_CASE_EXCLUSION_REASONS,
} from '@/lib/historical-cases/model';

/**
 * POST /api/historical-cases/[caseId]/correction
 *
 * The one thing that may change about a finalized case: whether it may
 * train a model.
 *
 * Body: { eligibility: 'excluded' | 'included', reason, basis, note }
 *
 * This exists because objective 01 froze finalized cases completely,
 * which left `learning_eligibility` unreachable on exactly the rows where
 * it matters most. A case discovered to be mis-recorded, unconsented, or
 * imported wrongly would otherwise sit in the training population
 * forever with no way out that did not involve deleting the record of
 * what happened.
 *
 * What it deliberately does NOT do is edit anything the case said. The
 * facts and the finalization snapshots stay frozen; a `correction`
 * snapshot is appended alongside them, so the frozen example is still
 * exactly reproducible and the change of mind is still visible. If a
 * finalized amount is genuinely wrong, the honest answer is a new case,
 * not an edit to the one that was closed.
 */

interface CorrectionBody {
  eligibility?: unknown;
  reason?: unknown;
  basis?: unknown;
  note?: unknown;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ caseId: string }> }
) {
  let ctx;
  try {
    ctx = await requireRole('agent');
  } catch (err) {
    return toErrorResponse(err);
  }

  const { caseId } = await context.params;
  const body = (await request
    .json()
    .catch(() => null)) as CorrectionBody | null;

  if (!body || typeof body !== 'object') {
    return Response.json({ error: 'A JSON body is required' }, { status: 400 });
  }
  if (body.eligibility !== 'included' && body.eligibility !== 'excluded') {
    return Response.json(
      { error: "eligibility must be 'included' or 'excluded'" },
      { status: 400 }
    );
  }
  if (body.eligibility === 'excluded') {
    if (
      typeof body.reason !== 'string' ||
      !HISTORICAL_CASE_EXCLUSION_REASONS.includes(
        body.reason as (typeof HISTORICAL_CASE_EXCLUSION_REASONS)[number]
      )
    ) {
      return Response.json(
        {
          error: `reason must be one of: ${HISTORICAL_CASE_EXCLUSION_REASONS.join(', ')}`,
        },
        { status: 400 }
      );
    }
  }
  if (
    typeof body.basis !== 'string' ||
    !HISTORICAL_CASE_ELIGIBILITY_BASES.includes(
      body.basis as (typeof HISTORICAL_CASE_ELIGIBILITY_BASES)[number]
    )
  ) {
    return Response.json(
      { error: `basis must be one of: ${HISTORICAL_CASE_ELIGIBILITY_BASES.join(', ')}` },
      { status: 400 }
    );
  }
  if (typeof body.note !== 'string' || body.note.trim() === '') {
    return Response.json(
      { error: 'A note explaining the correction is required' },
      { status: 400 }
    );
  }

  try {
    const updated = await setFinalizedCaseLearningEligibility(
      ctx.supabase,
      {
        accountId: ctx.accountId,
        caseId,
        eligibility: body.eligibility,
        reason: (body.reason ?? null) as never,
        basis: body.basis as never,
        recordedByUserId: ctx.userId,
        note: body.note,
      }
    );

    return Response.json({
      case_id: updated.id,
      finalized_at: updated.finalized_at,
      learning_eligibility: updated.learning_eligibility,
      learning_exclusion_reason: updated.learning_exclusion_reason,
      learning_eligibility_basis: updated.learning_eligibility_basis,
    });
  } catch (error) {
    return toHistoricalCaseApiResponse(error);
  }
}