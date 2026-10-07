import { NextResponse } from 'next/server';

import { HistoricalCaseRepositoryError } from './repository';

/**
 * Map a historical-case domain error onto an HTTP response.
 *
 * The domain already distinguishes `invalid_input`, `not_found` and
 * `conflict`, and those three map onto exactly three status codes. The
 * important one is `invalid_input` becoming 400 with the domain's own
 * message: an operator who mistyped a departure time has to be told
 * which field was wrong, and a generic "bad request" would make the
 * capture form unusable.
 *
 * A `database_error` deliberately does NOT surface the driver message.
 * Postgres errors echo constraint names, column values and sometimes
 * SQL, so the generic message is the only safe thing to return.
 */
export function toHistoricalCaseApiResponse(error: unknown): NextResponse {
  if (error instanceof HistoricalCaseRepositoryError) {
    if (error.code === 'not_found') {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error.code === 'conflict') {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error.code === 'invalid_input') {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: 'Could not record the job outcome' },
      { status: 500 }
    );
  }

  console.error('[historical-cases] uncategorized error:', error);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}