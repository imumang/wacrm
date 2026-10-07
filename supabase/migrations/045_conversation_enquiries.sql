-- ============================================================
-- 045_conversation_enquiries.sql — durable enquiry state
--
-- A conversation is the permanent WhatsApp thread for one contact
-- (migration 036 enforces one per account/contact). An enquiry is a
-- business job within that thread, so it lives in its own table rather
-- than overloading conversations.status (open/pending/closed).
--
-- Historical conversations are intentionally not backfilled: their
-- business state cannot be known without inventing facts. New enquiry
-- rows are created explicitly by the domain layer and begin in
-- new_enquiry. A partial unique index permits history while allowing at
-- most one non-terminal enquiry per conversation.
--
-- Idempotent and additive.
-- ============================================================

-- The composite key prevents an enquiry from naming a conversation in a
-- different account, even on service-role write paths that bypass RLS.
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_id_account
  ON conversations(id, account_id);

CREATE TABLE IF NOT EXISTS enquiries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL,
  created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  workflow_state TEXT NOT NULL DEFAULT 'new_enquiry' CHECK (workflow_state IN (
    'new_enquiry',
    'gathering_information',
    'awaiting_photos',
    'ready_for_quote',
    'quote_draft',
    'quote_sent',
    'awaiting_acceptance',
    'booking_requested',
    'booked',
    'reschedule_requested',
    'cancelled',
    'completed'
  )),
  customer_intent TEXT,
  postcode TEXT,
  address TEXT,
  property_type TEXT,
  floor TEXT,
  lift_available BOOLEAN,
  parking TEXT,
  access_constraints TEXT[],
  item_descriptions TEXT[],
  waste_type TEXT,
  estimated_volume TEXT,
  heavy_special_items TEXT[],
  photos_received BOOLEAN,
  preferred_date DATE,
  preferred_time_window TEXT,
  missing_information TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  state_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT enquiries_conversation_account_fk
    FOREIGN KEY (conversation_id, account_id)
    REFERENCES conversations(id, account_id)
    ON DELETE CASCADE,
  CONSTRAINT enquiries_id_account_key UNIQUE (id, account_id),
  CONSTRAINT enquiries_missing_information_values CHECK (
    missing_information <@ ARRAY[
      'customer_intent',
      'customer_name',
      'phone',
      'postcode',
      'address',
      'property_type',
      'floor',
      'lift_availability',
      'parking',
      'access_constraints',
      'item_descriptions',
      'waste_type',
      'estimated_volume',
      'heavy_special_items',
      'photos_received',
      'preferred_date',
      'preferred_time_window'
    ]::TEXT[]
  ),
  CONSTRAINT enquiries_missing_information_no_nulls CHECK (
    array_position(missing_information, NULL) IS NULL
  ),
  CONSTRAINT enquiries_access_constraints_no_nulls CHECK (
    access_constraints IS NULL OR array_position(access_constraints, NULL) IS NULL
  ),
  CONSTRAINT enquiries_item_descriptions_no_nulls CHECK (
    item_descriptions IS NULL OR array_position(item_descriptions, NULL) IS NULL
  ),
  CONSTRAINT enquiries_heavy_special_items_no_nulls CHECK (
    heavy_special_items IS NULL OR array_position(heavy_special_items, NULL) IS NULL
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_enquiries_one_active_per_conversation
  ON enquiries(conversation_id)
  WHERE workflow_state NOT IN ('cancelled', 'completed');

CREATE INDEX IF NOT EXISTS idx_enquiries_account_created
  ON enquiries(account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_enquiries_conversation_created
  ON enquiries(conversation_id, created_at DESC);

-- Append-only workflow audit. Facts remain on the enquiry row; this table
-- records every state boundary, including initial creation.
CREATE TABLE IF NOT EXISTS enquiry_state_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  enquiry_id UUID NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  changed_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT enquiry_state_events_enquiry_account_fk
    FOREIGN KEY (enquiry_id, account_id)
    REFERENCES enquiries(id, account_id)
    ON DELETE CASCADE,
  CONSTRAINT enquiry_state_events_from_state_check CHECK (
    from_state IS NULL OR from_state IN (
      'new_enquiry', 'gathering_information', 'awaiting_photos',
      'ready_for_quote', 'quote_draft', 'quote_sent',
      'awaiting_acceptance', 'booking_requested', 'booked',
      'reschedule_requested', 'cancelled', 'completed'
    )
  ),
  CONSTRAINT enquiry_state_events_to_state_check CHECK (to_state IN (
    'new_enquiry', 'gathering_information', 'awaiting_photos',
    'ready_for_quote', 'quote_draft', 'quote_sent',
    'awaiting_acceptance', 'booking_requested', 'booked',
    'reschedule_requested', 'cancelled', 'completed'
  ))
);

CREATE INDEX IF NOT EXISTS idx_enquiry_state_events_enquiry_time
  ON enquiry_state_events(enquiry_id, changed_at DESC);

-- The SQL transition graph is the final backstop for direct PostgREST and
-- service-role writes. The TypeScript twin provides fast, testable domain
-- feedback before a write reaches Postgres.
CREATE OR REPLACE FUNCTION public.is_valid_enquiry_state_transition(
  current_state TEXT,
  next_state TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT current_state = next_state OR CASE current_state
    WHEN 'new_enquiry' THEN next_state IN (
      'gathering_information', 'awaiting_photos', 'ready_for_quote', 'cancelled'
    )
    WHEN 'gathering_information' THEN next_state IN (
      'awaiting_photos', 'ready_for_quote', 'cancelled'
    )
    WHEN 'awaiting_photos' THEN next_state IN (
      'gathering_information', 'ready_for_quote', 'cancelled'
    )
    WHEN 'ready_for_quote' THEN next_state IN (
      'gathering_information', 'awaiting_photos', 'quote_draft', 'cancelled'
    )
    WHEN 'quote_draft' THEN next_state IN (
      'gathering_information', 'awaiting_photos', 'ready_for_quote',
      'quote_sent', 'cancelled'
    )
    WHEN 'quote_sent' THEN next_state IN (
      'quote_draft', 'awaiting_acceptance', 'booking_requested', 'cancelled'
    )
    WHEN 'awaiting_acceptance' THEN next_state IN (
      'quote_draft', 'booking_requested', 'cancelled'
    )
    WHEN 'booking_requested' THEN next_state IN ('booked', 'cancelled')
    WHEN 'booked' THEN next_state IN (
      'reschedule_requested', 'cancelled', 'completed'
    )
    WHEN 'reschedule_requested' THEN next_state IN ('booked', 'cancelled')
    WHEN 'cancelled' THEN FALSE
    WHEN 'completed' THEN FALSE
    ELSE FALSE
  END;
$$;

CREATE OR REPLACE FUNCTION public.guard_enquiry_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.workflow_state <> 'new_enquiry' THEN
      RAISE EXCEPTION 'new enquiries must start in new_enquiry'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.created_by_user_id IS NULL THEN
      RAISE EXCEPTION 'created_by_user_id is required when creating an enquiry'
        USING ERRCODE = '23502';
    END IF;
    IF auth.uid() IS NOT NULL
       AND NEW.created_by_user_id IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'created_by_user_id must match the authenticated user'
        USING ERRCODE = '42501';
    END IF;
    NEW.created_at := NOW();
    NEW.updated_at := NEW.created_at;
    NEW.state_changed_at := NEW.created_at;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'enquiry identity and creation fields are immutable'
      USING ERRCODE = '23514';
  END IF;

  -- Preserve creator attribution except when the referenced auth user is
  -- deleted and the FK sets it to NULL. It can never be reassigned.
  IF NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
     AND NOT (
       NEW.created_by_user_id IS NULL
       AND pg_trigger_depth() > 1
     ) THEN
    RAISE EXCEPTION 'created_by_user_id cannot be reassigned'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.workflow_state IS DISTINCT FROM OLD.workflow_state THEN
    IF NOT public.is_valid_enquiry_state_transition(
      OLD.workflow_state,
      NEW.workflow_state
    ) THEN
      RAISE EXCEPTION 'invalid enquiry state transition: % -> %',
        OLD.workflow_state, NEW.workflow_state
        USING ERRCODE = '23514';
    END IF;
    NEW.state_changed_at := NOW();
  ELSE
    NEW.state_changed_at := OLD.state_changed_at;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.audit_enquiry_state_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO enquiry_state_events (
      account_id, enquiry_id, from_state, to_state, changed_by_user_id, changed_at
    ) VALUES (
      NEW.account_id, NEW.id, NULL, NEW.workflow_state, auth.uid(), NEW.created_at
    );
  ELSIF NEW.workflow_state IS DISTINCT FROM OLD.workflow_state THEN
    INSERT INTO enquiry_state_events (
      account_id, enquiry_id, from_state, to_state, changed_by_user_id, changed_at
    ) VALUES (
      NEW.account_id, NEW.id, OLD.workflow_state, NEW.workflow_state,
      auth.uid(), NEW.state_changed_at
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_enquiry_write ON enquiries;
CREATE TRIGGER guard_enquiry_write
  BEFORE INSERT OR UPDATE ON enquiries
  FOR EACH ROW EXECUTE FUNCTION public.guard_enquiry_write();

DROP TRIGGER IF EXISTS set_updated_at ON enquiries;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON enquiries
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS audit_enquiry_state_change ON enquiries;
CREATE TRIGGER audit_enquiry_state_change
  AFTER INSERT OR UPDATE OF workflow_state ON enquiries
  FOR EACH ROW EXECUTE FUNCTION public.audit_enquiry_state_change();

ALTER FUNCTION public.is_valid_enquiry_state_transition(TEXT, TEXT) OWNER TO postgres;
ALTER FUNCTION public.guard_enquiry_write() OWNER TO postgres;
ALTER FUNCTION public.audit_enquiry_state_change() OWNER TO postgres;

REVOKE ALL ON FUNCTION public.guard_enquiry_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.audit_enquiry_state_change() FROM PUBLIC;

ALTER TABLE enquiries ENABLE ROW LEVEL SECURITY;
ALTER TABLE enquiry_state_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS enquiries_select ON enquiries;
CREATE POLICY enquiries_select ON enquiries FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS enquiries_insert ON enquiries;
CREATE POLICY enquiries_insert ON enquiries FOR INSERT
  WITH CHECK (
    is_account_member(account_id, 'agent')
    AND created_by_user_id = auth.uid()
  );

DROP POLICY IF EXISTS enquiries_update ON enquiries;
CREATE POLICY enquiries_update ON enquiries FOR UPDATE
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));

-- No authenticated DELETE policy: enquiries and their state history are
-- durable records. Account/conversation cascades still apply.

DROP POLICY IF EXISTS enquiry_state_events_select ON enquiry_state_events;
CREATE POLICY enquiry_state_events_select ON enquiry_state_events FOR SELECT
  USING (is_account_member(account_id));

-- State events are trigger-written and append-only. No authenticated
-- INSERT/UPDATE/DELETE policies are exposed.
