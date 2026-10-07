import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import {
  INITIAL_ENQUIRY_STATE,
  TERMINAL_ENQUIRY_STATES,
  type Enquiry,
} from './model';
import { ensureInitialEnquiryForConversation } from './repository';

type Row = Record<string, unknown>;

/**
 * In-memory PostgREST double for the initial-activation rule.
 *
 * It models the two database guarantees the rule leans on, because the
 * rule's correctness lives in them rather than in the TypeScript:
 *
 *   - `idx_enquiries_one_active_per_conversation` — a second insert for a
 *     conversation that already has a non-terminal enquiry fails with a
 *     unique violation (23505), exactly as Postgres does.
 *   - terminal enquiries are outside that index, so a completed or
 *     cancelled history is *not* protected by it. Only the explicit
 *     "no enquiry history at all" check can stop a second job from
 *     appearing, which is why the tests below cover terminal history
 *     explicitly rather than trusting the index.
 */
interface FakeDb {
  client: SupabaseClient;
  conversations: Row[];
  enquiries: Row[];
  calls: Array<{
    table: string;
    operation: 'select' | 'insert';
    filters: Array<[string, unknown]>;
  }>;
  /** Fail the next operation on `table`, modelling a transient outage. */
  failNext(table: string, error?: Record<string, unknown>): void;
  insertCount(): number;
}

const NOW = '2026-10-01T12:00:00.000Z';

function makeDb(seed?: {
  conversations?: Row[];
  enquiries?: Row[];
}): FakeDb {
  const conversations = [...(seed?.conversations ?? [])];
  const enquiries: Row[] = [...(seed?.enquiries ?? [])];
  const calls: FakeDb['calls'] = [];
  const failures = new Map<string, Record<string, unknown>>();
  let nextId = 1;

  const client = {
    from(table: string) {
      const call = {
        table,
        operation: 'select' as 'select' | 'insert',
        filters: [] as Array<[string, unknown]>,
      };
      calls.push(call);

      let payload: Row = {};
      let limit: number | null = null;
      const orders: Array<[string, boolean]> = [];
      const filters = call.filters;

      const source = (): Row[] =>
        table === 'conversations' ? conversations : enquiries;

      const matchingRows = (): Row[] => {
        let rows = source().filter((row) =>
          filters.every(([column, value]) => row[column] === value)
        );
        for (const [column, ascending] of [...orders].reverse()) {
          rows = [...rows].sort((left, right) => {
            const a = left[column];
            const b = right[column];
            if (a === b) return 0;
            const direction = (a as never) < (b as never) ? -1 : 1;
            return ascending ? direction : -direction;
          });
        }
        return limit === null ? rows : rows.slice(0, limit);
      };

      const execute = (): { data: unknown; error: unknown } => {
        const injected = failures.get(table);
        if (injected) {
          failures.delete(table);
          return { data: null, error: injected };
        }

        if (call.operation === 'insert') {
          // The one-active-enquiry partial unique index.
          const clash = enquiries.find(
            (row) =>
              row.conversation_id === payload.conversation_id &&
              !(TERMINAL_ENQUIRY_STATES as readonly string[]).includes(
                String(row.workflow_state)
              )
          );
          if (clash) {
            return {
              data: null,
              error: {
                code: '23505',
                message:
                  'duplicate key value violates unique constraint "idx_enquiries_one_active_per_conversation"',
              },
            };
          }

          const row: Row = {
            id: `enquiry-${nextId++}`,
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
            workflow_state: INITIAL_ENQUIRY_STATE,
            state_changed_at: NOW,
            created_at: NOW,
            updated_at: NOW,
            ...payload,
          };
          enquiries.push(row);
          return { data: row, error: null };
        }

        return { data: matchingRows()[0] ?? null, error: null };
      };

      const builder = {
        select() {
          return builder;
        },
        insert(value: Row) {
          call.operation = 'insert';
          payload = value;
          return builder;
        },
        update() {
          return builder;
        },
        eq(column: string, value: unknown) {
          filters.push([column, value]);
          return builder;
        },
        order(column: string, options?: { ascending?: boolean }) {
          orders.push([column, options?.ascending ?? true]);
          return builder;
        },
        limit(value: number) {
          limit = value;
          return builder;
        },
        maybeSingle() {
          return Promise.resolve(execute());
        },
        single() {
          return Promise.resolve(execute());
        },
      };

      return builder;
    },
  } as unknown as SupabaseClient;

  return {
    client,
    conversations,
    enquiries,
    calls,
    failNext: (table, error) => {
      failures.set(table, error ?? { code: '57014', message: 'db is busy' });
    },
    insertCount: () =>
      calls.filter(
        (call) => call.table === 'enquiries' && call.operation === 'insert'
      ).length,
  };
}

