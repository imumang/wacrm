import type { SupabaseClient } from '@supabase/supabase-js';

export const TOOL_ERROR_CODES = [
  'not_found',
  'forbidden',
  'invalid_input',
  'conflict',
  'unavailable',
  'internal',
] as const;

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

export interface ToolErrorShape {
  code: ToolErrorCode;
  message: string;
  retryable: boolean;
}

export class ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly retryable: boolean;

  constructor(
    code: ToolErrorCode,
    message: string,
    options: { retryable?: boolean } = {}
  ) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

export type ToolActor =
  | { type: 'user'; user_id: string }
  | { type: 'api_key'; key_id: string; user_id?: string | null }
  | { type: 'system'; user_id?: string | null };

/**
 * Metadata-only execution detail an audit record may carry (a requested
 * read limit, for example). Values are numbers or booleans on purpose: a
 * string here would be an unbounded place for customer content to hide, and
 * the durable sink persists an allowlisted subset only.
 */
export type ToolAuditMetadataValue = number | boolean;

export type ToolAuditMetadata = Readonly<
  Record<string, ToolAuditMetadataValue>
>;

interface ToolAuditEventBase {
  tool_name: string;
  account_id: string;
  actor: ToolActor;
  correlation_id: string;
  started_at: string;
  finished_at: string;
  outcome: 'success' | 'error';
  error_code: ToolErrorCode | null;
  /** Whether the caller may safely retry the same call. */
  retryable: boolean;
  /** Bounded, non-content execution metadata. Never tool input/output. */
  execution_metadata?: ToolAuditMetadata;
}

export interface ReadToolAuditEvent extends ToolAuditEventBase {
  access: 'read';
  side_effects: 'none';
  approval_id: null;
  idempotency_key: null;
}

export interface WriteToolAuditEvent extends ToolAuditEventBase {
  access: 'write';
  side_effects: readonly string[];
  approval_id: string | null;
  idempotency_key: string | null;
}

export type ToolAuditEvent = ReadToolAuditEvent | WriteToolAuditEvent;

/**
 * A trusted caller supplies this out-of-band from model/tool input. This is
 * the minimal approval boundary until the full policy engine exists.
 */
export interface ToolApproval {
  decision: 'approved';
  approval_id: string;
  account_id: string;
  tool_name: string;
  idempotency_key: string;
  approved_by_user_id: string;
  approved_at: string;
  resource: {
    type: string;
    id: string;
  };
}

export interface ToolExecutionContext {
  /** RLS-scoped client for user calls, or a trusted client for system calls. */
  db: SupabaseClient;
  /** Fixed by the authenticated caller; never selected by the model. */
  account_id: string;
  actor: ToolActor;
  correlation_id: string;
  /** Callers may use AbortSignal.timeout(...) to impose a timeout. */
  signal?: AbortSignal;
  /** Metadata-only hook. Tool inputs and customer outputs are never emitted. */
  audit?: ToolAuditRecorder;
  /**
   * Bounded execution metadata for the audit record (requested limits and
   * similar). Supplied by the trusted caller, sanitized by the durable sink,
   * and never derived from model input.
   */
  audit_metadata?: ToolAuditMetadata;
}

/** The metadata-only audit hook shape a caller supplies. */
export type ToolAuditRecorder = (event: ToolAuditEvent) => void | Promise<void>;

export interface WriteToolExecutionContext extends ToolExecutionContext {
  /** Stable per approved business action and reused for every retry. */
  idempotency_key: string;
  /** Never sourced from model input. Absence or mismatch fails closed. */
  approval?: ToolApproval;
}

export type ApprovedWriteToolExecutionContext = Omit<
  WriteToolExecutionContext,
  'approval'
> & {
  approval: ToolApproval;
};

export type ToolResult<T> =
  | {
      ok: true;
      data: T;
      correlation_id: string;
    }
  | {
      ok: false;
      error: ToolErrorShape;
      correlation_id: string;
    };

export interface ReadBusinessTool<TInput, TOutput> {
  readonly name: string;
  readonly access: 'read';
  readonly side_effects: 'none';
  execute(
    context: ToolExecutionContext,
    input: TInput
  ): Promise<ToolResult<TOutput>>;
}

export interface WriteBusinessTool<TInput, TOutput> {
  readonly name: string;
  readonly access: 'write';
  readonly side_effects: readonly [string, ...string[]];
  readonly approval_required: true;
  readonly idempotency: 'required_account_tool_scoped';
  readonly account_scope: 'required';
  readonly actor_identity: 'required';
  readonly audit_required: true;
  readonly cancellation: 'caller_controlled_retry_same_idempotency_key';
  readonly timeout: 'caller_controlled';
  execute(
    context: WriteToolExecutionContext,
    input: TInput
  ): Promise<ToolResult<TOutput>>;
}

