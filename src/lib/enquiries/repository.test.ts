import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import type { Enquiry } from './model';
import {
  createEnquiry,
  getConversationEnquiry,
  getEnquiry,
  transitionEnquiry,
  updateEnquiryFacts,
} from './repository';

interface ConversationRow {
  id: string;
  account_id: string;
}

interface FakeDatabase {
  client: SupabaseClient;
  conversations: ConversationRow[];
  enquiries: Enquiry[];
  calls: Array<{
    table: string;
    operation: string;
    filters: Array<[string, unknown]>;
  }>;
}

function makeDb(seed?: {
  conversations?: ConversationRow[];
  enquiries?: Enquiry[];
}): FakeDatabase {
  const conversations = [...(seed?.conversations ?? [])];
  const enquiries = [...(seed?.enquiries ?? [])];
  const calls: FakeDatabase['calls'] = [];
  let nextId = enquiries.length + 1;

  const client = {
    from(table: string) {
      const call = {
        table,
        operation: 'select',
        filters: [] as Array<[string, unknown]>,
      };
      calls.push(call);
      let payload: Record<string, unknown> = {};
      let limit: number | null = null;

      const matchingRows = (): Array<Record<string, unknown>> => {
        const source = table === 'conversations' ? conversations : enquiries;
        const filtered = source.filter((row) =>
          call.filters.every(
            ([column, value]) =>
              (row as unknown as Record<string, unknown>)[column] === value
          )
        );
        return (limit === null
          ? filtered
          : filtered.slice(0, limit)) as unknown as Array<
          Record<string, unknown>
        >;
      };

      const execute = () => {
        if (call.operation === 'insert' && table === 'enquiries') {
          const now = '2026-10-01T12:00:00.000Z';
          const row = {
            id: `enquiry-${nextId++}`,
            account_id: payload.account_id,
            conversation_id: payload.conversation_id,
            created_by_user_id: payload.created_by_user_id,
            workflow_state: payload.workflow_state ?? 'new_enquiry',
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
          } as unknown as Enquiry;
          enquiries.push(row);
          return { data: row, error: null };
        }

        if (call.operation === 'update' && table === 'enquiries') {
          const rows = matchingRows() as unknown as Enquiry[];
          for (const row of rows) Object.assign(row, payload);
          return { data: rows[0] ?? null, error: null };
        }

        return { data: matchingRows()[0] ?? null, error: null };
      };

      const builder = {
        select() {
          return builder;
        },
        insert(value: Record<string, unknown>) {
          call.operation = 'insert';
          payload = value;
          return builder;
        },
        update(value: Record<string, unknown>) {
          call.operation = 'update';
          payload = value;
          return builder;
        },
        eq(column: string, value: unknown) {
          call.filters.push([column, value]);
          return builder;
        },
        order() {
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

  return { client, conversations, enquiries, calls };
}

const conversation = { id: 'conversation-1', account_id: 'account-1' };

describe('enquiry persistence', () => {
  it('creates and retrieves a partial enquiry with its initial state', async () => {
    const db = makeDb({ conversations: [conversation] });

    const created = await createEnquiry(db.client, {
      accountId: 'account-1',
      conversationId: 'conversation-1',
      createdByUserId: 'user-1',
      facts: {
        customer_intent: 'House clearance',
        item_descriptions: ['Sofa'],
        missing_information: ['postcode', 'photos_received'],
      },
    });
    const loaded = await getConversationEnquiry(
      db.client,
      'account-1',
      'conversation-1'
    );

    expect(created.workflow_state).toBe('new_enquiry');
    expect(loaded).toEqual(created);
    expect(loaded).toMatchObject({
      customer_intent: 'House clearance',
      postcode: null,
      item_descriptions: ['Sofa'],
      missing_information: ['postcode', 'photos_received'],
    });
  });

  it('persists fact patches without fabricating unknown values', async () => {
    const db = makeDb({ conversations: [conversation] });
    const created = await createEnquiry(db.client, {
      accountId: 'account-1',
      conversationId: 'conversation-1',
      createdByUserId: 'user-1',
    });

    const updated = await updateEnquiryFacts(db.client, {
      accountId: 'account-1',
      enquiryId: created.id,
      facts: {
        postcode: 'SW1A 1AA',
        lift_available: null,
        missing_information: ['lift_availability'],
      },
    });

    expect(updated.postcode).toBe('SW1A 1AA');
    expect(updated.lift_available).toBeNull();
    expect(updated.address).toBeNull();
    expect(updated.missing_information).toEqual(['lift_availability']);
  });

  it('persists a valid transition with compare-and-set scoping', async () => {
    const db = makeDb({ conversations: [conversation] });
    const created = await createEnquiry(db.client, {
      accountId: 'account-1',
      conversationId: 'conversation-1',
      createdByUserId: 'user-1',
    });

    const transitioned = await transitionEnquiry(db.client, {
      accountId: 'account-1',
      enquiryId: created.id,
      to: 'gathering_information',
    });

    expect(transitioned.workflow_state).toBe('gathering_information');
    const updateCall = db.calls.find((call) => call.operation === 'update');
    expect(updateCall?.filters).toEqual([
      ['id', created.id],
      ['account_id', 'account-1'],
      ['workflow_state', 'new_enquiry'],
    ]);
  });

  it('account-scopes reads and refuses a foreign conversation', async () => {
    const db = makeDb({ conversations: [conversation] });
    const created = await createEnquiry(db.client, {
      accountId: 'account-1',
      conversationId: 'conversation-1',
      createdByUserId: 'user-1',
    });

    await expect(
      getEnquiry(db.client, 'account-2', created.id)
    ).resolves.toBeNull();
    await expect(
      createEnquiry(db.client, {
        accountId: 'account-2',
        conversationId: 'conversation-1',
        createdByUserId: 'user-2',
      })
    ).rejects.toMatchObject({ code: 'not_found' });

    const enquiryRead = db.calls.find(
      (call) =>
        call.table === 'enquiries' &&
        call.filters.some(
          ([column, value]) => column === 'account_id' && value === 'account-2'
        )
    );
    expect(enquiryRead).toBeDefined();
  });

  it('keeps an existing conversation compatible when no enquiry exists', async () => {
    const db = makeDb({ conversations: [conversation] });

    await expect(
      getConversationEnquiry(db.client, 'account-1', 'conversation-1')
    ).resolves.toBeNull();
    expect(db.conversations).toEqual([conversation]);

    await expect(
      createEnquiry(db.client, {
        accountId: 'account-1',
        conversationId: 'conversation-1',
        createdByUserId: 'user-1',
      })
    ).resolves.toMatchObject({
      conversation_id: 'conversation-1',
      workflow_state: 'new_enquiry',
    });
  });
});
