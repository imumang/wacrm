/**
 * Minimal in-memory Supabase double for the tool tests.
 *
 * The tool layer only ever issues account-scoped PostgREST selects, so the
 * fake needs exactly four behaviours: equality filters, an `IN` filter, an
 * ordered/limited projection, and a `maybeSingle` unwrap. Every query it
 * receives is recorded so a test can assert that `account_id` was actually
 * applied rather than trusting the code path by inspection.
 *
 * This file is test-only. It is not a production Supabase wrapper and must
 * never be imported outside a `*.test.ts`.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface RecordedQuery {
  table: string;
  filters: Array<[string, unknown]>;
  inFilters: Array<[string, unknown[]]>;
  order: Array<[string, boolean]>;
  limit: number | null;
}

export interface FakeDb {
  client: SupabaseClient;
  /** Every query issued, in order. */
  queries: RecordedQuery[];
  /** Make reads from `table` report a PostgREST error. */
  failTable(table: string): void;
  queriesFor(table: string): RecordedQuery[];
}

type Row = Record<string, unknown>;

interface Result {
  data: unknown;
  error: unknown;
}

/**
 * Seed rows accept any object shape, including the typed domain models
 * (`Enquiry`, …). Those interfaces have no index signature, so they are not
 * assignable to `Record<string, unknown>`; the read side treats them as
 * plain rows anyway.
 */
export type SeedRow = object;

export function makeFakeDb(seed: Record<string, SeedRow[]> = {}): FakeDb {
  const tables = new Map<string, Row[]>(
    Object.entries(seed).map(([name, rows]) => [
      name,
      rows.map((row) => ({ ...(row as Row) })),
    ])
  );
  const failing = new Set<string>();
  const queries: RecordedQuery[] = [];

  const client = {
    from(table: string) {
      const query: RecordedQuery = {
        table,
        filters: [],
        inFilters: [],
        order: [],
        limit: null,
      };
      queries.push(query);

      const execute = (): Result => {
        if (failing.has(table)) {
          return { data: null, error: { message: 'boom' } };
        }
        return { data: match(), error: null };
      };

      const match = (): Row[] => {
        let result = (tables.get(table) ?? []).filter((row) =>
          query.filters.every(([column, value]) => row[column] === value)
        );
        for (const [column, values] of query.inFilters) {
          result = result.filter((row) => values.includes(row[column]));
        }
        // Chained order() calls become an ordered SQL ORDER BY list, so the
        // FIRST call is the primary sort and later calls only break its
        // ties. Applied right to left here so the earliest call sorts last
        // and therefore dominates. Array.prototype.sort is stable, which is
        // what makes that composition exact.
        for (const [column, ascending] of [...query.order].reverse()) {
          result = [...result].sort((a, b) =>
            compare(a[column], b[column], ascending)
          );
        }
        return query.limit === null ? result : result.slice(0, query.limit);
      };

      const chain = {
        select() {
          return chain;
        },
        eq(column: string, value: unknown) {
          query.filters.push([column, value]);
          return chain;
        },
        in(column: string, values: unknown[]) {
          query.inFilters.push([column, values]);
          return chain;
        },
        order(column: string, options?: { ascending?: boolean }) {
          query.order.push([column, options?.ascending ?? true]);
          return chain;
        },
        limit(value: number) {
          query.limit = value;
          return chain;
        },
        maybeSingle() {
          return Promise.resolve(first(execute()));
        },
        single() {
          return Promise.resolve(first(execute()));
        },
        then(
          onFulfilled: (value: unknown) => unknown,
          onRejected?: (reason: unknown) => unknown
        ) {
          return Promise.resolve(execute()).then(onFulfilled, onRejected);
        },
      };

      return chain;
    },
  } as unknown as SupabaseClient;

  return {
    client,
    queries,
    failTable: (table) => {
      failing.add(table);
    },
    queriesFor: (table) => queries.filter((query) => query.table === table),
  };
}

function compare(left: unknown, right: unknown, ascending: boolean): number {
  if (left === right) return 0;
  const direction = (left as never) < (right as never) ? -1 : 1;
  return ascending ? direction : -direction;
}

/** Collapse an array result to its first row, like `maybeSingle()`. */
function first(result: Result): Result {
  if (result.error) return result;
  const rows = (result.data as unknown[]) ?? [];
  return { data: rows[0] ?? null, error: null };
}
