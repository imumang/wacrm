/**
 * Durable, metadata-only AI tool-call audit.
 *
 * These tests exercise persistence, not just shape: every "writes one row"
 * assertion reads back the rows the sink actually inserted into the fake
 * database, so a sink that stopped persisting (or started persisting
 * payloads) fails here rather than in production.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AccountContext } from '@/lib/auth/account';
import type { Enquiry } from '@/lib/enquiries/model';

import {
  AI_TOOL_AUDIT_TABLE,
  createDurableToolAuditSink,
  sanitizeExecutionMetadata,
  toToolAuditRow,
} from './audit';
import { createRepeatEnquiryTool } from './create-repeat-enquiry';
import {
  createToolExecutionContext,
  createWriteToolExecutionContext,
} from './context';
import { getCustomerTool } from './get-customer';
import { fakeToolDatabase, type FakeToolDatabase } from './test-support';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const OTHER_ACCOUNT = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const APPROVER = '44444444-4444-4444-8444-444444444444';
const KEY = '55555555-5555-4555-8555-555555555555';

const CONTACT = {
  id: 'contact-1',
  account_id: ACCOUNT,
  name: 'Ada Lovelace',
  phone: '+447700900123',
  wa_user_id: 'US.13491208655302741918',
  wa_parent_user_id: null,
  wa_username: 'ada',
  updated_at: '2026-10-01T08:00:00.000Z',
};

const CONVERSATION = {
  id: 'conversation-1',
  account_id: ACCOUNT,
  contact_id: 'contact-1',
  created_at: '2026-09-01T08:00:00.000Z',
};

const SECRET_DETAILS = {
  address: '1 Example Road',
  postcode: 'SW1A 1AA',
  note: 'Ring the bell twice before arriving',
};

function seed(): FakeToolDatabase {
  return fakeToolDatabase({
    contacts: [CONTACT],
    conversations: [CONVERSATION],
    contact_notes: [
      {
        id: 'note-1',
        account_id: ACCOUNT,
        contact_id: 'contact-1',
        note_text: SECRET_DETAILS.note,
        created_at: '2026-09-30T10:00:00.000Z',
      },
    ],
    contact_tags: [],
    tags: [],
    enquiries: [
      enquiry({
        workflow_state: 'gathering_information',
        address: SECRET_DETAILS.address,
        postcode: SECRET_DETAILS.postcode,
      }),
    ],
    messages: [
      {
        id: 'message-1',
        conversation_id: 'conversation-1',
        sender_type: 'customer',
        content_type: 'text',
        content_text: 'Please quote for a full house clearance',
        media_url: 'https://example.invalid/media/secret-image.jpg',
        media_type: 'image/jpeg',
        status: 'delivered',
        created_at: '2026-10-01T09:00:00.000Z',
        ai_generated: false,
      },
    ],
  });
}

function enquiry(overrides: Partial<Enquiry> = {}): Enquiry {
  return {
    id: 'enquiry-1',
    account_id: ACCOUNT,
    conversation_id: 'conversation-1',
    created_by_user_id: USER,
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
    photos_received: false,
    preferred_date: null,
    preferred_time_window: null,
    missing_information: [],
    state_changed_at: '2026-10-01T09:00:00.000Z',
    created_at: '2026-10-01T09:00:00.000Z',
    updated_at: '2026-10-01T09:00:00.000Z',
    ...overrides,
  };
}

function sessionAuthorization(db: SupabaseClient): AccountContext {
  return {
    supabase: db,
    userId: USER,
    accountId: ACCOUNT,
    role: 'admin',
    account: { id: ACCOUNT, name: 'Acme Waste' },
  };
}

function readAuditRows(fake: FakeToolDatabase): Record<string, unknown>[] {
  return fake.rows(AI_TOOL_AUDIT_TABLE);
}

/** A client whose insert fails the way an RLS or outage failure does. */
function failingAuditClient(): SupabaseClient {
  return {
    from: () => ({
      insert: () =>
        Promise.resolve({
          data: null,
          error: {
            code: '42501',
            message: 'new row violates row-level security policy',
            details: 'internal schema detail that must never surface',
          },
        }),
    }),
  } as unknown as SupabaseClient;
}

