import type { SupabaseClient } from '@supabase/supabase-js';

import type { Enquiry } from '@/lib/enquiries/model';

type Row = Record<string, unknown>;

export interface FakeQueryCall {
  table: string;
  operation: 'select' | 'insert';
  filters: Array<
    | { kind: 'eq'; column: string; value: unknown }
    | { kind: 'in'; column: string; values: unknown[] }
    | { kind: 'not_null'; column: string }
  >;
  orders: Array<{ column: string; ascending: boolean }>;
  limit: number | null;
}

export interface FakeToolDatabase {
  db: SupabaseClient;
  calls: FakeQueryCall[];
  rows(table: string): Row[];
}

export function fakeToolDatabase(
  seed: Record<string, object[]> = {}
): FakeToolDatabase {
  const tables = new Map(
    Object.entries(seed).map(([table, rows]) => [
      table,
      rows.map((row) => ({ ...row }) as Row),
    ])
  );
  const calls: FakeQueryCall[] = [];

  const db = {
    from(table: string) {
      const call: FakeQueryCall = {
        table,
        operation: 'select',
        filters: [],
        orders: [],
        limit: null,
      };
      calls.push(call);
      let insertPayload: Row | null = null;

      const executeSelect = () => {
        let rows = [...(tables.get(table) ?? [])];
        rows = rows.filter((row) =>
          call.filters.every((filter) => {
            if (filter.kind === 'eq') {
              return row[filter.column] === filter.value;
            }
            if (filter.kind === 'not_null') {
              return (
                row[filter.column] !== null && row[filter.column] !== undefined
              );
            }
            return filter.values.includes(row[filter.column]);
          })
        );
        rows.sort((left, right) => {
          for (const order of call.orders) {
            const comparison = compare(left[order.column], right[order.column]);
            if (comparison !== 0) {
              return order.ascending ? comparison : -comparison;
            }
          }
          return 0;
        });
        if (call.limit !== null) rows = rows.slice(0, call.limit);
        return rows;
      };

      const execute = (): {
        data: Row[];
        error: null | Record<string, unknown>;
      } => {
        if (call.operation === 'select') {
          return { data: executeSelect(), error: null };
        }

        const payload = insertPayload ?? {};
        if (table === 'enquiries') {
          const enquiries = tables.get('enquiries') ?? [];
          const idempotencyClash = enquiries.some(
            (row) =>
              row.account_id === payload.account_id &&
              payload.repeat_action_idempotency_key != null &&
              row.repeat_action_idempotency_key ===
                payload.repeat_action_idempotency_key
          );
          const activeClash = enquiries.some(
            (row) =>
              row.conversation_id === payload.conversation_id &&
              !['cancelled', 'completed'].includes(String(row.workflow_state))
          );
          if (idempotencyClash || activeClash) {
            return { data: [], error: { code: '23505' } };
          }

          const now = '2026-10-01T12:00:00.000Z';
          const row: Row = {
            id: `enquiry-${enquiries.length + 1}`,
            account_id: payload.account_id,
            conversation_id: payload.conversation_id,
            created_by_user_id: payload.created_by_user_id,
            workflow_state: 'new_enquiry',
            customer_intent: null,
            postcode: null,
            address: null,
            property_type: null,
            floor: null,
            lift_available: null,
            parking: null,
            access_constraints: null,
            item_descriptions: null,
            waste_type: null,
            estimated_volume: null,
            heavy_special_items: null,
            photos_received: null,
            preferred_date: null,
            preferred_time_window: null,
            missing_information: [],
            state_changed_at: now,
            created_at: now,
            updated_at: now,
            ...payload,
          };
          enquiries.push(row);
          tables.set('enquiries', enquiries);

          const events = tables.get('enquiry_state_events') ?? [];
          events.push({
            id: `event-${events.length + 1}`,
            account_id: row.account_id,
            enquiry_id: row.id,
            from_state: null,
            to_state: 'new_enquiry',
            changed_by_user_id: row.created_by_user_id ?? null,
            changed_at: now,
          });
          tables.set('enquiry_state_events', events);
          return { data: [row], error: null };
        }

        const rows = tables.get(table) ?? [];
        const row = { ...payload };
        rows.push(row);
        tables.set(table, rows);
        return { data: [row], error: null };
      };

      const query = {
        select() {
          return query;
        },
        insert(value: Row) {
          call.operation = 'insert';
          insertPayload = value;
          return query;
        },
        eq(column: string, value: unknown) {
          call.filters.push({ kind: 'eq', column, value });
          return query;
        },
        in(column: string, values: readonly unknown[]) {
          call.filters.push({ kind: 'in', column, values: [...values] });
          return query;
        },
        not(column: string, operator: string, value: unknown) {
          if (operator === 'is' && value === null) {
            call.filters.push({ kind: 'not_null', column });
          }
          return query;
        },
        order(column: string, options: { ascending?: boolean } = {}) {
          call.orders.push({
            column,
            ascending: options.ascending ?? true,
          });
          return query;
        },
        limit(value: number) {
          call.limit = value;
          return query;
        },
        async maybeSingle() {
          const result = execute();
          return { data: result.data[0] ?? null, error: result.error };
        },
        async single() {
          const result = execute();
          return { data: result.data[0] ?? null, error: result.error };
        },
        then<
          TResult1 = {
            data: Row[];
            error: null | Record<string, unknown>;
          },
          TResult2 = never,
        >(
          onfulfilled?:
            | ((value: {
                data: Row[];
                error: null | Record<string, unknown>;
              }) => TResult1 | PromiseLike<TResult1>)
            | null,
          onrejected?:
            ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
        ) {
          return Promise.resolve(execute()).then(onfulfilled, onrejected);
        },
      };
      return query;
    },
  } as unknown as SupabaseClient;

  return {
    db,
    calls,
    rows: (table) => (tables.get(table) ?? []).map((row) => ({ ...row })),
  };
}

export function enquiryRow(overrides: Partial<Enquiry> = {}): Enquiry {
  return {
    id: 'enquiry-1',
    account_id: 'account-1',
    conversation_id: 'conversation-1',
    created_by_user_id: 'user-1',
    workflow_state: 'new_enquiry',
    customer_intent: null,
    postcode: null,
    address: null,
    property_type: null,
    floor: null,
    lift_available: null,
    parking: null,
    access_constraints: null,
    item_descriptions: null,
    waste_type: null,
    estimated_volume: null,
    heavy_special_items: null,
    photos_received: null,
    preferred_date: null,
    preferred_time_window: null,
    missing_information: [],
    state_changed_at: '2026-10-01T09:00:00.000Z',
    created_at: '2026-10-01T09:00:00.000Z',
    updated_at: '2026-10-01T09:00:00.000Z',
    ...overrides,
  };
}

export function toolContext(db: SupabaseClient, accountId = 'account-1') {
  return {
    db,
    account_id: accountId,
    actor: { type: 'user' as const, user_id: 'user-1' },
    correlation_id: 'run-1',
  };
}

function compare(left: unknown, right: unknown): number {
  if (left === right) return 0;
  if (left === null || left === undefined) return -1;
  if (right === null || right === undefined) return 1;
  return String(left).localeCompare(String(right));
}