/** A persisted enquiry row as the database would return it. */
function enquiryRow(overrides: Partial<Enquiry> & { id: string }): Row {
  return {
    account_id: 'account-1',
    conversation_id: 'conversation-1',
    created_by_user_id: 'user-1',
    workflow_state: INITIAL_ENQUIRY_STATE,
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
    state_changed_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

const conversation = { id: 'conversation-1', account_id: 'account-1' };

const activate = (db: FakeDb, accountId = 'account-1', conversationId = 'conversation-1') =>
  ensureInitialEnquiryForConversation(db.client, {
    accountId,
    conversationId,
    createdByUserId: 'user-1',
  });

describe('ensureInitialEnquiryForConversation', () => {
  it("creates one new_enquiry for a conversation's first inbound message", async () => {
    const db = makeDb({ conversations: [conversation] });

    const result = await activate(db);

    expect(result.created).toBe(true);
    expect(result.enquiry.workflow_state).toBe('new_enquiry');
    expect(result.enquiry.conversation_id).toBe('conversation-1');
    expect(result.enquiry.account_id).toBe('account-1');
    expect(result.enquiry.created_by_user_id).toBe('user-1');
    expect(db.enquiries).toHaveLength(1);
  });

  it('reuses the same enquiry on the second inbound message', async () => {
    const db = makeDb({ conversations: [conversation] });

    const first = await activate(db);
    const second = await activate(db);

    expect(second.created).toBe(false);
    expect(second.enquiry.id).toBe(first.enquiry.id);
    expect(db.enquiries).toHaveLength(1);
    // A repeat delivery must not even attempt an insert.
    expect(db.insertCount()).toBe(1);
  });

  it('converges on exactly one enquiry for concurrent first deliveries', async () => {
    const db = makeDb({ conversations: [conversation] });

    // Both callers read "no enquiry history" before either insert lands —
    // the exact interleaving two simultaneous Meta deliveries produce.
    const [a, b] = await Promise.all([activate(db), activate(db)]);

    expect(a.enquiry.id).toBe(b.enquiry.id);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    expect(db.enquiries).toHaveLength(1);
  });

  it('does not create a second enquiry after one completed', async () => {
    const db = makeDb({
      conversations: [conversation],
      enquiries: [
        enquiryRow({
          id: 'enquiry-done',
          workflow_state: 'completed',
          created_at: '2026-09-01T00:00:00.000Z',
        }),
      ],
    });

    const result = await activate(db);

    expect(result.created).toBe(false);
    expect(result.enquiry.id).toBe('enquiry-done');
    expect(db.enquiries).toHaveLength(1);
    expect(db.insertCount()).toBe(0);
  });

  it('does not create a second enquiry after one was cancelled', async () => {
    const db = makeDb({
      conversations: [conversation],
      enquiries: [
        enquiryRow({
          id: 'enquiry-cancelled',
          workflow_state: 'cancelled',
          created_at: '2026-09-01T00:00:00.000Z',
        }),
      ],
    });

    const result = await activate(db);

    expect(result.created).toBe(false);
    expect(result.enquiry.id).toBe('enquiry-cancelled');
    expect(db.enquiries).toHaveLength(1);
    expect(db.insertCount()).toBe(0);
  });

  it('does not create a second enquiry for terminal-only history with no active enquiry', async () => {
    const db = makeDb({
      conversations: [conversation],
      enquiries: [
        enquiryRow({
          id: 'enquiry-cancelled',
          workflow_state: 'cancelled',
          created_at: '2026-08-01T00:00:00.000Z',
        }),
        enquiryRow({
          id: 'enquiry-completed',
          workflow_state: 'completed',
          created_at: '2026-09-01T00:00:00.000Z',
        }),
      ],
    });

    const result = await activate(db);

    expect(result.created).toBe(false);
    // The FIRST enquiry, not the newest one: this helper answers "did this
    // thread ever have an enquiry?", not "what is the current one?".
    expect(result.enquiry.id).toBe('enquiry-cancelled');
    expect(db.enquiries).toHaveLength(2);
    expect(db.insertCount()).toBe(0);
  });

  it('keeps a live enquiry authoritative while other work happens on the thread', async () => {
    const db = makeDb({
      conversations: [conversation],
      enquiries: [
        enquiryRow({ id: 'enquiry-done', workflow_state: 'completed' }),
        enquiryRow({
          id: 'enquiry-live',
          workflow_state: 'gathering_information',
        }),
      ],
    });

    const result = await activate(db);

    expect(result.created).toBe(false);
    expect(result.enquiry.id).toBe('enquiry-done');
    expect(db.enquiries).toHaveLength(2);
  });

  it('reports a transient write failure so the caller can retry later', async () => {
    const db = makeDb({ conversations: [conversation] });
    db.failNext('enquiries');

    await expect(activate(db)).rejects.toMatchObject({
      code: 'database_error',
    });
    expect(db.enquiries).toHaveLength(0);

    // Nothing was created, so the rule is still unsatisfied and the next
    // qualifying message activates it. No separate retry bookkeeping.
    const retried = await activate(db);
    expect(retried.created).toBe(true);
    expect(db.enquiries).toHaveLength(1);
  });

  it('refuses a conversation that belongs to another account', async () => {
    const db = makeDb({ conversations: [conversation] });

    await expect(activate(db, 'account-2')).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(db.enquiries).toHaveLength(0);
    expect(db.insertCount()).toBe(0);
  });

  it("never sees another account's enquiry for the same conversation id", async () => {
    const db = makeDb({
      conversations: [
        conversation,
        { id: 'conversation-foreign', account_id: 'account-2' },
      ],
      enquiries: [
        enquiryRow({
          id: 'enquiry-foreign',
          account_id: 'account-2',
          conversation_id: 'conversation-foreign',
        }),
      ],
    });

    // The foreign history exists but is invisible under account-1 scope, so
    // account-1's own thread legitimately starts its first enquiry.
    const result = await activate(db);

    expect(result.created).toBe(true);
    expect(result.enquiry.account_id).toBe('account-1');
    expect(db.enquiries).toHaveLength(2);
  });

  it('applies the account filter to every enquiry read', async () => {
    const db = makeDb({ conversations: [conversation] });

    await activate(db);

    const reads = db.calls.filter(
      (call) => call.table === 'enquiries' && call.operation === 'select'
    );
    expect(reads).toHaveLength(1);
    expect(reads[0].filters).toEqual([
      ['account_id', 'account-1'],
      ['conversation_id', 'conversation-1'],
    ]);
  });
});
