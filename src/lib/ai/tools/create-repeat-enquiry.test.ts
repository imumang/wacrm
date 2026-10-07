import { describe, expect, it, vi } from 'vitest';

import type { Enquiry } from '@/lib/enquiries/model';

import { type WriteToolExecutionContext } from './contract';
import { createRepeatEnquiryTool } from './create-repeat-enquiry';
import { enquiryRow, fakeToolDatabase, toolContext } from './test-support';

const CONVERSATION = {
  id: 'conversation-1',
  account_id: 'account-1',
};

function context(
  db: WriteToolExecutionContext['db'],
  overrides: Partial<WriteToolExecutionContext> = {}
): WriteToolExecutionContext {
  return {
    ...toolContext(db),
    idempotency_key: 'repeat-action-1',
    approval: {
      decision: 'approved',
      approval_id: 'approval-1',
      account_id: 'account-1',
      tool_name: 'create_repeat_enquiry',
      idempotency_key: 'repeat-action-1',
      approved_by_user_id: 'approver-1',
      approved_at: '2026-10-01T10:00:00.000Z',
      resource: { type: 'conversation', id: 'conversation-1' },
    },
    audit: vi.fn(),
    ...overrides,
  };
}

function terminalEnquiry(
  workflow_state: 'completed' | 'cancelled',
  overrides: Partial<Enquiry> = {}
): Enquiry {
  return enquiryRow({
    id: `enquiry-${workflow_state}`,
    workflow_state,
    created_at: '2026-09-01T09:00:00.000Z',
    ...overrides,
  });
}

describe('create_repeat_enquiry', () => {
  it.each(['completed', 'cancelled'] as const)(
    'creates a new_enquiry after a %s enquiry',
    async (terminalState) => {
      const fake = fakeToolDatabase({
        conversations: [CONVERSATION],
        enquiries: [terminalEnquiry(terminalState)],
      });

      const result = await createRepeatEnquiryTool.execute(context(fake.db), {
        conversation_id: 'conversation-1',
      });

      expect(result).toMatchObject({
        ok: true,
        data: {
          created: true,
          idempotency_replayed: false,
          enquiry: { workflow_state: 'new_enquiry' },
        },
      });
      expect(fake.rows('enquiries')).toHaveLength(2);
    }
  );

  it('rejects creation while any active enquiry exists', async () => {
    const fake = fakeToolDatabase({
      conversations: [CONVERSATION],
      enquiries: [enquiryRow({ workflow_state: 'gathering_information' })],
    });

    const result = await createRepeatEnquiryTool.execute(context(fake.db), {
      conversation_id: 'conversation-1',
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(fake.rows('enquiries')).toHaveLength(1);
  });

  it('rejects a conversation with zero enquiry history', async () => {
    const fake = fakeToolDatabase({ conversations: [CONVERSATION] });

    const result = await createRepeatEnquiryTool.execute(context(fake.db), {
      conversation_id: 'conversation-1',
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'conflict',
        message: 'A repeat enquiry requires existing enquiry history',
      },
    });
    expect(fake.rows('enquiries')).toEqual([]);
  });

  it('replays the same approved action without creating a duplicate', async () => {
    const fake = fakeToolDatabase({
      conversations: [CONVERSATION],
      enquiries: [terminalEnquiry('completed')],
    });
    const writeContext = context(fake.db);

    const first = await createRepeatEnquiryTool.execute(writeContext, {
      conversation_id: 'conversation-1',
    });
    const retried = await createRepeatEnquiryTool.execute(writeContext, {
      conversation_id: 'conversation-1',
    });

    expect(first).toMatchObject({ ok: true, data: { created: true } });
    expect(retried).toMatchObject({
      ok: true,
      data: { created: false, idempotency_replayed: true },
    });
    expect(fake.rows('enquiries')).toHaveLength(2);
  });

  it('converges concurrent duplicate requests on one new enquiry', async () => {
    const fake = fakeToolDatabase({
      conversations: [CONVERSATION],
      enquiries: [terminalEnquiry('cancelled')],
    });
    const writeContext = context(fake.db);

    const [first, second] = await Promise.all([
      createRepeatEnquiryTool.execute(writeContext, {
        conversation_id: 'conversation-1',
      }),
      createRepeatEnquiryTool.execute(writeContext, {
        conversation_id: 'conversation-1',
      }),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(fake.rows('enquiries')).toHaveLength(2);
    const createdFlags = [first, second].map((result) =>
      result.ok ? result.data.created : null
    );
    expect(createdFlags.sort()).toEqual([false, true]);
  });

  it('does not copy facts, address, quote, or booking state from history', async () => {
    const fake = fakeToolDatabase({
      conversations: [CONVERSATION],
      enquiries: [
        terminalEnquiry('completed', {
          customer_intent: 'Old sofa removal',
          address: '1 Old Road',
          postcode: 'OLD 1AA',
          item_descriptions: ['Sofa'],
          preferred_date: '2026-09-10',
        }),
      ],
    });

    const result = await createRepeatEnquiryTool.execute(context(fake.db), {
      conversation_id: 'conversation-1',
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        enquiry: {
          facts: {
            customer_intent: null,
            address: null,
            postcode: null,
            item_descriptions: null,
            preferred_date: null,
          },
        },
      },
    });
    const created = fake
      .rows('enquiries')
      .find((row) => row.id !== 'enquiry-completed');
    expect(created).not.toHaveProperty('quote_status');
    expect(created).not.toHaveProperty('booking_status');
  });

  it('denies a conversation from another account without creating a row', async () => {
    const fake = fakeToolDatabase({
      conversations: [{ ...CONVERSATION, account_id: 'account-2' }],
      enquiries: [terminalEnquiry('completed', { account_id: 'account-2' })],
    });

    const result = await createRepeatEnquiryTool.execute(context(fake.db), {
      conversation_id: 'conversation-1',
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(fake.rows('enquiries')).toHaveLength(1);
    for (const call of fake.calls.filter(
      (call) => call.table === 'enquiries'
    )) {
      expect(call.filters).toEqual(
        expect.arrayContaining([
          { kind: 'eq', column: 'account_id', value: 'account-1' },
        ])
      );
    }
  });

  it('records approval/idempotency metadata, audit, and the initial state event', async () => {
    const audit = vi.fn();
    const fake = fakeToolDatabase({
      conversations: [CONVERSATION],
      enquiries: [terminalEnquiry('completed')],
    });

    const result = await createRepeatEnquiryTool.execute(
      context(fake.db, { audit }),
      { conversation_id: 'conversation-1' }
    );

    expect(result.ok).toBe(true);
    const created = fake
      .rows('enquiries')
      .find((row) => row.id !== 'enquiry-completed');
    expect(created).toMatchObject({
      repeat_action_idempotency_key: 'repeat-action-1',
      repeat_action_approval_id: 'approval-1',
      repeat_action_correlation_id: 'run-1',
      created_by_user_id: 'user-1',
    });
    expect(fake.rows('enquiry_state_events')).toEqual([
      expect.objectContaining({
        enquiry_id: created?.id,
        from_state: null,
        to_state: 'new_enquiry',
        changed_by_user_id: 'user-1',
      }),
    ]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        access: 'write',
        approval_id: 'approval-1',
        idempotency_key: 'repeat-action-1',
        outcome: 'success',
      })
    );
  });
});