export type BusinessTool<TInput, TOutput> =
  ReadBusinessTool<TInput, TOutput> | WriteBusinessTool<TInput, TOutput>;

type ToolHandler<TInput, TOutput> = (
  context: ToolExecutionContext,
  input: TInput
) => Promise<TOutput>;

export function defineReadTool<TInput, TOutput>(
  name: string,
  handler: ToolHandler<TInput, TOutput>
): ReadBusinessTool<TInput, TOutput> {
  return {
    name,
    access: 'read',
    side_effects: 'none',
    async execute(context, input) {
      const startedAt = new Date().toISOString();
      const correlationId =
        typeof context.correlation_id === 'string'
          ? context.correlation_id
          : '';

      try {
        validateExecutionContext(context);
        const data = await withCancellation(
          handler(context, input),
          context.signal
        );
        await emitAudit(context, {
          tool_name: name,
          access: 'read',
          account_id: context.account_id,
          actor: context.actor,
          correlation_id: context.correlation_id,
          side_effects: 'none',
          approval_id: null,
          idempotency_key: null,
          started_at: startedAt,
          finished_at: new Date().toISOString(),
          outcome: 'success',
          error_code: null,
          retryable: false,
          execution_metadata: context.audit_metadata,
        });
        return { ok: true, data, correlation_id: context.correlation_id };
      } catch (error) {
        const normalized = normalizeToolError(error);
        if (hasAuditableContext(context)) {
          await emitAudit(context, {
            tool_name: name,
            access: 'read',
            account_id: context.account_id,
            actor: context.actor,
            correlation_id: context.correlation_id,
            side_effects: 'none',
            approval_id: null,
            idempotency_key: null,
            started_at: startedAt,
            finished_at: new Date().toISOString(),
            outcome: 'error',
            error_code: normalized.code,
            retryable: normalized.retryable,
            execution_metadata: context.audit_metadata,
          });
        }
        return {
          ok: false,
          error: normalized,
          correlation_id: correlationId,
        };
      }
    },
  };
}

type WriteToolHandler<TInput, TOutput> = (
  context: ApprovedWriteToolExecutionContext,
  input: TInput
) => Promise<TOutput>;

export function defineWriteTool<TInput, TOutput>(
  name: string,
  definition: {
    side_effects: readonly [string, ...string[]];
    handler: WriteToolHandler<TInput, TOutput>;
  }
): WriteBusinessTool<TInput, TOutput> {
  const sideEffects = Object.freeze([...definition.side_effects]) as readonly [
    string,
    ...string[],
  ];

  return {
    name,
    access: 'write',
    side_effects: sideEffects,
    approval_required: true,
    idempotency: 'required_account_tool_scoped',
    account_scope: 'required',
    actor_identity: 'required',
    audit_required: true,
    cancellation: 'caller_controlled_retry_same_idempotency_key',
    timeout: 'caller_controlled',
    async execute(context, input) {
      const startedAt = new Date().toISOString();
      const correlationId =
        typeof context.correlation_id === 'string'
          ? context.correlation_id
          : '';

      try {
        validateWriteExecutionContext(context, name);
        const data = await withCancellation(
          definition.handler(context, input),
          context.signal
        );
        await emitRequiredWriteAudit(context, {
          tool_name: name,
          access: 'write',
          side_effects: sideEffects,
          account_id: context.account_id,
          actor: context.actor,
          correlation_id: context.correlation_id,
          approval_id: context.approval.approval_id,
          idempotency_key: context.idempotency_key,
          started_at: startedAt,
          finished_at: new Date().toISOString(),
          outcome: 'success',
          error_code: null,
          retryable: false,
          execution_metadata: context.audit_metadata,
        });
        return { ok: true, data, correlation_id: context.correlation_id };
      } catch (error) {
        let normalized = normalizeToolError(error);
        if (hasAuditableContext(context) && context.audit) {
          try {
            await emitRequiredWriteAudit(context, {
              tool_name: name,
              access: 'write',
              side_effects: sideEffects,
              account_id: context.account_id,
              actor: context.actor,
              correlation_id: context.correlation_id,
              approval_id: validMetadataString(context.approval?.approval_id),
              idempotency_key: validMetadataString(context.idempotency_key),
              started_at: startedAt,
              finished_at: new Date().toISOString(),
              outcome: 'error',
              error_code: normalized.code,
              retryable: normalized.retryable,
              execution_metadata: context.audit_metadata,
            });
          } catch (auditError) {
            normalized = normalizeToolError(auditError);
          }
        }
        return {
          ok: false,
          error: normalized,
          correlation_id: correlationId,
        };
      }
    },
  };
}

