import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  defineReadTool,
  defineWriteTool,
  ToolError,
  type WriteToolExecutionContext,
} from './contract';
import { toolContext } from './test-support';

const db = { from: vi.fn() } as unknown as SupabaseClient;

describe('business tool contract', () => {
  it('passes the account-scoped execution context to a provider-neutral handler', async () => {
    const tool = defineReadTool(
      'probe',
      async (context, input: { id: string }) => ({
        account_id: context.account_id,
        actor: context.actor,
        input,
      })
    );

    const result = await tool.execute(toolContext(db), { id: 'resource-1' });

    expect(tool).toMatchObject({
      name: 'probe',
      access: 'read',
      side_effects: 'none',
    });
    expect(result).toEqual({
      ok: true,
      data: {
        account_id: 'account-1',
        actor: { type: 'user', user_id: 'user-1' },
        input: { id: 'resource-1' },
      },
      correlation_id: 'run-1',
    });
  });

  it('returns machine-readable errors without leaking unknown failures', async () => {
    const expected = defineReadTool('expected', async () => {
      throw new ToolError('forbidden', 'Access denied');
    });
    const unknown = defineReadTool('unknown', async () => {
      throw new Error('database password appeared here');
    });

    await expect(expected.execute(toolContext(db), {})).resolves.toMatchObject({
      ok: false,
      error: { code: 'forbidden', message: 'Access denied', retryable: false },
    });
    await expect(unknown.execute(toolContext(db), {})).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'internal',
        message: 'Tool execution failed',
        retryable: false,
      },
    });
  });

  it('rejects an unscoped execution context', async () => {
    const tool = defineReadTool('probe', async () => 'unreachable');
    const context = { ...toolContext(db), account_id: '' };

    await expect(tool.execute(context, {})).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_input', message: 'account_id is required' },
    });
  });

  it('supports cancellation and emits metadata-only audit events', async () => {
    const controller = new AbortController();
    const audit = vi.fn();
    const tool = defineReadTool('slow_read', async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      return 'done';
    });
    controller.abort();

    const result = await tool.execute(
      { ...toolContext(db), signal: controller.signal, audit },
      { secret: 'must-not-be-audited' }
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'unavailable', retryable: true },
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        tool_name: 'slow_read',
        account_id: 'account-1',
        correlation_id: 'run-1',
        outcome: 'error',
        error_code: 'unavailable',
      })
    );
    expect(JSON.stringify(audit.mock.calls)).not.toContain(
      'must-not-be-audited'
    );
  });

  it('keeps read and write construction structurally distinct', () => {
    const read = defineReadTool('read_probe', async () => ({}));
    const write = defineWriteTool('write_probe', {
      side_effects: ['create_record'],
      handler: async () => ({}),
    });

    expect(read).toMatchObject({ access: 'read', side_effects: 'none' });
    expect(read).not.toHaveProperty('approval_required');
    expect(write).toMatchObject({
      access: 'write',
      side_effects: ['create_record'],
      approval_required: true,
      idempotency: 'required_account_tool_scoped',
      account_scope: 'required',
      actor_identity: 'required',
      audit_required: true,
      timeout: 'caller_controlled',
    });
  });

  it('fails a write closed when explicit approval is absent', async () => {
    const handler = vi.fn(async () => ({}));
    const tool = defineWriteTool('write_probe', {
      side_effects: ['create_record'],
      handler,
    });
    const context = {
      ...toolContext(db),
      idempotency_key: 'action-1',
      audit: vi.fn(),
    } as WriteToolExecutionContext;

    const result = await tool.execute(context, {});

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'forbidden', message: 'Explicit approval is required' },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('binds write approval to account, tool and idempotency key', async () => {
    const handler = vi.fn(async () => ({}));
    const tool = defineWriteTool('write_probe', {
      side_effects: ['create_record'],
      handler,
    });
    const context = writeContext('write_probe', vi.fn());
    context.approval = { ...context.approval!, account_id: 'account-2' };

    const result = await tool.execute(context, {});

    expect(result).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns structured write errors and emits write audit metadata', async () => {
    const audit = vi.fn();
    const tool = defineWriteTool('write_probe', {
      side_effects: ['create_record', 'append_audit_event'],
      handler: async (context) => {
        expect(context.account_id).toBe('account-1');
        throw new ToolError('conflict', 'Already exists');
      },
    });

    const result = await tool.execute(writeContext('write_probe', audit), {
      secret: 'not-audited',
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'conflict', message: 'Already exists', retryable: false },
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        tool_name: 'write_probe',
        access: 'write',
        side_effects: ['create_record', 'append_audit_event'],
        account_id: 'account-1',
        actor: { type: 'user', user_id: 'user-1' },
        correlation_id: 'run-1',
        approval_id: 'approval-1',
        idempotency_key: 'action-1',
        outcome: 'error',
        error_code: 'conflict',
      })
    );
    expect(JSON.stringify(audit.mock.calls)).not.toContain('not-audited');
  });
});

function writeContext(
  toolName: string,
  audit: WriteToolExecutionContext['audit']
): WriteToolExecutionContext {
  return {
    ...toolContext(db),
    idempotency_key: 'action-1',
    approval: {
      decision: 'approved',
      approval_id: 'approval-1',
      account_id: 'account-1',
      tool_name: toolName,
      idempotency_key: 'action-1',
      approved_by_user_id: 'approver-1',
      approved_at: '2026-10-01T10:00:00.000Z',
      resource: { type: 'record', id: 'resource-1' },
    },
    audit,
  };
}
