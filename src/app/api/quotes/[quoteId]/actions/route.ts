import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { quoteBadRequest, toQuoteApiResponse } from '@/lib/quotes/api-error';
import { createQuoteService } from '@/lib/quotes/service';

interface QuoteActionBody {
  action?: unknown;
  proposal?: unknown;
  decision?: unknown;
  decision_note?: unknown;
  origin?: unknown;
}

/** Explicit transitions only; this route is not a generic quote PATCH. */
export async function POST(
  request: Request,
  context: { params: Promise<{ quoteId: string }> }
) {
  let ctx;
  try {
    ctx = await requireRole('agent');
  } catch (error) {
    return toErrorResponse(error);
  }

  const idempotencyKey = request.headers.get('idempotency-key');
  if (!idempotencyKey) {
    return quoteBadRequest('Idempotency-Key header is required');
  }
  const { quoteId } = await context.params;
  if (!quoteId) return quoteBadRequest('quoteId is required');

  const body = (await request
    .json()
    .catch(() => null)) as QuoteActionBody | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return quoteBadRequest('A JSON body is required');
  }
  const unknown = Object.keys(body).filter(
    (key) =>
      !['action', 'proposal', 'decision', 'decision_note', 'origin'].includes(
        key
      )
  );
  if (unknown.length > 0) {
    return quoteBadRequest(`Unknown request fields: ${unknown.join(', ')}`);
  }

  const common = {
    accountId: ctx.accountId,
    quoteId,
    actorUserId: ctx.userId,
    idempotencyKey,
  };
  const service = createQuoteService(ctx.supabase);

  try {
    const result =
      body.action === 'approve'
        ? await service.approveQuote(common)
        : body.action === 'present'
          ? await service.markQuotePresented(common)
          : body.action === 'record_decision'
            ? await service.recordQuoteDecision({
                ...common,
                decision: body.decision,
                decisionNote: body.decision_note,
              })
            : body.action === 'revise'
              ? await service.reviseQuote({
                  ...common,
                  proposal: body.proposal,
                  origin:
                    body.origin === undefined
                      ? undefined
                      : body.origin === 'manual' ||
                          body.origin === 'imported_historical'
                        ? body.origin
                        : (body.origin as never),
                })
              : body.action === 'withdraw'
                ? await service.withdrawQuote(common)
                : body.action === 'expire'
                  ? await service.expireQuote(common)
                  : null;

    if (result === null) {
      return quoteBadRequest(
        'action must be approve, present, record_decision, revise, withdraw, or expire'
      );
    }
    return Response.json(result);
  } catch (error) {
    return toQuoteApiResponse(error);
  }
}
