/**
 * Trusted construction of a `ToolExecutionContext`.
 *
 * Every tool call needs the same five things: an account-scoped database
 * client, the trusted `account_id`, an actor identity, a correlation/run ID,
 * and an optional cancellation signal — plus, now, a durable audit
 * mechanism. Assembling those by hand at each call site is exactly where a
 * tenant boundary gets lost, so this module is the single place that turns
 * an already-authorized application context into a tool context.
 *
 * Trusted inputs are the two existing authorization results:
 *
 *   - `AccountContext` from `getCurrentAccount()` / `requireRole()`
 *     (cookie session → one account, one authenticated user);
 *   - `ApiKeyContext` from `requireApiKey()` (bearer key → one account, one
 *     key row, an RLS-bypassing client the caller already holds).
 *
 * plus an explicit `system` variant for trusted server-side callers that
 * already hold a client for one fixed account.
 *
 * What this adapter deliberately does not do:
 *   - it never accepts an `account_id`, role, or actor from a caller
 *     parameter, so a request body, query string, or model argument cannot
 *     widen the scope;
 *   - it never constructs a Supabase client, so it cannot escalate to a
 *     service-role key the way an admin-client helper would;
 *   - it carries no provider, model, or prompt concept — it is about
 *     authorization and auditability, not about who is calling;
 *   - it returns a frozen object containing only what a tool needs.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { ApiKeyContext } from '@/lib/auth/api-context';
import type { AccountContext } from '@/lib/auth/account';

import { createDurableToolAuditSink } from './audit';
import {
  type ApprovedWriteToolExecutionContext,
  type ToolActor,
  type ToolApproval,
  type ToolAuditMetadata,
  type ToolAuditRecorder,
  type ToolExecutionContext,
} from './contract';

export const TOOL_CONTEXT_MAX_CORRELATION_ID_CHARS = 200;
export const TOOL_CONTEXT_MAX_METADATA_KEYS = 8;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

/** Raised when the trusted context cannot produce a safe tool context. */
export class ToolContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolContextError';
  }
}

/**
 * One trusted caller. The discriminant names which authorization result
 * produced it, so account and actor derivation are explicit per source
 * rather than guessed from a bag of optional fields.
 */
export type TrustedToolAuthorization =
  | { kind: 'session'; context: AccountContext }
  | { kind: 'api_key'; context: ApiKeyContext }
  | {
      kind: 'system';
      account_id: string;
      db: SupabaseClient;
      user_id?: string | null;
    };

export interface ToolExecutionContextOptions {
  /** Reuse an existing run ID; one is generated when omitted. */
  correlation_id?: string;
  /** Caller-controlled cancellation, e.g. `AbortSignal.timeout(5_000)`. */
  signal?: AbortSignal;
  /**
   * Client the durable audit sink writes through. Defaults to the caller's
   * own client, which is the RLS-scoped session client or the trusted client
   * the caller already holds. It is never constructed here.
   */
  audit_db?: SupabaseClient;
  /**
   * Bounded execution metadata (requested limits and similar) for the audit
   * record. Sanitized against an allowlist by the sink; never customer
   * content, never model input.
   */
  audit_metadata?: ToolAuditMetadata;
}

export interface WriteToolExecutionContextOptions extends ToolExecutionContextOptions {
  idempotency_key: string;
  approval: ToolApproval;
}

interface ResolvedAuthorization {
  db: SupabaseClient;
  account_id: string;
  actor: ToolActor;
}

export function createToolExecutionContext(
  authorization: TrustedToolAuthorization,
  options: ToolExecutionContextOptions = {}
): ToolExecutionContext {
  const resolved = resolveAuthorization(authorization);
  return Object.freeze({
    db: resolved.db,
    account_id: resolved.account_id,
    actor: resolved.actor,
    correlation_id: resolveCorrelationId(options.correlation_id),
    ...optionalFields(resolved.db, options),
  });
}

/**
 * Build the context for an approved write. Approval is mandatory and is
 * re-checked against the trusted account here, before the tool ever sees
 * it, so a caller cannot pair one account's approval with another account's
 * scope.
 */
export function createWriteToolExecutionContext(
  authorization: TrustedToolAuthorization,
  options: WriteToolExecutionContextOptions
): ApprovedWriteToolExecutionContext {
  const resolved = resolveAuthorization(authorization);
  const approval = resolveApproval(options?.approval, resolved.account_id);

  return Object.freeze({
    db: resolved.db,
    account_id: resolved.account_id,
    actor: resolved.actor,
    correlation_id: resolveCorrelationId(options.correlation_id),
    ...optionalFields(resolved.db, options),
    idempotency_key: requireBounded(
      options?.idempotency_key,
      'idempotency_key',
      200
    ),
    approval,
  });
}

