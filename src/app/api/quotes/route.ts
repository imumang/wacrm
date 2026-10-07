import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { canImportHistoricalData } from '@/lib/auth/roles';
import { quoteBadRequest, toQuoteApiResponse } from '@/lib/quotes/api-error';
import { createQuoteService } from '@/lib/quotes/service';

interface CreateQuoteBody {
  action?: unknown;
  enquiry_id?: unknown;
  proposal?: unknown;
}

/**
 * GET /api/quotes?enquiry_id=...
 * POST /api/quotes
 *
 * Account scope and actor identity always come from the authenticated profile.
 * There is intentionally no `account_id` or `created_by` request field.
 */
export async function GET(request: Request) {
  let ctx;
  try {
    ctx = await requireRole('viewer');
  } catch (error) {
    return toErrorResponse(error);
  }

  const enquiryId = new URL(request.url).searchParams.get('enquiry_id');
  if (!enquiryId) return quoteBadRequest('enquiry_id is required');

  try {
    const service = createQuoteService(ctx.supabase);
    const [current, history] = await Promise.all([
      service.getCurrentQuote(ctx.accountId, enquiryId),
      service.getQuoteHistory(ctx.accountId, enquiryId),
    ]);
    return Response.json({ current_quote: current, ...history });
  } catch (error) {
    return toQuoteApiResponse(error);
  }
}

export async function POST(request: Request) {
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
  const body = (await request
    .json()
    .catch(() => null)) as CreateQuoteBody | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return quoteBadRequest('A JSON body is required');
  }
  const unknown = Object.keys(body).filter(
    (key) => !['action', 'enquiry_id', 'proposal'].includes(key)
  );
  if (unknown.length > 0) {
    return quoteBadRequest(`Unknown request fields: ${unknown.join(', ')}`);
  }
  if (typeof body.enquiry_id !== 'string' || body.enquiry_id.trim() === '') {
    return quoteBadRequest('enquiry_id is required');
  }
  if (body.action !== 'create_manual' && body.action !== 'create_imported') {
    return quoteBadRequest(
      "action must be 'create_manual' or 'create_imported'"
    );
  }
  if (body.action === 'create_imported' && !canImportHistoricalData(ctx.role)) {
    return Response.json(
      {
        error: {
          code: 'forbidden',
          message:
            'Imported historical quotes require the admin role or higher',
          retryable: false,
        },
      },
      { status: 403 }
    );
  }

  try {
    const result = await createQuoteService(ctx.supabase).createManualQuote({
      accountId: ctx.accountId,
      enquiryId: body.enquiry_id,
      actorUserId: ctx.userId,
      idempotencyKey,
      origin:
        body.action === 'create_imported' ? 'imported_historical' : 'manual',
      proposal: body.proposal,
    });
    return Response.json(result, { status: result.replayed ? 200 : 201 });
  } catch (error) {
    return toQuoteApiResponse(error);
  }
}
