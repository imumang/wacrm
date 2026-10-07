/**
 * Durable, metadata-only audit sink for AI business-tool calls.
 *
 * One row per invocation in `ai_tool_call_audit` (migration 047). The row
 * answers "which tool ran, for which account, on whose authority, under
 * which run, how long did it take, and did it fail" — and nothing else.
 *
 * What is deliberately absent, by construction rather than by convention:
 * tool input, tool output, customer names/phones, message text, enquiry
 * facts, media references, credentials, and raw database errors. The
 * contract layer never passes payloads to the audit hook, and this module
 * additionally refuses anything it does not recognise: identifiers must be
 * UUIDs or bounded tokens, side-effect tokens must be bounded, and the
 * optional execution metadata is an allowlist of numeric/boolean shapes.
 * A future field therefore has to be added here deliberately, which is
 * the review event that keeps the trail metadata-only.
 *
 * Failure policy (also documented in `docs/ai-tool-layer.md`):
 * - Read tools: best effort. The row is written if it can be; a write
 *   failure is reported to the operator log by the contract layer and the
 *   read result is unchanged.
 * - Write tools: fail closed. `defineWriteTool` converts a sink failure
 *   into a retryable `unavailable` result, so an approved side effect is
 *   never left unaudited. Retrying with the same idempotency key is safe.
 *
 * The sink writes through the Supabase client the trusted caller already
 * holds. It never constructs a client and never reaches for a service-role
 * credential.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  TOOL_ERROR_CODES,
  ToolError,
  type ToolAuditEvent,
  type ToolAuditMetadata,
  type ToolAuditRecorder,
  type ToolErrorCode,
} from './contract';

export const AI_TOOL_AUDIT_TABLE = 'ai_tool_call_audit';

export const AI_TOOL_AUDIT_MAX_TOOL_NAME_CHARS = 64;
export const AI_TOOL_AUDIT_MAX_CORRELATION_ID_CHARS = 200;
export const AI_TOOL_AUDIT_MAX_IDENTIFIER_CHARS = 200;
export const AI_TOOL_AUDIT_MAX_SIDE_EFFECTS = 20;
export const AI_TOOL_AUDIT_MAX_SIDE_EFFECT_CHARS = 64;
export const AI_TOOL_AUDIT_MAX_METADATA_ENTRIES = 8;
export const AI_TOOL_AUDIT_MAX_METADATA_JSON_CHARS = 1_024;
/** A day. Guards against a clock jump turning into an absurd duration. */
export const AI_TOOL_AUDIT_MAX_DURATION_MS = 86_400_000;

/**
 * Execution shapes an audit row may record. Every value is numeric or
 * boolean, so no customer text, identifier, or provider payload can be
 * smuggled through a metadata key — a requested limit is a fact about the
 * call, not about the customer.
 */
export const AI_TOOL_AUDIT_METADATA_ALLOWLIST = [
  'requested_message_limit',
  'requested_enquiry_limit',
  'returned_message_count',
  'returned_enquiry_count',
  'has_earlier_messages',
  'has_earlier_enquiry_transitions',
  'truncated',
] as const;

export type ToolAuditMetadataKey =
  (typeof AI_TOOL_AUDIT_METADATA_ALLOWLIST)[number];

export type ToolAuditMetadataRow = Partial<
  Record<ToolAuditMetadataKey, number | boolean>
>;

export interface ToolAuditRow {
  account_id: string;
  tool_name: string;
  access: 'read' | 'write';
  side_effects: string[];
  actor_type: 'user' | 'api_key' | 'system';
  actor_user_id: string | null;
  actor_key_id: string | null;
  correlation_id: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  outcome: 'success' | 'error';
  error_code: ToolErrorCode | null;
  retryable: boolean;
  approval_id: string | null;
  idempotency_key: string | null;
  execution_metadata: Record<string, number | boolean> | null;
}

/**
 * Build the durable row for one audit event.
 *
 * Throws `ToolError('invalid_input')` when the event carries something that
 * is not safe to persist — an unknown error code, a non-UUID actor identity,
 * an oversized token. Failing here is deliberate: an audit row that cannot
 * be written faithfully must not be written approximately.
 */
export function toToolAuditRow(event: ToolAuditEvent): ToolAuditRow {
  const outcome = requireOutcome(event.outcome);
  const errorCode = normalizeErrorCode(outcome, event.error_code);
  const startedAt = requireTimestamp(event.started_at, 'started_at');
  const finishedAt = requireTimestamp(event.finished_at, 'finished_at');

  return {
    account_id: requireUuid(event.account_id, 'account_id'),
    tool_name: requireBoundedString(
      event.tool_name,
      'tool_name',
      AI_TOOL_AUDIT_MAX_TOOL_NAME_CHARS
    ),
    access: event.access,
    side_effects: normalizeSideEffects(event.access, event.side_effects),
    actor_type: event.actor.type,
    actor_user_id: actorUserId(event),
    actor_key_id:
      event.actor.type === 'api_key'
        ? requireUuid(event.actor.key_id, 'key_id')
        : null,
    correlation_id: requireBoundedString(
      event.correlation_id,
      'correlation_id',
      AI_TOOL_AUDIT_MAX_CORRELATION_ID_CHARS
    ),
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: durationMs(startedAt, finishedAt),
    outcome,
    error_code: errorCode,
    retryable: outcome === 'error' && event.retryable === true,
    approval_id: optionalBoundedIdentifier(event.approval_id, 'approval_id'),
    idempotency_key: optionalBoundedIdentifier(
      event.idempotency_key,
      'idempotency_key'
    ),
    execution_metadata: sanitizeExecutionMetadata(event.execution_metadata),
  };
}

