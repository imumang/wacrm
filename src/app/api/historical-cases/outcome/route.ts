import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { toHistoricalCaseApiResponse } from '@/lib/historical-cases/api-error';
import { captureJobOutcome } from '@/lib/historical-cases/outcome';

/**
 * POST /api/historical-cases/outcome
 *
 * The operator entry point for job outcome capture. Two shapes, never
 * blended:
 *
 *   { enquiry_id, outcome_type: 'completed', completed: { ... } }
 *   { enquiry_id, outcome_type: 'lost',      lost:      { ... } }
 *
 * The split is the point. A rejected or unanswered quote has no arrival
 * time, no load count and no collected amount, and this route has no
 * field in which to record one - so the completed-job measurements
 * cannot be attached to an enquiry where they do not exist.
 *
 * Authorization and scope, in order:
 *
 *   - `requireRole('agent')` matches the RLS write policy the write
 *     actually runs under. A viewer is refused before any query.
 *   - The account comes from the caller's profile, never from the
 *     request body, so there is no body field that can point this write
 *     at another tenant.
 *   - The Supabase client is the caller's own, so every query in the
 *     domain layer runs through that user's RLS on top of the explicit
 *     `account_id` filter the repository applies.
 *   - The agent is recorded as the author of every fact written, which
 *     is what makes "who recorded this final amount" answerable.
 *
 * There is deliberately no approval gate, because there is no model in
 * this path. It is an operator recording what they saw; the approval
 * machinery exists to gate what a model proposes, and using it here
 * would imply an authority question that does not exist. What protects
 * the dataset instead is that nothing here can write a provenance the
 * fact vocabulary forbids - in particular no path in this module can
 * record an AI suggestion as a job outcome.
 */

interface OutcomeRequestBody {
  enquiry_id?: unknown;
  outcome_type?: unknown;
  completed?: unknown;
  lost?: unknown;
}

export async function POST(request: Request) {
  let ctx;
  try {
    ctx = await requireRole('agent');
  } catch (err) {
    return toErrorResponse(err);
  }

  const body = (await request
    .json()
    .catch(() => null)) as OutcomeRequestBody | null;

  if (!body || typeof body !== 'object') {
    return badRequest('A JSON body is required');
  }
  if (typeof body.enquiry_id !== 'string' || body.enquiry_id.trim() === '') {
    return badRequest('enquiry_id is required');
  }
  if (body.outcome_type !== 'completed' && body.outcome_type !== 'lost') {
    return badRequest("outcome_type must be 'completed' or 'lost'");
  }

  try {
    const result = await captureJobOutcome(ctx.supabase, {
      accountId: ctx.accountId,
      enquiryId: body.enquiry_id,
      recordedByUserId: ctx.userId,
      quoteDecisionIdempotencyKey:
        request.headers.get('idempotency-key') ?? undefined,
      outcome:
        body.outcome_type === 'completed'
          ? { kind: 'completed', completed: body.completed ?? {} }
          : { kind: 'lost', lost: body.lost ?? {} },
    });

    return Response.json({
      case_id: result.case.id,
      created: result.created,
      evidence_quality_tier: result.classification.tier,
      evidence_rule_version: result.classification.rule_version,
      evidence_reasons: result.classification.reasons,
      quote_decision: result.classification.quote_decision,
      learning_population: result.population,
      facts_written: result.factsWritten,
    });
  } catch (error) {
    return toHistoricalCaseApiResponse(error);
  }
}

function badRequest(message: string) {
  return Response.json({ error: message }, { status: 400 });
}