function resolveAuthorization(
  authorization: TrustedToolAuthorization
): ResolvedAuthorization {
  if (!authorization || typeof authorization !== 'object') {
    throw new ToolContextError('A trusted authorization context is required');
  }

  switch (authorization.kind) {
    case 'session': {
      const context = authorization.context;
      if (!context?.supabase || typeof context.supabase.from !== 'function') {
        throw new ToolContextError('A session client is required');
      }
      return {
        db: context.supabase,
        account_id: requireUuid(context.accountId, 'accountId'),
        actor: { type: 'user', user_id: requireUuid(context.userId, 'userId') },
      };
    }
    case 'api_key': {
      const context = authorization.context;
      if (!context?.supabase || typeof context.supabase.from !== 'function') {
        throw new ToolContextError('An API key client is required');
      }
      return {
        db: context.supabase,
        account_id: requireUuid(context.accountId, 'accountId'),
        actor: {
          type: 'api_key',
          key_id: requireUuid(context.keyId, 'keyId'),
          user_id: optionalUuid(context.createdBy, 'createdBy'),
        },
      };
    }
    case 'system': {
      if (!authorization.db || typeof authorization.db.from !== 'function') {
        throw new ToolContextError('A trusted system client is required');
      }
      return {
        db: authorization.db,
        account_id: requireUuid(authorization.account_id, 'account_id'),
        actor: {
          type: 'system',
          user_id: optionalUuid(authorization.user_id, 'user_id'),
        },
      };
    }
    default:
      throw new ToolContextError('Unknown authorization context');
  }
}

function resolveApproval(
  approval: ToolApproval | undefined,
  accountId: string
): ToolApproval {
  if (!approval || approval.decision !== 'approved') {
    throw new ToolContextError('An approved ToolApproval is required');
  }
  if (approval.account_id !== accountId) {
    throw new ToolContextError(
      'Approval does not belong to the authorized account'
    );
  }
  requireBounded(approval.approval_id, 'approval_id', 200);
  requireUuid(approval.approved_by_user_id, 'approved_by_user_id');
  requireBounded(approval.tool_name, 'tool_name', 64);
  requireBounded(approval.idempotency_key, 'idempotency_key', 200);
  requireBounded(approval.resource?.type, 'resource.type', 64);
  requireBounded(approval.resource?.id, 'resource.id', 200);
  if (Number.isNaN(Date.parse(approval.approved_at))) {
    throw new ToolContextError('approved_at is not a valid timestamp');
  }
  return approval;
}

function resolveCorrelationId(value: string | undefined): string {
  if (value === undefined) return newCorrelationId();
  if (
    typeof value !== 'string' ||
    value.length > TOOL_CONTEXT_MAX_CORRELATION_ID_CHARS ||
    !CORRELATION_ID_PATTERN.test(value)
  ) {
    throw new ToolContextError('correlation_id is not a safe run identifier');
  }
  return value;
}

function optionalFields(
  db: SupabaseClient,
  options: ToolExecutionContextOptions
): {
  signal?: AbortSignal;
  audit: ToolAuditRecorder;
  audit_metadata?: ToolAuditMetadata;
} {
  const signal = options.signal;
  if (signal !== undefined && typeof signal?.addEventListener !== 'function') {
    throw new ToolContextError('signal must be an AbortSignal');
  }

  const auditMetadata = options.audit_metadata;
  if (auditMetadata !== undefined) {
    if (
      typeof auditMetadata !== 'object' ||
      auditMetadata === null ||
      Array.isArray(auditMetadata) ||
      Object.keys(auditMetadata).length > TOOL_CONTEXT_MAX_METADATA_KEYS
    ) {
      throw new ToolContextError('audit_metadata is not a bounded object');
    }
  }

  // `audit_db` is an override, never a client factory: a caller that wants
  // the durable trail written by a different already-trusted client passes
  // that client here.
  const auditClient = options.audit_db ?? db;

  return {
    ...(signal ? { signal } : {}),
    audit: createDurableToolAuditSink(auditClient),
    ...(auditMetadata ? { audit_metadata: auditMetadata } : {}),
  };
}

function newCorrelationId(): string {
  const webCrypto = globalThis.crypto as Crypto | undefined;
  const generated = webCrypto?.randomUUID?.();
  if (typeof generated === 'string' && generated.length > 0) return generated;
  // Never expected in the supported runtimes; a run without a correlation
  // ID would be unauditable, so fail loudly rather than inventing a shape.
  throw new ToolContextError('A correlation_id could not be generated');
}

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new ToolContextError(`${field} is not a valid identifier`);
  }
  return value;
}

function optionalUuid(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return requireUuid(value, field);
}

function requireBounded(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ToolContextError(`${field} is required`);
  }
  if (value.length > max) {
    throw new ToolContextError(`${field} is not bounded`);
  }
  return value;
}
