/**
 * The trusted tool-context adapter.
 *
 * The value of this module is that a caller cannot widen a tool's scope: the
 * account and the actor come from an authorization result, the audit sink is
 * attached by the adapter, and anything a request body or a model argument
 * might try to pass is simply not part of the options type — and is dropped
 * at runtime even when it is.
 */

import { readFileSync } from 'node:fs';

import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import type { ApiKeyContext } from '@/lib/auth/api-context';
import type { AccountContext } from '@/lib/auth/account';

import { AI_TOOL_AUDIT_TABLE } from './audit';
import {
  ToolContextError,
  createToolExecutionContext,
  createWriteToolExecutionContext,
} from './context';
import { fakeToolDatabase } from './test-support';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const OTHER_ACCOUNT = '22222222-2222-4222-8222-222222222222';
const NOT_A_UUID = 'not-a-uuid';
const USER = '33333333-3333-4333-8333-333333333333';
const APPROVER = '44444444-4444-4444-8444-444444444444';
const KEY = '55555555-5555-4555-8555-555555555555';

const CONTEXT_KEYS = [
  'db',
  'account_id',
  'actor',
  'correlation_id',
  'signal',
  'audit',
  'audit_metadata',
];

function accountContext(db: SupabaseClient): AccountContext {
  return {
    supabase: db,
    userId: USER,
    accountId: ACCOUNT,
    role: 'admin',
    account: { id: ACCOUNT, name: 'Acme Waste' },
  };
}

function apiKeyContext(db: SupabaseClient): ApiKeyContext {
  return {
    authType: 'api_key',
    supabase: db,
    accountId: ACCOUNT,
    keyId: KEY,
    scopes: ['messages:send'],
    createdBy: USER,
  };
}

function approval(accountId = ACCOUNT) {
  return {
    decision: 'approved' as const,
    approval_id: 'approval-1',
    account_id: accountId,
    tool_name: 'create_repeat_enquiry',
    idempotency_key: 'repeat-action-1',
    approved_by_user_id: APPROVER,
    approved_at: '2026-10-01T10:00:00.000Z',
    resource: { type: 'conversation', id: 'conversation-1' },
  };
}