/**
 * Persist one metadata-only audit row through the caller's own Supabase
 * client. Throws a sanitized, retryable `unavailable` when the row cannot
 * be written; the underlying database error is never propagated or logged
 * by this module because it may carry schema or connection detail.
 */
export function createDurableToolAuditSink(
  db: SupabaseClient
): ToolAuditRecorder {
  if (!db || typeof db.from !== 'function') {
    throw new ToolError(
      'invalid_input',
      'An audit database client is required'
    );
  }

  return async (event: ToolAuditEvent) => {
    const row = toToolAuditRow(event);
    const { error } = await db.from(AI_TOOL_AUDIT_TABLE).insert(row);
    if (error) {
      throw new ToolError(
        'unavailable',
        'Tool audit record could not be written',
        {
          retryable: true,
        }
      );
    }
  };
}

/**
 * Keep only allowlisted, numeric/boolean execution metadata, bounded in
 * entry count and serialized size. Everything else — unknown keys, strings,
 * nested objects, arrays — is dropped rather than coerced.
 */
export function sanitizeExecutionMetadata(
  metadata: ToolAuditMetadata | undefined
): Record<string, number | boolean> | null {
  if (!metadata || typeof metadata !== 'object') return null;

  const sanitized: Record<string, number | boolean> = {};
  for (const key of AI_TOOL_AUDIT_METADATA_ALLOWLIST) {
    const value = metadata[key];
    if (typeof value === 'boolean') {
      sanitized[key] = value;
      continue;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      sanitized[key] = value;
    }
  }

  const entries = Object.entries(sanitized);
  if (entries.length === 0) return null;
  if (entries.length > AI_TOOL_AUDIT_MAX_METADATA_ENTRIES) return null;

  const bounded: Record<string, number | boolean> = {};
  for (const [key, value] of entries) {
    const next = { ...bounded, [key]: value };
    if (JSON.stringify(next).length > AI_TOOL_AUDIT_MAX_METADATA_JSON_CHARS) {
      break;
    }
    bounded[key] = value;
  }
  return Object.keys(bounded).length === 0 ? null : bounded;
}

function actorUserId(event: ToolAuditEvent): string | null {
  const actor = event.actor;
  if (actor.type === 'user') {
    return requireUuid(actor.user_id, 'user_id');
  }
  if (actor.type === 'api_key' || typeof actor.user_id === 'string') {
    return typeof actor.user_id === 'string' && actor.user_id.trim() !== ''
      ? requireUuid(actor.user_id, 'user_id')
      : null;
  }
  return null;
}

function normalizeSideEffects(
  access: 'read' | 'write',
  sideEffects: 'none' | readonly string[]
): string[] {
  if (access === 'read') {
    if (sideEffects !== 'none') {
      throw new ToolError(
        'invalid_input',
        'A read tool call cannot declare side effects'
      );
    }
    return [];
  }
  const declared = sideEffects;
  if (!Array.isArray(declared) || declared.length === 0) {
    throw new ToolError(
      'invalid_input',
      'A write tool call must declare its side effects'
    );
  }
  if (declared.length > AI_TOOL_AUDIT_MAX_SIDE_EFFECTS) {
    throw new ToolError(
      'invalid_input',
      'Declared side effects are not bounded'
    );
  }
  return declared.map((effect) =>
    requireBoundedString(
      effect,
      'side_effects',
      AI_TOOL_AUDIT_MAX_SIDE_EFFECT_CHARS
    )
  );
}

function normalizeErrorCode(
  outcome: 'success' | 'error',
  code: ToolErrorCode | null
): ToolErrorCode | null {
  if (outcome === 'success') return null;
  if (code && (TOOL_ERROR_CODES as readonly string[]).includes(code))
    return code;
  // An unrecognised code would break the audit table's CHECK constraint;
  // collapsing it keeps the trail writable and still machine-readable.
  return 'internal';
}

function durationMs(startedAt: string, finishedAt: string): number {
  const elapsed = Date.parse(finishedAt) - Date.parse(startedAt);
  if (!Number.isFinite(elapsed) || elapsed < 0) return 0;
  return Math.min(Math.round(elapsed), AI_TOOL_AUDIT_MAX_DURATION_MS);
}

function requireOutcome(outcome: unknown): 'success' | 'error' {
  if (outcome === 'success' || outcome === 'error') return outcome;
  throw new ToolError('invalid_input', 'Audit outcome is invalid');
}

function requireTimestamp(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    !value.includes('T') ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new ToolError('invalid_input', `${field} is not a valid timestamp`);
  }
  return value;
}

function requireBoundedString(
  value: unknown,
  field: string,
  maxChars: number
): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ToolError('invalid_input', `${field} is required`);
  }
  if (value.length > maxChars) {
    throw new ToolError('invalid_input', `${field} is not bounded`);
  }
  return value;
}

function optionalBoundedIdentifier(
  value: unknown,
  field: string
): string | null {
  if (value === null || value === undefined) return null;
  return requireBoundedString(value, field, AI_TOOL_AUDIT_MAX_IDENTIFIER_CHARS);
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Account and identity columns are UUIDs in the schema, so an unparseable
 * value here means the context was built from something that is not a real
 * authorization result. Reject it instead of letting Postgres reject it.
 */
function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new ToolError('invalid_input', `${field} is not a valid identifier`);
  }
  return value;
}
