-- ============================================================
-- 047_ai_tool_call_audit.sql — durable AI tool-call audit
--
-- One row per AI business-tool invocation, containing execution
-- metadata only. This table is NOT a transcript: it stores no tool
-- input, no tool output, no customer name/phone, no message text, no
-- enquiry facts, no media reference, and no credential of any kind.
-- Anything that could carry customer content is rejected by the
-- TypeScript sink before it reaches this table (allowlisted keys,
-- scalar values only, bounded size) — see `src/lib/ai/tools/audit.ts`.
--
-- Scoping
--   Every row carries the trusted `account_id` fixed by the caller's
--   authorization state. RLS is enabled with account-scoped SELECT and
--   INSERT policies only, so an operator can read their own account's trail
--   and the server-side sink can append to it; there is no UPDATE or DELETE
--   policy for `authenticated`, and the trigger below makes rows immutable
--   even for a service-role writer.
--
-- Retention
--   `ON DELETE CASCADE` from `accounts` matches every other
--   account-scoped table in this schema (contacts, conversations,
--   enquiries, api_keys): the trail belongs to the account lifecycle,
--   and account deletion is an operator action performed out of band
--   rather than an application path.
--
-- Idempotent and additive.
-- ============================================================

-- CHECK constraints cannot contain subqueries, so the per-element
-- `side_effects` bound lives in an immutable helper. A declared side
-- effect is a short machine token; anything longer is a payload that
-- belongs somewhere other than an audit row.
CREATE OR REPLACE FUNCTION public.ai_tool_audit_side_effects_valid(
  effects TEXT[]
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT effects IS NOT NULL
    AND array_position(effects, NULL) IS NULL
    AND cardinality(effects) <= 20
    AND NOT EXISTS (
      SELECT 1 FROM unnest(effects) AS effect
      WHERE length(btrim(effect)) NOT BETWEEN 1 AND 64
    );
$$;

CREATE TABLE IF NOT EXISTS ai_tool_call_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  access TEXT NOT NULL,
  side_effects TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  actor_type TEXT NOT NULL,
  -- Attribution only. Neither column is used for tenancy isolation:
  -- `account_id` is. `ON DELETE SET NULL` so removing the human or the
  -- key never cascades away the audit row.
  actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL,
  correlation_id TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ NOT NULL,
  duration_ms INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  error_code TEXT,
  retryable BOOLEAN NOT NULL DEFAULT FALSE,
  approval_id TEXT,
  idempotency_key TEXT,
  execution_metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ai_tool_call_audit_tool_name_check CHECK (
    length(btrim(tool_name)) BETWEEN 1 AND 64
  ),
  CONSTRAINT ai_tool_call_audit_access_check CHECK (
    access IN ('read', 'write')
  ),
  -- A read can never declare a side effect. This is the database twin
  -- of `defineReadTool` returning `side_effects: 'none'`.
  CONSTRAINT ai_tool_call_audit_access_side_effects_check CHECK (
    access = 'write' OR cardinality(side_effects) = 0
  ),
  CONSTRAINT ai_tool_call_audit_side_effects_check CHECK (
    public.ai_tool_audit_side_effects_valid(side_effects)
  ),
  CONSTRAINT ai_tool_call_audit_actor_type_check CHECK (
    actor_type IN ('user', 'api_key', 'system')
  ),
  -- A `user` actor always names its authenticated principal; a `system`
  -- actor may or may not (a scheduler has no auth user).
  CONSTRAINT ai_tool_call_audit_actor_identity_check CHECK (
    actor_type <> 'user' OR actor_user_id IS NOT NULL
  ),
  CONSTRAINT ai_tool_call_audit_api_key_actor_check CHECK (
    actor_type <> 'api_key' OR actor_key_id IS NOT NULL
  ),
  CONSTRAINT ai_tool_call_audit_correlation_id_check CHECK (
    length(btrim(correlation_id)) BETWEEN 1 AND 200
  ),
  -- Duration must be non-negative. The ordering of the two timestamps is
  -- deliberately NOT asserted: an NTP step between the two reads inside one
  -- call would otherwise reject an otherwise valid record and, on the write
  -- path, fail a completed business action closed. The sink clamps the
  -- duration to zero instead of failing.
  CONSTRAINT ai_tool_call_audit_duration_check CHECK (duration_ms >= 0),
  CONSTRAINT ai_tool_call_audit_outcome_check CHECK (
    outcome IN ('success', 'error')
  ),
  -- Success carries no error code; failure always carries the safe,
  -- machine-readable one. Database messages, stacks, and provider text
  -- are never stored, so there is nothing else to record.
  CONSTRAINT ai_tool_call_audit_outcome_error_code_check CHECK (
    (outcome = 'success' AND error_code IS NULL)
    OR (outcome = 'error' AND error_code IS NOT NULL)
  ),
  CONSTRAINT ai_tool_call_audit_error_code_check CHECK (
    error_code IS NULL OR error_code IN (
      'not_found', 'forbidden', 'invalid_input', 'conflict',
      'unavailable', 'internal'
    )
  ),
  -- `retryable` describes the failure outcome, so it cannot be set on
  -- a success row.
  CONSTRAINT ai_tool_call_audit_retryable_check CHECK (
    outcome = 'error' OR retryable = FALSE
  ),
  CONSTRAINT ai_tool_call_audit_approval_id_check CHECK (
    approval_id IS NULL OR length(btrim(approval_id)) BETWEEN 1 AND 200
  ),
  CONSTRAINT ai_tool_call_audit_idempotency_key_check CHECK (
    idempotency_key IS NULL
    OR length(btrim(idempotency_key)) BETWEEN 1 AND 200
  ),
  -- Bounded metadata bag: a JSON object small enough to read by eye.
  -- Content safety is enforced upstream by an allowlist of keys; this
  -- constraint is the storage-side ceiling.
  CONSTRAINT ai_tool_call_audit_execution_metadata_check CHECK (
    execution_metadata IS NULL
    OR (
      jsonb_typeof(execution_metadata) = 'object'
      AND octet_length(execution_metadata::TEXT) <= 1024
    )
  )
);

