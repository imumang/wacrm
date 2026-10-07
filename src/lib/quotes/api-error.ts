import { QuoteValidationError } from './model';
import { QuoteRepositoryError } from './repository';

export function toQuoteApiResponse(error: unknown): Response {
  if (error instanceof QuoteValidationError) {
    return structuredError('invalid_input', error.message, 400);
  }
  if (error instanceof QuoteRepositoryError) {
    const status =
      error.code === 'invalid_input'
        ? 400
        : error.code === 'not_found'
          ? 404
          : error.code === 'conflict'
            ? 409
            : 500;
    return structuredError(
      error.code === 'database_error' ? 'internal' : error.code,
      error.code === 'database_error'
        ? 'Quote operation failed'
        : error.message,
      status,
      error.code === 'database_error'
    );
  }
  console.error('[quotes] uncategorized error:', error);
  return structuredError('internal', 'Quote operation failed', 500, false);
}

export function quoteBadRequest(message: string): Response {
  return structuredError('invalid_input', message, 400);
}

function structuredError(
  code: string,
  message: string,
  status: number,
  retryable = false
): Response {
  return Response.json({ error: { code, message, retryable } }, { status });
}