describe('trusted tool execution context', () => {
  it('derives account, actor, client, and correlation id from authorized state', () => {
    const { db } = fakeToolDatabase();

    const context = createToolExecutionContext({
      kind: 'session',
      context: accountContext(db),
    });

    expect(context.db).toBe(db);
    expect(context.account_id).toBe(ACCOUNT);
    expect(context.actor).toEqual({ type: 'user', user_id: USER });
    expect(context.correlation_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(typeof context.audit).toBe('function');
  });

  it('exposes only what a tool needs, and nothing else', () => {
    const { db } = fakeToolDatabase();
    const controller = new AbortController();

    const context = createToolExecutionContext(
      { kind: 'session', context: accountContext(db) },
      {
        correlation_id: 'run-42',
        signal: controller.signal,
        audit_metadata: { requested_message_limit: 20 },
        // Untrusted extras a route might splat from a request body.
        account_id: OTHER_ACCOUNT,
        role: 'owner',
        actor: { type: 'system' },
        db: null,
        service_role_key: 'never-read',
      } as never
    );

    expect(Object.keys(context).sort()).toEqual([...CONTEXT_KEYS].sort());
    expect(context.account_id).toBe(ACCOUNT);
    expect(context.actor).toEqual({ type: 'user', user_id: USER });
    expect(context.db).toBe(db);
    expect(context.signal).toBe(controller.signal);
    expect(context.correlation_id).toBe('run-42');
    expect(Object.isFrozen(context)).toBe(true);
    expect(JSON.stringify(context)).not.toContain('never-read');
  });

  it('preserves an existing correlation id and refuses an unsafe one', () => {
    const { db } = fakeToolDatabase();
    const options = { kind: 'session', context: accountContext(db) } as const;

    expect(
      createToolExecutionContext(options, { correlation_id: 'run.42-a' })
        .correlation_id
    ).toBe('run.42-a');

    expect(() =>
      createToolExecutionContext(options, {
        correlation_id: 'run 42\nrm -rf /',
      })
    ).toThrow(ToolContextError);
  });

  it('maps an API-key caller to an api_key actor', () => {
    const { db } = fakeToolDatabase();

    const context = createToolExecutionContext({
      kind: 'api_key',
      context: apiKeyContext(db),
    });

    expect(context.account_id).toBe(ACCOUNT);
    expect(context.actor).toEqual({
      type: 'api_key',
      key_id: KEY,
      user_id: USER,
    });
  });

  it('accepts a trusted system caller with an account it already fixed', () => {
    const { db } = fakeToolDatabase();

    const context = createToolExecutionContext({
      kind: 'system',
      account_id: ACCOUNT,
      db,
      user_id: null,
    });

    expect(context.db).toBe(db);
    expect(context.account_id).toBe(ACCOUNT);
    expect(context.actor).toEqual({ type: 'system', user_id: null });
  });

  it('refuses authorization state that is not a real account or identity', () => {
    const { db } = fakeToolDatabase();

    expect(() =>
      createToolExecutionContext({
        kind: 'session',
        context: { ...accountContext(db), accountId: NOT_A_UUID },
      })
    ).toThrow(/accountId/);
    expect(() =>
      createToolExecutionContext({
        kind: 'session',
        context: { ...accountContext(db), userId: '' },
      })
    ).toThrow(/userId/);
    expect(() =>
      createToolExecutionContext({
        kind: 'session',
        context: { ...accountContext(db), supabase: undefined as never },
      })
    ).toThrow(/session client/);
    expect(() =>
      createToolExecutionContext({
        kind: 'system',
        account_id: NOT_A_UUID,
        db,
      })
    ).toThrow(/account_id/);
    expect(() =>
      createToolExecutionContext({ kind: 'other' } as never)
    ).toThrow(ToolContextError);
  });

  it('rejects a signal that is not an AbortSignal', () => {
    const { db } = fakeToolDatabase();

    expect(() =>
      createToolExecutionContext(
        { kind: 'session', context: accountContext(db) },
        { signal: { aborted: true } as never }
      )
    ).toThrow(/AbortSignal/);
  });

  it('attaches the durable audit sink writing through the caller client', async () => {
    const fake = fakeToolDatabase();

    const context = createToolExecutionContext({
      kind: 'session',
      context: accountContext(fake.db),
    });
    await context.audit?.({
      tool_name: 'get_customer',
      access: 'read',
      side_effects: 'none',
      account_id: ACCOUNT,
      actor: { type: 'user', user_id: USER },
      correlation_id: 'run-42',
      started_at: '2026-10-01T12:00:00.000Z',
      finished_at: '2026-10-01T12:00:00.010Z',
      outcome: 'success',
      error_code: null,
      retryable: false,
      approval_id: null,
      idempotency_key: null,
    });

    expect(fake.rows(AI_TOOL_AUDIT_TABLE)).toHaveLength(1);
  });

  it('writes the audit trail through an explicit trusted client when given one', async () => {
    const toolDb = fakeToolDatabase();
    const auditDb = fakeToolDatabase();

    const context = createToolExecutionContext(
      { kind: 'session', context: accountContext(toolDb.db) },
      { audit_db: auditDb.db }
    );
    await context.audit?.({
      tool_name: 'get_customer',
      access: 'read',
      side_effects: 'none',
      account_id: ACCOUNT,
      actor: { type: 'user', user_id: USER },
      correlation_id: 'run-42',
      started_at: '2026-10-01T12:00:00.000Z',
      finished_at: '2026-10-01T12:00:00.010Z',
      outcome: 'success',
      error_code: null,
      retryable: false,
      approval_id: null,
      idempotency_key: null,
    });

    expect(auditDb.rows(AI_TOOL_AUDIT_TABLE)).toHaveLength(1);
    expect(toolDb.rows(AI_TOOL_AUDIT_TABLE)).toEqual([]);
  });
});

describe('trusted write tool execution context', () => {
  const authorization = {
    kind: 'session' as const,
    context: accountContext(fakeToolDatabase().db),
  };

  it('carries the approved action identity alongside the read identity', () => {
    const context = createWriteToolExecutionContext(authorization, {
      correlation_id: 'run-42',
      idempotency_key: 'repeat-action-1',
      approval: approval(),
    });

    expect(context).toMatchObject({
      account_id: ACCOUNT,
      actor: { type: 'user', user_id: USER },
      correlation_id: 'run-42',
      idempotency_key: 'repeat-action-1',
    });
    expect(context.approval.account_id).toBe(ACCOUNT);
    expect(Object.isFrozen(context)).toBe(true);
  });

  it('refuses an approval that belongs to another account', () => {
    expect(() =>
      createWriteToolExecutionContext(authorization, {
        idempotency_key: 'repeat-action-1',
        approval: approval(OTHER_ACCOUNT),
      })
    ).toThrow(/authorized account/);
  });

  it('requires an approval and a bounded idempotency key', () => {
    expect(() =>
      createWriteToolExecutionContext(authorization, {
        idempotency_key: 'repeat-action-1',
      } as never)
    ).toThrow(/approval/i);
    expect(() =>
      createWriteToolExecutionContext(authorization, {
        idempotency_key: 'k'.repeat(201),
        approval: approval(),
      })
    ).toThrow(/idempotency_key/);
    expect(() =>
      createWriteToolExecutionContext(authorization, {
        idempotency_key: 'repeat-action-1',
        approval: {
          ...approval(),
          approved_by_user_id: 'not-a-uuid',
        },
      })
    ).toThrow(/approved_by_user_id/);
  });
});

describe('adapter trust boundary', () => {
  it('never constructs a Supabase client of its own', () => {
    for (const file of ['./context.ts', './audit.ts']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map(
        (match) => match[1] as string
      );

      // No admin-client/service-role helper is reachable from here, and no
      // credential-bearing environment variable is even named.
      for (const specifier of imports) {
        expect(specifier).not.toMatch(/admin-client|supabaseAdmin/);
        // Type-only imports of the authorization results are erased at
        // compile time; a runtime import of them would drag
        // `next/headers` into the tool layer.
        const isTypeOnly = new RegExp(
          `import\\s+type\\b[^;]*from\\s+'${specifier.replace(
            /[.*+?^${}()|[\]\\]/g,
            '\\$&'
          )}'`
        ).test(source);
        if (specifier.startsWith('@/lib/auth/')) {
          expect(isTypeOnly).toBe(true);
        }
      }

      expect(source).not.toMatch(/SERVICE_ROLE/);
      expect(source).not.toMatch(/\b(createClient|createServerClient)\s*\(/);
    }
  });

  it('keeps the tool layer free of any model-provider dependency', () => {
    const files = [
      './contract.ts',
      './audit.ts',
      './context.ts',
      './index.ts',
      './shared.ts',
      './get-customer.ts',
      './get-conversation.ts',
      './create-repeat-enquiry.ts',
    ];
    for (const file of files) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(source).not.toMatch(
        /@\/lib\/ai\/(providers|config|generate|orchestrator)|openai|anthropic|generative-ai/i
      );
    }
  });
});