-- Per-account chronological trail (the operator read path).
CREATE INDEX IF NOT EXISTS idx_ai_tool_call_audit_account_started
  ON ai_tool_call_audit(account_id, started_at DESC);

-- "What happened during this run?" for one account.
CREATE INDEX IF NOT EXISTS idx_ai_tool_call_audit_account_correlation
  ON ai_tool_call_audit(account_id, correlation_id);

-- Per-tool latency/failure review.
CREATE INDEX IF NOT EXISTS idx_ai_tool_call_audit_account_tool_started
  ON ai_tool_call_audit(account_id, tool_name, started_at DESC);

-- An audit record is a statement about a past event: it may be
-- appended, never edited. DELETE stays available to the account
-- cascade and to an operator with direct database access; there is no
-- authenticated DELETE policy.
CREATE OR REPLACE FUNCTION public.guard_ai_tool_call_audit_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'ai tool call audit rows are immutable'
    USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS guard_ai_tool_call_audit_update ON ai_tool_call_audit;
CREATE TRIGGER guard_ai_tool_call_audit_update
  BEFORE UPDATE ON ai_tool_call_audit
  FOR EACH ROW EXECUTE FUNCTION public.guard_ai_tool_call_audit_update();

ALTER FUNCTION public.ai_tool_audit_side_effects_valid(TEXT[]) OWNER TO postgres;
ALTER FUNCTION public.guard_ai_tool_call_audit_update() OWNER TO postgres;

REVOKE ALL ON FUNCTION public.ai_tool_audit_side_effects_valid(TEXT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_ai_tool_call_audit_update() FROM PUBLIC;

-- The side-effect validator runs from a CHECK constraint, so every role
-- that may insert a row also needs EXECUTE on it.
GRANT EXECUTE ON FUNCTION public.ai_tool_audit_side_effects_valid(TEXT[])
  TO authenticated, service_role;

ALTER TABLE ai_tool_call_audit ENABLE ROW LEVEL SECURITY;

-- Read-only for authenticated account members.
DROP POLICY IF EXISTS ai_tool_call_audit_select ON ai_tool_call_audit;
CREATE POLICY ai_tool_call_audit_select ON ai_tool_call_audit FOR SELECT
  USING (is_account_member(account_id));

-- Append for members who may perform business work. The audit sink runs
-- server-side on behalf of an authenticated operator, and this is what lets
-- a cookie-session caller record the trail with its own RLS-scoped client
-- instead of requiring a service-role key. The trade-off is explicit: an
-- operator can append a row *for their own account only*, and because the
-- table holds no customer content, the worst case is a misleading row
-- inside their own tenant rather than a data leak. UPDATE is impossible
-- (trigger above), so a row cannot be quietly amended after the fact.
DROP POLICY IF EXISTS ai_tool_call_audit_insert ON ai_tool_call_audit;
CREATE POLICY ai_tool_call_audit_insert ON ai_tool_call_audit FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

-- No authenticated UPDATE or DELETE policies: rows are immutable once
-- written, and removal only happens through the account cascade.