function consoleErrorSpy() {
  return vi.spyOn(console, 'error').mockImplementation(() => {});
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('durable AI tool-call audit', () => {
  it('writes exactly one metadata-only row for a successful read', async () => {
    const fake = seed();
    const context = createToolExecutionContext(
      { kind: 'session', context: sessionAuthorization(fake.db) },
      { correlation_id: 'run-42' }
    );

    const result = await getCustomerTool.execute(context, {
      contact_id: CONTACT.id,
    });

    expect(result.ok).toBe(true);
    const rows = readAuditRows(fake);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      account_id: ACCOUNT,
      tool_name: 'get_customer',
      access: 'read',
      side_effects: [],
      actor_type: 'user',
      actor_user_id: USER,
      actor_key_id: null,
      correlation_id: 'run-42',
      outcome: 'success',
      error_code: null,
      retryable: false,
      approval_id: null,
      idempotency_key: null,
      execution_metadata: null,
    });
    expect(Number.isInteger(rows[0]?.duration_ms)).toBe(true);
    expect(rows[0]?.duration_ms as number).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(Date.parse(String(rows[0]?.started_at)))).toBe(true);
    expect(Number.isFinite(Date.parse(String(rows[0]?.finished_at)))).toBe(
      true
    );
  });

  it('audits a not_found failure with the machine-readable code only', async () => {
    const fake = seed();
    const context = createToolExecutionContext({
      kind: 'session',
      context: sessionAuthorization(fake.db),
    });

    const result = await getCustomerTool.execute(context, {
      contact_id: 'contact-does-not-exist',
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(readAuditRows(fake)).toEqual([
      expect.objectContaining({
        account_id: ACCOUNT,
        tool_name: 'get_customer',
        outcome: 'error',
        error_code: 'not_found',
        retryable: false,
      }),
    ]);
  });

  it('keeps a cross-account request indistinguishable and scoped to the caller', async () => {
    const fake = fakeToolDatabase({
      contacts: [{ ...CONTACT, account_id: OTHER_ACCOUNT }],
      conversations: [{ ...CONVERSATION, account_id: OTHER_ACCOUNT }],
      contact_notes: [],
      contact_tags: [],
      tags: [],
      enquiries: [],
      messages: [],
    });
    const context = createToolExecutionContext({
      kind: 'session',
      context: sessionAuthorization(fake.db),
    });

    const foreign = await getCustomerTool.execute(context, {
      contact_id: CONTACT.id,
    });
    const unknown = await getCustomerTool.execute(context, {
      contact_id: 'contact-does-not-exist',
    });

    expect(foreign).toEqual(unknown);
    expect(foreign).toMatchObject({
      ok: false,
      error: { code: 'not_found', message: 'Customer not found' },
    });

    const rows = readAuditRows(fake);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.account_id).toBe(ACCOUNT);
      expect(JSON.stringify(row)).not.toContain(OTHER_ACCOUNT);
    }
  });

  it('never persists tool input, tool output, or customer content', async () => {
    const fake = seed();
    const context = createToolExecutionContext(
      { kind: 'session', context: sessionAuthorization(fake.db) },
      {
        correlation_id: 'run-42',
        audit_metadata: {
          requested_message_limit: 20,
          truncated: false,
          customer_name: CONTACT.name,
          note_text: SECRET_DETAILS.note,
          recent_message_limit: 50,
        } as never,
      }
    );

    await getCustomerTool.execute(context, {
      contact_id: CONTACT.id,
    });

    const row = readAuditRows(fake)[0];
    const serialized = JSON.stringify(row);
    for (const forbidden of [
      CONTACT.id,
      CONVERSATION.id,
      CONTACT.name,
      CONTACT.phone,
      CONTACT.wa_user_id,
      SECRET_DETAILS.address,
      SECRET_DETAILS.postcode,
      SECRET_DETAILS.note,
      'house clearance',
      'secret-image.jpg',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(Object.keys(row ?? {}).sort()).toEqual(
      [
        'account_id',
        'tool_name',
        'access',
        'side_effects',
        'actor_type',
        'actor_user_id',
        'actor_key_id',
        'correlation_id',
        'started_at',
        'finished_at',
        'duration_ms',
        'outcome',
        'error_code',
        'retryable',
        'approval_id',
        'idempotency_key',
        'execution_metadata',
      ].sort()
    );
    // Only allowlisted, numeric/boolean metadata survives.
    expect(row?.execution_metadata).toEqual({
      requested_message_limit: 20,
      truncated: false,
    });
  });

  it('ignores an account_id supplied alongside tool input', async () => {
    const fake = seed();
    const context = createToolExecutionContext({
      kind: 'session',
      context: sessionAuthorization(fake.db),
    });

    const result = await getCustomerTool.execute(context, {
      contact_id: CONTACT.id,
      account_id: OTHER_ACCOUNT,
    } as never);

    expect(result.ok).toBe(true);
    expect(readAuditRows(fake)[0]).toMatchObject({ account_id: ACCOUNT });
  });

  it('records the API-key actor and preserves the supplied correlation id', async () => {
    const fake = seed();
    const context = createToolExecutionContext(
      {
        kind: 'api_key',
        context: {
          authType: 'api_key',
          supabase: fake.db,
          accountId: ACCOUNT,
          keyId: KEY,
          scopes: ['messages:send'],
          createdBy: null,
        },
      },
      { correlation_id: 'run.api_key-1' }
    );

    await getCustomerTool.execute(context, { contact_id: CONTACT.id });

    expect(readAuditRows(fake)[0]).toMatchObject({
      actor_type: 'api_key',
      actor_key_id: KEY,
      actor_user_id: null,
      correlation_id: 'run.api_key-1',
    });
  });

  it('leaves cancellation semantics unchanged and still audits the attempt', async () => {
    const fake = seed();
    const controller = new AbortController();
    controller.abort();
    const context = createToolExecutionContext(
      { kind: 'session', context: sessionAuthorization(fake.db) },
      { signal: controller.signal, correlation_id: 'run-42' }
    );

    const result = await getCustomerTool.execute(context, {
      contact_id: CONTACT.id,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'unavailable', retryable: true },
      correlation_id: 'run-42',
    });
    expect(readAuditRows(fake)).toEqual([
      expect.objectContaining({
        outcome: 'error',
        error_code: 'unavailable',
        retryable: true,
      }),
    ]);
  });

  it('audits an approved write with its approval and idempotency identity', async () => {
    const fake = fakeToolDatabase({
      conversations: [CONVERSATION],
      enquiries: [enquiry({ workflow_state: 'completed' })],
    });
    const context = createWriteToolExecutionContext(
      { kind: 'session', context: sessionAuthorization(fake.db) },
      {
        correlation_id: 'run-42',
        idempotency_key: 'repeat-action-1',
        approval: {
          decision: 'approved',
          approval_id: 'approval-1',
          account_id: ACCOUNT,
          tool_name: 'create_repeat_enquiry',
          idempotency_key: 'repeat-action-1',
          approved_by_user_id: APPROVER,
          approved_at: '2026-10-01T10:00:00.000Z',
          resource: { type: 'conversation', id: CONVERSATION.id },
        },
      }
    );

    const result = await createRepeatEnquiryTool.execute(context, {
      conversation_id: CONVERSATION.id,
    });

    expect(result.ok).toBe(true);
    expect(readAuditRows(fake)).toEqual([
      expect.objectContaining({
        account_id: ACCOUNT,
        tool_name: 'create_repeat_enquiry',
        access: 'write',
        side_effects: ['create_enquiry', 'append_enquiry_state_event'],
        actor_type: 'user',
        actor_user_id: USER,
        approval_id: 'approval-1',
        idempotency_key: 'repeat-action-1',
        correlation_id: 'run-42',
        outcome: 'success',
        error_code: null,
      }),
    ]);
  });

  describe('audit failure policy', () => {
    it('keeps a read successful and reports the failed audit write', async () => {
      const fake = seed();
      const logged = consoleErrorSpy();
      const context = createToolExecutionContext(
        { kind: 'session', context: sessionAuthorization(fake.db) },
        { correlation_id: 'run-42', audit_db: failingAuditClient() }
      );

      const result = await getCustomerTool.execute(context, {
        contact_id: CONTACT.id,
      });

      expect(result.ok).toBe(true);
      expect(logged).toHaveBeenCalledWith(
        '[ai-tool-audit] read audit record was not written',
        expect.objectContaining({
          account_id: ACCOUNT,
          tool_name: 'get_customer',
          correlation_id: 'run-42',
          outcome: 'success',
        })
      );
      expect(JSON.stringify(logged.mock.calls)).not.toContain(
        'row-level security policy'
      );
    });

    it('fails an approved write closed when the audit row cannot be written', async () => {
      const fake = fakeToolDatabase({
        conversations: [CONVERSATION],
        enquiries: [enquiry({ workflow_state: 'completed' })],
      });
      consoleErrorSpy();
      const context = createWriteToolExecutionContext(
        { kind: 'session', context: sessionAuthorization(fake.db) },
        {
          correlation_id: 'run-42',
          idempotency_key: 'repeat-action-1',
          audit_db: failingAuditClient(),
          approval: {
            decision: 'approved',
            approval_id: 'approval-1',
            account_id: ACCOUNT,
            tool_name: 'create_repeat_enquiry',
            idempotency_key: 'repeat-action-1',
            approved_by_user_id: APPROVER,
            approved_at: '2026-10-01T10:00:00.000Z',
            resource: { type: 'conversation', id: CONVERSATION.id },
          },
        }
      );

      const result = await createRepeatEnquiryTool.execute(context, {
        conversation_id: CONVERSATION.id,
      });

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'unavailable',
          message: 'Write audit recording failed',
          retryable: true,
        },
      });
      expect(readAuditRows(fake)).toEqual([]);
    });

    it('reports a sink failure as a retryable unavailable, not a raw error', async () => {
      const sink = createDurableToolAuditSink(failingAuditClient());

      await expect(
        sink({
          tool_name: 'get_customer',
          access: 'read',
          side_effects: 'none',
          account_id: ACCOUNT,
          actor: { type: 'user', user_id: USER },
          correlation_id: 'run-42',
          started_at: '2026-10-01T12:00:00.000Z',
          finished_at: '2026-10-01T12:00:00.250Z',
          outcome: 'error',
          error_code: 'unavailable',
          retryable: true,
          approval_id: null,
          idempotency_key: null,
        })
      ).rejects.toMatchObject({
        code: 'unavailable',
        retryable: true,
        message: 'Tool audit record could not be written',
      });
    });
  });
});

