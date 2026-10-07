-- ============================================================
-- 046_repeat_enquiry_idempotency.sql — repeat-action identity
--
-- A repeat enquiry is an explicit, approved business action. These nullable
-- identifiers are present only on rows created by that action. Existing and
-- first-inbound enquiries remain NULL and are not reclassified.
-- ============================================================

ALTER TABLE enquiries
  ADD COLUMN IF NOT EXISTS repeat_action_idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS repeat_action_approval_id TEXT,
  ADD COLUMN IF NOT EXISTS repeat_action_correlation_id TEXT;

ALTER TABLE enquiries
  DROP CONSTRAINT IF EXISTS enquiries_repeat_action_metadata_check;
ALTER TABLE enquiries
  ADD CONSTRAINT enquiries_repeat_action_metadata_check CHECK (
    (
      repeat_action_idempotency_key IS NULL
      AND repeat_action_approval_id IS NULL
      AND repeat_action_correlation_id IS NULL
    )
    OR
    (
      repeat_action_idempotency_key IS NOT NULL
      AND length(btrim(repeat_action_idempotency_key)) BETWEEN 1 AND 200
      AND repeat_action_approval_id IS NOT NULL
      AND length(btrim(repeat_action_approval_id)) BETWEEN 1 AND 200
      AND repeat_action_correlation_id IS NOT NULL
      AND length(btrim(repeat_action_correlation_id)) BETWEEN 1 AND 200
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_enquiries_repeat_action_idempotency
  ON enquiries(account_id, repeat_action_idempotency_key)
  WHERE repeat_action_idempotency_key IS NOT NULL;

-- Audit and idempotency identity must not be reassigned after creation.
CREATE OR REPLACE FUNCTION public.guard_enquiry_repeat_action_metadata()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.repeat_action_idempotency_key IS DISTINCT FROM OLD.repeat_action_idempotency_key
     OR NEW.repeat_action_approval_id IS DISTINCT FROM OLD.repeat_action_approval_id
     OR NEW.repeat_action_correlation_id IS DISTINCT FROM OLD.repeat_action_correlation_id THEN
    RAISE EXCEPTION 'repeat enquiry action metadata is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_enquiry_repeat_action_metadata ON enquiries;
CREATE TRIGGER guard_enquiry_repeat_action_metadata
  BEFORE UPDATE ON enquiries
  FOR EACH ROW EXECUTE FUNCTION public.guard_enquiry_repeat_action_metadata();

ALTER FUNCTION public.guard_enquiry_repeat_action_metadata() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_enquiry_repeat_action_metadata() FROM PUBLIC;