function validateExecutionContext(context: ToolExecutionContext): void {
  if (!context.db || typeof context.db.from !== 'function') {
    throw new ToolError('invalid_input', 'A database client is required');
  }
  if (!isNonEmptyString(context.account_id)) {
    throw new ToolError('invalid_input', 'account_id is required');
  }
  if (!isNonEmptyString(context.correlation_id)) {
    throw new ToolError('invalid_input', 'correlation_id is required');
  }
  if (!isValidActor(context.actor)) {
    throw new ToolError('invalid_input', 'A valid actor identity is required');
  }
  if (context.signal?.aborted) {
    throw cancelledError();
  }
}

function validateWriteExecutionContext(
  context: WriteToolExecutionContext,
  toolName: string
): asserts context is ApprovedWriteToolExecutionContext {
  validateExecutionContext(context);
  if (typeof context.audit !== 'function') {
    throw new ToolError('invalid_input', 'A write audit hook is required');
  }
  if (!isBoundedMetadataString(context.idempotency_key)) {
    throw new ToolError('invalid_input', 'A valid idempotency_key is required');
  }

  const approval = context.approval;
  if (!approval || approval.decision !== 'approved') {
    throw new ToolError('forbidden', 'Explicit approval is required');
  }
  if (
    !isBoundedMetadataString(approval.approval_id) ||
    !isNonEmptyString(approval.approved_by_user_id) ||
    !isValidIsoTimestamp(approval.approved_at) ||
    !isNonEmptyString(approval.resource?.type) ||
    !isNonEmptyString(approval.resource?.id)
  ) {
    throw new ToolError('forbidden', 'Approval metadata is invalid');
  }
  if (
    approval.account_id !== context.account_id ||
    approval.tool_name !== toolName ||
    approval.idempotency_key !== context.idempotency_key
  ) {
    throw new ToolError(
      'forbidden',
      'Approval does not authorize this account, tool, or action'
    );
  }
}

function isValidActor(actor: ToolActor | undefined): actor is ToolActor {
  if (!actor || typeof actor !== 'object') return false;
  if (actor.type === 'user') return isNonEmptyString(actor.user_id);
  if (actor.type === 'api_key') return isNonEmptyString(actor.key_id);
  return actor.type === 'system';
}

function hasAuditableContext(
  context: ToolExecutionContext
): context is ToolExecutionContext {
  return (
    isNonEmptyString(context.account_id) &&
    isNonEmptyString(context.correlation_id) &&
    isValidActor(context.actor)
  );
}

function normalizeToolError(error: unknown): ToolErrorShape {
  if (error instanceof ToolError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }
  return {
    code: 'internal',
    message: 'Tool execution failed',
    retryable: false,
  };
}

async function emitAudit(
  context: ToolExecutionContext,
  event: ToolAuditEvent
): Promise<void> {
  if (!context.audit) return;
  try {
    await context.audit(event);
  } catch {
    // Documented policy: read-tool audit is best-effort. A read is
    // side-effect free, so an audit-storage outage must not turn a
    // successful customer lookup into an error — but the failure is
    // never silent: the operator log carries the metadata needed to
    // alert on it (account, tool, correlation, outcome). Nothing from
    // the tool input or output is logged.
    console.error('[ai-tool-audit] read audit record was not written', {
      account_id: event.account_id,
      tool_name: event.tool_name,
      correlation_id: event.correlation_id,
      outcome: event.outcome,
    });
  }
}

async function emitRequiredWriteAudit(
  context: WriteToolExecutionContext,
  event: WriteToolAuditEvent
): Promise<void> {
  if (!context.audit) {
    throw new ToolError('invalid_input', 'A write audit hook is required');
  }
  try {
    await context.audit(event);
  } catch {
    // Documented policy: write-tool audit fails closed. An approved
    // side effect whose audit record is missing is unauditable, so the
    // caller receives a retryable `unavailable` and replays with the
    // same idempotency key. The original failure is intentionally not
    // logged here: it may carry database or provider detail.
    throw new ToolError('unavailable', 'Write audit recording failed', {
      retryable: true,
    });
  }
}

function withCancellation<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined
): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(cancelledError());

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(cancelledError());
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

function cancelledError(): ToolError {
  return new ToolError('unavailable', 'Tool execution was cancelled', {
    retryable: true,
  });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isBoundedMetadataString(value: unknown): value is string {
  return isNonEmptyString(value) && value.length <= 200;
}

function validMetadataString(value: unknown): string | null {
  return isBoundedMetadataString(value) ? value : null;
}

function isValidIsoTimestamp(value: unknown): value is string {
  return (
    isNonEmptyString(value) &&
    Number.isFinite(Date.parse(value)) &&
    value.includes('T')
  );
}