describe('audit row shaping', () => {
  it('computes a bounded duration from the two timestamps', () => {
    const row = toToolAuditRow({
      tool_name: 'get_conversation',
      access: 'read',
      side_effects: 'none',
      account_id: ACCOUNT,
      actor: { type: 'system', user_id: null },
      correlation_id: 'run-42',
      started_at: '2026-10-01T12:00:00.000Z',
      finished_at: '2026-10-01T12:00:00.250Z',
      outcome: 'success',
      error_code: null,
      retryable: false,
      approval_id: null,
      idempotency_key: null,
    });

    expect(row).toMatchObject({
      access: 'read',
      actor_type: 'system',
      actor_user_id: null,
      actor_key_id: null,
      duration_ms: 250,
      outcome: 'success',
      error_code: null,
      retryable: false,
      execution_metadata: null,
    });
  });

  it('refuses an identity or correlation id that is not durable-safe', () => {
    const event = {
      tool_name: 'get_customer',
      access: 'read' as const,
      side_effects: 'none' as const,
      account_id: 'account-1',
      actor: { type: 'user' as const, user_id: USER },
      correlation_id: 'run-42',
      started_at: '2026-10-01T12:00:00.000Z',
      finished_at: '2026-10-01T12:00:00.100Z',
      outcome: 'success' as const,
      error_code: null,
      retryable: false,
      approval_id: null,
      idempotency_key: null,
    };

    expect(() => toToolAuditRow(event)).toThrow(/account_id/);
    expect(() =>
      toToolAuditRow({
        ...event,
        account_id: ACCOUNT,
        actor: { type: 'user', user_id: 'user-1' },
      })
    ).toThrow(/user_id/);
    expect(() =>
      toToolAuditRow({
        ...event,
        account_id: ACCOUNT,
        correlation_id: 'x'.repeat(201),
      })
    ).toThrow(/correlation_id/);
  });

  it('collapses an unrecognised error code and clears retryable on success', () => {
    const row = toToolAuditRow({
      tool_name: 'get_customer',
      access: 'read',
      side_effects: 'none',
      account_id: ACCOUNT,
      actor: { type: 'user', user_id: USER },
      correlation_id: 'run-42',
      started_at: '2026-10-01T12:00:00.000Z',
      finished_at: '2026-10-01T12:00:00.100Z',
      outcome: 'success',
      error_code: 'database_exploded' as never,
      retryable: true,
      approval_id: null,
      idempotency_key: null,
    });

    expect(row.error_code).toBeNull();
    expect(row.retryable).toBe(false);
  });

  it('drops unknown, textual, and nested execution metadata', () => {
    expect(
      sanitizeExecutionMetadata({
        requested_message_limit: 20,
        truncated: true,
        customer_name: 'Ada Lovelace',
        conversation_id: CONVERSATION.id,
        nested: { secret: true },
        list: [1, 2],
      } as never)
    ).toEqual({ requested_message_limit: 20, truncated: true });

    expect(sanitizeExecutionMetadata({ secret: 'value' } as never)).toBeNull();
    expect(sanitizeExecutionMetadata(undefined)).toBeNull();
  });
});
