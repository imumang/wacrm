-- 052_quote_record_lifecycle.sql
--
-- Canonical, account-scoped quote revisions and their append-only decision
-- history. A quote is a commercial proposal. It is deliberately not a deal,
-- invoice, payment, or completed-job outcome.
--
-- Money is integer minor units (BIGINT): GBP 30000 means £300.00. Ranges keep
-- both endpoints; they are never collapsed into a fake midpoint.

CREATE OR REPLACE FUNCTION public.quote_text_array_valid(p_values TEXT[])
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT p_values IS NOT NULL
    AND cardinality(p_values) <= 20
    AND array_position(p_values, NULL) IS NULL
    AND COALESCE((
      SELECT bool_and(btrim(value) <> '' AND length(value) <= 500)
      FROM unnest(p_values) value
    ), TRUE);
$$;

CREATE TABLE IF NOT EXISTS quotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  enquiry_id UUID NOT NULL,
  revision_number INTEGER NOT NULL,

  status TEXT NOT NULL,
  customer_decision TEXT NOT NULL DEFAULT 'unknown',
  origin TEXT NOT NULL,

  currency TEXT NOT NULL,
  amount_type TEXT NOT NULL,
  fixed_amount_minor BIGINT,
  range_min_minor BIGINT,
  range_max_minor BIGINT,

  supersedes_quote_id UUID,
  superseded_by_quote_id UUID,
  recommendation_quote_id UUID,

  assumptions TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  exclusions TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  operator_notes TEXT,
  source_reference TEXT,
  source_observed_at TIMESTAMPTZ,
  override_reason TEXT,
  override_reason_note TEXT,

  created_by_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  approved_at TIMESTAMPTZ,
  approved_by_user_id UUID REFERENCES auth.users(id) ON DELETE RESTRICT,
  presented_at TIMESTAMPTZ,
  presented_by_user_id UUID REFERENCES auth.users(id) ON DELETE RESTRICT,
  decision_recorded_at TIMESTAMPTZ,
  decision_recorded_by_user_id UUID REFERENCES auth.users(id) ON DELETE RESTRICT,
  decision_note TEXT,

  creation_idempotency_key TEXT NOT NULL,
  last_action_idempotency_key TEXT,
  last_action_by_user_id UUID REFERENCES auth.users(id) ON DELETE RESTRICT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT quotes_id_account_key UNIQUE (id, account_id),
  CONSTRAINT quotes_enquiry_account_fk
    FOREIGN KEY (enquiry_id, account_id)
    REFERENCES enquiries(id, account_id)
    ON DELETE CASCADE,
  CONSTRAINT quotes_supersedes_account_fk
    FOREIGN KEY (supersedes_quote_id, account_id)
    REFERENCES quotes(id, account_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT quotes_superseded_by_account_fk
    FOREIGN KEY (superseded_by_quote_id, account_id)
    REFERENCES quotes(id, account_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT quotes_recommendation_account_fk
    FOREIGN KEY (recommendation_quote_id, account_id)
    REFERENCES quotes(id, account_id)
    DEFERRABLE INITIALLY DEFERRED,

  CONSTRAINT quotes_revision_check CHECK (revision_number >= 1),
  CONSTRAINT quotes_revision_parent_check CHECK (
    (revision_number = 1 AND supersedes_quote_id IS NULL)
    OR (revision_number > 1 AND supersedes_quote_id IS NOT NULL)
  ),
  CONSTRAINT quotes_status_check CHECK (status IN (
    'draft', 'awaiting_approval', 'approved', 'presented',
    'expired', 'superseded', 'withdrawn'
  )),
  CONSTRAINT quotes_customer_decision_check CHECK (customer_decision IN (
    'unknown', 'accepted', 'rejected_price', 'found_better_price',
    'no_response', 'cancelled_by_customer', 'other_lost'
  )),
  CONSTRAINT quotes_origin_check CHECK (origin IN (
    'manual', 'ai_suggested', 'hybrid_engine', 'imported_historical'
  )),
  CONSTRAINT quotes_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT quotes_amount_type_check CHECK (amount_type IN ('fixed', 'range')),
  CONSTRAINT quotes_amount_shape_check CHECK (
    (
      amount_type = 'fixed'
      AND fixed_amount_minor IS NOT NULL
      AND fixed_amount_minor >= 0
      AND fixed_amount_minor <= 999999999999
      AND range_min_minor IS NULL
      AND range_max_minor IS NULL
    )
    OR
    (
      amount_type = 'range'
      AND fixed_amount_minor IS NULL
      AND range_min_minor IS NOT NULL
      AND range_max_minor IS NOT NULL
      AND range_min_minor >= 0
      AND range_max_minor <= 999999999999
      AND range_min_minor <= range_max_minor
    )
  ),
  CONSTRAINT quotes_assumptions_check CHECK (
    public.quote_text_array_valid(assumptions)
  ),
  CONSTRAINT quotes_exclusions_check CHECK (
    public.quote_text_array_valid(exclusions)
  ),
  CONSTRAINT quotes_text_bounds_check CHECK (
    (operator_notes IS NULL OR (btrim(operator_notes) <> '' AND length(operator_notes) <= 2000))
    AND (source_reference IS NULL OR (btrim(source_reference) <> '' AND length(source_reference) <= 500))
    AND (override_reason_note IS NULL OR (btrim(override_reason_note) <> '' AND length(override_reason_note) <= 1000))
    AND (decision_note IS NULL OR (btrim(decision_note) <> '' AND length(decision_note) <= 1000))
  ),
  CONSTRAINT quotes_override_reason_check CHECK (
    override_reason IS NULL OR override_reason IN (
      'image_underestimated_volume', 'image_overestimated_volume',
      'access_difficulty', 'additional_items', 'unusual_disposal_cost',
      'travel_distance', 'market_commercial_adjustment',
      'customer_specific_adjustment', 'manual_judgement', 'other'
    )
  ),
  CONSTRAINT quotes_override_reference_check CHECK (
    (override_reason IS NULL AND override_reason_note IS NULL)
    OR recommendation_quote_id IS NOT NULL
  ),
  CONSTRAINT quotes_imported_provenance_check CHECK (
    origin <> 'imported_historical'
    OR (source_reference IS NOT NULL AND source_observed_at IS NOT NULL)
  ),
  CONSTRAINT quotes_approval_metadata_check CHECK (
    (approved_at IS NULL) = (approved_by_user_id IS NULL)
  ),
  CONSTRAINT quotes_presentation_metadata_check CHECK (
    (presented_at IS NULL) = (presented_by_user_id IS NULL)
  ),
  CONSTRAINT quotes_decision_metadata_check CHECK (
    (
      customer_decision = 'unknown'
      AND decision_recorded_at IS NULL
      AND decision_recorded_by_user_id IS NULL
      AND decision_note IS NULL
    )
    OR
    (
      customer_decision <> 'unknown'
      AND decision_recorded_at IS NOT NULL
      AND decision_recorded_by_user_id IS NOT NULL
    )
  ),
  CONSTRAINT quotes_lifecycle_metadata_check CHECK (
    (status NOT IN ('approved', 'presented') OR approved_at IS NOT NULL)
    AND (status <> 'presented' OR presented_at IS NOT NULL)
  ),
  CONSTRAINT quotes_creation_idempotency_check CHECK (
    length(creation_idempotency_key) BETWEEN 1 AND 128
    AND creation_idempotency_key ~ '^[A-Za-z0-9._:-]+$'
  ),
  CONSTRAINT quotes_action_idempotency_check CHECK (
    last_action_idempotency_key IS NULL OR (
      length(last_action_idempotency_key) BETWEEN 1 AND 128
      AND last_action_idempotency_key ~ '^[A-Za-z0-9._:-]+$'
    )
  ),
  CONSTRAINT quotes_last_action_actor_check CHECK (
    (last_action_idempotency_key IS NULL) = (last_action_by_user_id IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_quotes_account_enquiry_revision
  ON quotes(account_id, enquiry_id, revision_number);

CREATE UNIQUE INDEX IF NOT EXISTS idx_quotes_one_current_per_enquiry
  ON quotes(account_id, enquiry_id)
  WHERE status IN ('draft', 'awaiting_approval', 'approved', 'presented');

CREATE UNIQUE INDEX IF NOT EXISTS idx_quotes_one_successor
  ON quotes(supersedes_quote_id)
  WHERE supersedes_quote_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_quotes_creation_idempotency
  ON quotes(account_id, creation_idempotency_key);

CREATE UNIQUE INDEX IF NOT EXISTS idx_quotes_action_idempotency
  ON quotes(account_id, last_action_idempotency_key)
  WHERE last_action_idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_quotes_account_enquiry_history
  ON quotes(account_id, enquiry_id, revision_number DESC);

CREATE INDEX IF NOT EXISTS idx_quotes_account_decision
  ON quotes(account_id, customer_decision)
  WHERE customer_decision <> 'unknown';

CREATE TABLE IF NOT EXISTS quote_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  quote_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  customer_decision TEXT,
  actor_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT quote_events_quote_account_fk
    FOREIGN KEY (quote_id, account_id)
    REFERENCES quotes(id, account_id)
    ON DELETE CASCADE,
  CONSTRAINT quote_events_type_check CHECK (event_type IN (
    'created', 'awaiting_approval', 'approved', 'presented',
    'customer_decision_recorded', 'expired', 'withdrawn', 'superseded'
  )),
  CONSTRAINT quote_events_from_status_check CHECK (
    from_status IS NULL OR from_status IN (
      'draft', 'awaiting_approval', 'approved', 'presented',
      'expired', 'superseded', 'withdrawn'
    )
  ),
  CONSTRAINT quote_events_to_status_check CHECK (to_status IN (
    'draft', 'awaiting_approval', 'approved', 'presented',
    'expired', 'superseded', 'withdrawn'
  )),
  CONSTRAINT quote_events_decision_check CHECK (
    customer_decision IS NULL OR customer_decision IN (
      'accepted', 'rejected_price', 'found_better_price', 'no_response',
      'cancelled_by_customer', 'other_lost'
    )
  ),
  CONSTRAINT quote_events_idempotency_check CHECK (
    length(idempotency_key) BETWEEN 1 AND 128
    AND idempotency_key ~ '^[A-Za-z0-9._:-]+$'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_quote_events_idempotency
  ON quote_events(account_id, quote_id, event_type, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_quote_events_quote_time
  ON quote_events(quote_id, occurred_at, id);

CREATE INDEX IF NOT EXISTS idx_quote_events_account_time
  ON quote_events(account_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION public.is_valid_quote_status_transition(
  p_from TEXT,
  p_to TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT p_from = p_to OR CASE p_from
    WHEN 'draft' THEN p_to IN ('awaiting_approval', 'approved', 'withdrawn', 'superseded')
    WHEN 'awaiting_approval' THEN p_to IN ('approved', 'withdrawn', 'superseded')
    WHEN 'approved' THEN p_to IN ('presented', 'expired', 'withdrawn', 'superseded')
    WHEN 'presented' THEN p_to IN ('expired', 'withdrawn', 'superseded')
    ELSE FALSE
  END;
$$;

CREATE OR REPLACE FUNCTION public.guard_quote_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_auth_user UUID := auth.uid();
  v_parent public.quotes%ROWTYPE;
  v_recommendation public.quotes%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF v_auth_user IS NOT NULL AND NEW.created_by_user_id <> v_auth_user THEN
      RAISE EXCEPTION 'quote creator must be the authenticated actor'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.origin = 'imported_historical'
       AND v_auth_user IS NOT NULL
       AND NOT public.is_account_member(NEW.account_id, 'admin') THEN
      RAISE EXCEPTION 'imported historical quotes require an admin'
        USING ERRCODE = '42501';
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.historical_cases c
      WHERE c.account_id = NEW.account_id
        AND c.enquiry_id = NEW.enquiry_id
        AND c.finalized_at IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'cannot attach a quote to a finalized historical case'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.origin IN ('ai_suggested', 'hybrid_engine')
       AND NEW.status <> 'awaiting_approval' THEN
      RAISE EXCEPTION 'AI and hybrid suggestions must await approval'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.origin IN ('manual', 'imported_historical')
       AND NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'manual and imported quotes must begin as drafts'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.customer_decision <> 'unknown'
       OR NEW.approved_at IS NOT NULL
       OR NEW.presented_at IS NOT NULL THEN
      RAISE EXCEPTION 'a new quote cannot be approved, presented, or decided'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.supersedes_quote_id IS NULL THEN
      IF NEW.revision_number <> 1 OR EXISTS (
        SELECT 1 FROM public.quotes q
        WHERE q.account_id = NEW.account_id
          AND q.enquiry_id = NEW.enquiry_id
      ) THEN
        RAISE EXCEPTION 'an initial quote must be revision 1 with no history'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      SELECT * INTO v_parent
      FROM public.quotes q
      WHERE q.id = NEW.supersedes_quote_id
        AND q.account_id = NEW.account_id;
      IF NOT FOUND
         OR v_parent.enquiry_id <> NEW.enquiry_id
         OR v_parent.revision_number + 1 <> NEW.revision_number
         OR v_parent.status <> 'superseded'
         OR v_parent.superseded_by_quote_id <> NEW.id THEN
        RAISE EXCEPTION 'quote revision does not match its superseded parent'
          USING ERRCODE = '23514';
      END IF;
    END IF;

    IF NEW.recommendation_quote_id IS NOT NULL THEN
      SELECT * INTO v_recommendation
      FROM public.quotes q
      WHERE q.id = NEW.recommendation_quote_id
        AND q.account_id = NEW.account_id;
      IF NOT FOUND
         OR v_recommendation.enquiry_id <> NEW.enquiry_id
         OR v_recommendation.origin NOT IN ('ai_suggested', 'hybrid_engine') THEN
        RAISE EXCEPTION 'recommendation must be an AI/hybrid quote for this enquiry'
          USING ERRCODE = '23514';
      END IF;
    END IF;

    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.historical_cases c
    WHERE c.account_id = NEW.account_id
      AND c.enquiry_id = NEW.enquiry_id
      AND c.finalized_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'cannot change a quote after its historical case is finalized'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.id IS DISTINCT FROM NEW.id
     OR OLD.account_id IS DISTINCT FROM NEW.account_id
     OR OLD.enquiry_id IS DISTINCT FROM NEW.enquiry_id
     OR OLD.revision_number IS DISTINCT FROM NEW.revision_number
     OR OLD.origin IS DISTINCT FROM NEW.origin
     OR OLD.currency IS DISTINCT FROM NEW.currency
     OR OLD.amount_type IS DISTINCT FROM NEW.amount_type
     OR OLD.fixed_amount_minor IS DISTINCT FROM NEW.fixed_amount_minor
     OR OLD.range_min_minor IS DISTINCT FROM NEW.range_min_minor
     OR OLD.range_max_minor IS DISTINCT FROM NEW.range_max_minor
     OR OLD.supersedes_quote_id IS DISTINCT FROM NEW.supersedes_quote_id
     OR OLD.recommendation_quote_id IS DISTINCT FROM NEW.recommendation_quote_id
     OR OLD.assumptions IS DISTINCT FROM NEW.assumptions
     OR OLD.exclusions IS DISTINCT FROM NEW.exclusions
     OR OLD.operator_notes IS DISTINCT FROM NEW.operator_notes
     OR OLD.source_reference IS DISTINCT FROM NEW.source_reference
     OR OLD.source_observed_at IS DISTINCT FROM NEW.source_observed_at
     OR OLD.override_reason IS DISTINCT FROM NEW.override_reason
     OR OLD.override_reason_note IS DISTINCT FROM NEW.override_reason_note
     OR OLD.created_by_user_id IS DISTINCT FROM NEW.created_by_user_id
     OR OLD.creation_idempotency_key IS DISTINCT FROM NEW.creation_idempotency_key
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'quote identity and commercial terms are immutable; create a revision'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.last_action_idempotency_key IS NULL
     OR NEW.last_action_by_user_id IS NULL
     OR NEW.last_action_idempotency_key IS NOT DISTINCT FROM OLD.last_action_idempotency_key THEN
    RAISE EXCEPTION 'every quote transition requires a new idempotency key and actor'
      USING ERRCODE = '23514';
  END IF;
  IF v_auth_user IS NOT NULL AND NEW.last_action_by_user_id <> v_auth_user THEN
    RAISE EXCEPTION 'quote transition actor must be the authenticated actor'
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_valid_quote_status_transition(OLD.status, NEW.status) THEN
    RAISE EXCEPTION 'invalid quote lifecycle transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;

  IF OLD.customer_decision <> 'unknown'
     AND NOT (
       OLD.status = 'presented'
       AND NEW.status = 'superseded'
       AND NEW.customer_decision = OLD.customer_decision
     ) THEN
    RAISE EXCEPTION 'a decided quote is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status IS DISTINCT FROM NEW.status THEN
    IF NEW.status = 'approved' THEN
      IF NEW.approved_at IS NULL OR NEW.approved_by_user_id <> NEW.last_action_by_user_id
         OR NEW.presented_at IS NOT NULL THEN
        RAISE EXCEPTION 'approval metadata is incomplete'
          USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.status = 'presented' THEN
      IF OLD.status <> 'approved'
         OR NEW.approved_at IS NULL
         OR NEW.presented_at IS NULL
         OR NEW.presented_by_user_id <> NEW.last_action_by_user_id THEN
        RAISE EXCEPTION 'presentation requires a prior approval and actor metadata'
          USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.status = 'superseded' THEN
      IF NEW.superseded_by_quote_id IS NULL THEN
        RAISE EXCEPTION 'a superseded quote must identify its successor'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  IF NEW.status <> 'approved'
     AND (
       OLD.approved_at IS DISTINCT FROM NEW.approved_at
       OR OLD.approved_by_user_id IS DISTINCT FROM NEW.approved_by_user_id
     ) THEN
    RAISE EXCEPTION 'approval metadata may only change during approval'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> 'presented'
     AND (
       OLD.presented_at IS DISTINCT FROM NEW.presented_at
       OR OLD.presented_by_user_id IS DISTINCT FROM NEW.presented_by_user_id
     ) THEN
    RAISE EXCEPTION 'presentation metadata may only change during presentation'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> 'superseded'
     AND OLD.superseded_by_quote_id IS DISTINCT FROM NEW.superseded_by_quote_id THEN
    RAISE EXCEPTION 'successor metadata may only change during revision'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.customer_decision IS DISTINCT FROM NEW.customer_decision THEN
    IF OLD.status <> 'presented'
       OR NEW.status <> 'presented'
       OR NEW.customer_decision = 'unknown'
       OR NEW.decision_recorded_at IS NULL
       OR NEW.decision_recorded_by_user_id <> NEW.last_action_by_user_id THEN
      RAISE EXCEPTION 'customer decisions can only be recorded once on a presented quote'
        USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.decision_recorded_at IS DISTINCT FROM NEW.decision_recorded_at
     OR OLD.decision_recorded_by_user_id IS DISTINCT FROM NEW.decision_recorded_by_user_id
     OR OLD.decision_note IS DISTINCT FROM NEW.decision_note THEN
    RAISE EXCEPTION 'customer decision metadata is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status IS NOT DISTINCT FROM NEW.status
     AND OLD.customer_decision IS NOT DISTINCT FROM NEW.customer_decision THEN
    RAISE EXCEPTION 'quote update did not perform a lifecycle transition'
      USING ERRCODE = '23514';
  END IF;

  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.audit_quote_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_event_type TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.quote_events (
      account_id, quote_id, event_type, from_status, to_status,
      customer_decision, actor_user_id, idempotency_key, occurred_at
    ) VALUES (
      NEW.account_id, NEW.id, 'created', NULL, NEW.status,
      NULL, NEW.created_by_user_id, NEW.creation_idempotency_key, NEW.created_at
    );
    RETURN NEW;
  END IF;

  IF OLD.status IS DISTINCT FROM NEW.status THEN
    v_event_type := CASE NEW.status
      WHEN 'awaiting_approval' THEN 'awaiting_approval'
      WHEN 'approved' THEN 'approved'
      WHEN 'presented' THEN 'presented'
      WHEN 'expired' THEN 'expired'
      WHEN 'withdrawn' THEN 'withdrawn'
      WHEN 'superseded' THEN 'superseded'
      ELSE NULL
    END;
    IF v_event_type IS NOT NULL THEN
      INSERT INTO public.quote_events (
        account_id, quote_id, event_type, from_status, to_status,
        customer_decision, actor_user_id, idempotency_key, occurred_at
      ) VALUES (
        NEW.account_id, NEW.id, v_event_type, OLD.status, NEW.status,
        NULL, NEW.last_action_by_user_id, NEW.last_action_idempotency_key, NOW()
      );
    END IF;
  END IF;

  IF OLD.customer_decision IS DISTINCT FROM NEW.customer_decision THEN
    INSERT INTO public.quote_events (
      account_id, quote_id, event_type, from_status, to_status,
      customer_decision, actor_user_id, idempotency_key, occurred_at
    ) VALUES (
      NEW.account_id, NEW.id, 'customer_decision_recorded', OLD.status, NEW.status,
      NEW.customer_decision, NEW.last_action_by_user_id,
      NEW.last_action_idempotency_key, NEW.decision_recorded_at
    );
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_quote_event_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF pg_trigger_depth() < 2 THEN
      RAISE EXCEPTION 'quote events may only be written by the quote audit trigger'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'quote events are immutable' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.quotes q
    WHERE q.id = OLD.quote_id AND q.account_id = OLD.account_id
  ) THEN
    RAISE EXCEPTION 'quote events are append-only' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS guard_quote_write ON quotes;
CREATE TRIGGER guard_quote_write
  BEFORE INSERT OR UPDATE ON quotes
  FOR EACH ROW EXECUTE FUNCTION public.guard_quote_write();

DROP TRIGGER IF EXISTS audit_quote_transition ON quotes;
CREATE TRIGGER audit_quote_transition
  AFTER INSERT OR UPDATE ON quotes
  FOR EACH ROW EXECUTE FUNCTION public.audit_quote_transition();

DROP TRIGGER IF EXISTS guard_quote_event_write ON quote_events;
CREATE TRIGGER guard_quote_event_write
  BEFORE INSERT OR UPDATE OR DELETE ON quote_events
  FOR EACH ROW EXECUTE FUNCTION public.guard_quote_event_write();

CREATE OR REPLACE FUNCTION public.quote_create_revision(
  p_account_id UUID,
  p_quote_id UUID,
  p_actor_user_id UUID,
  p_idempotency_key TEXT,
  p_origin TEXT,
  p_recommendation_quote_id UUID,
  p_currency TEXT,
  p_amount_type TEXT,
  p_fixed_amount_minor BIGINT,
  p_range_min_minor BIGINT,
  p_range_max_minor BIGINT,
  p_assumptions TEXT[],
  p_exclusions TEXT[],
  p_operator_notes TEXT,
  p_source_reference TEXT,
  p_source_observed_at TIMESTAMPTZ,
  p_override_reason TEXT,
  p_override_reason_note TEXT
)
RETURNS public.quotes
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_parent public.quotes%ROWTYPE;
  v_existing public.quotes%ROWTYPE;
  v_created public.quotes%ROWTYPE;
  v_new_id UUID := gen_random_uuid();
  v_initial_status TEXT;
BEGIN
  SELECT * INTO v_existing
  FROM public.quotes q
  WHERE q.account_id = p_account_id
    AND q.creation_idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.supersedes_quote_id <> p_quote_id THEN
      RAISE EXCEPTION 'idempotency key belongs to another quote action'
        USING ERRCODE = '23505';
    END IF;
    RETURN v_existing;
  END IF;

  -- Locks the enquiry's quote lineage, not merely one revision. Two agents
  -- revising concurrently therefore serialize before either chooses n + 1.
  SELECT q.* INTO v_parent
  FROM public.quotes q
  JOIN public.enquiries e
    ON e.id = q.enquiry_id AND e.account_id = q.account_id
  WHERE q.id = p_quote_id
    AND q.account_id = p_account_id
  FOR UPDATE OF e, q;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'quote not found' USING ERRCODE = 'P0001';
  END IF;
  IF v_parent.status NOT IN ('draft', 'awaiting_approval', 'approved', 'presented')
     OR v_parent.superseded_by_quote_id IS NOT NULL THEN
    RAISE EXCEPTION 'quote is not revisable' USING ERRCODE = 'P0001';
  END IF;

  v_initial_status := CASE
    WHEN p_origin IN ('ai_suggested', 'hybrid_engine') THEN 'awaiting_approval'
    ELSE 'draft'
  END;

  UPDATE public.quotes
  SET status = 'superseded',
      superseded_by_quote_id = v_new_id,
      last_action_idempotency_key = p_idempotency_key,
      last_action_by_user_id = p_actor_user_id
  WHERE id = v_parent.id AND account_id = p_account_id;

  INSERT INTO public.quotes (
    id, account_id, enquiry_id, revision_number, status, customer_decision,
    origin, currency, amount_type, fixed_amount_minor, range_min_minor,
    range_max_minor, supersedes_quote_id, recommendation_quote_id,
    assumptions, exclusions, operator_notes, source_reference,
    source_observed_at, override_reason, override_reason_note,
    created_by_user_id, creation_idempotency_key
  ) VALUES (
    v_new_id, p_account_id, v_parent.enquiry_id, v_parent.revision_number + 1,
    v_initial_status, 'unknown', p_origin, p_currency, p_amount_type,
    p_fixed_amount_minor, p_range_min_minor, p_range_max_minor, v_parent.id,
    p_recommendation_quote_id, COALESCE(p_assumptions, ARRAY[]::TEXT[]),
    COALESCE(p_exclusions, ARRAY[]::TEXT[]), p_operator_notes,
    p_source_reference, p_source_observed_at, p_override_reason,
    p_override_reason_note, p_actor_user_id, p_idempotency_key
  ) RETURNING * INTO v_created;

  RETURN v_created;
END;
$$;

ALTER TABLE quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE quote_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS quotes_select ON quotes;
CREATE POLICY quotes_select ON quotes FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS quotes_insert ON quotes;
CREATE POLICY quotes_insert ON quotes FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS quotes_update ON quotes;
CREATE POLICY quotes_update ON quotes FOR UPDATE
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS quote_events_select ON quote_events;
CREATE POLICY quote_events_select ON quote_events FOR SELECT
  USING (is_account_member(account_id));

-- No authenticated DELETE policy on either table and no direct event INSERT
-- policy. Events are written only by the quote trigger.

-- Historical cases now prefer canonical quote evidence whenever a quote row
-- exists for the enquiry. Legacy commercial facts remain readable for cases
-- created before this migration; final collected amount remains a case fact.
CREATE OR REPLACE FUNCTION public.historical_case_evidence_supports_tier(
  p_case_id UUID,
  p_tier TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH case_row AS (
    SELECT c.id, c.enquiry_id, c.completed_at
    FROM public.historical_cases c
    WHERE c.id = p_case_id
  ), canonical AS (
    SELECT
      EXISTS (
        SELECT 1 FROM public.quotes q JOIN case_row c ON c.enquiry_id = q.enquiry_id
      ) AS exists,
      EXISTS (
        SELECT 1 FROM public.quotes q JOIN case_row c ON c.enquiry_id = q.enquiry_id
        WHERE q.origin IN ('ai_suggested', 'hybrid_engine')
      ) AS has_ai,
      EXISTS (
        SELECT 1 FROM public.quotes q JOIN case_row c ON c.enquiry_id = q.enquiry_id
        WHERE q.approved_at IS NOT NULL OR q.presented_at IS NOT NULL
      ) AS has_human,
      (SELECT q.customer_decision
       FROM public.quotes q JOIN case_row c ON c.enquiry_id = q.enquiry_id
       ORDER BY q.revision_number DESC LIMIT 1) AS decision
  ), legacy AS (
    SELECT
      EXISTS (
        SELECT 1 FROM public.historical_case_facts f
        WHERE f.case_id = p_case_id
          AND f.fact_key = 'ai_suggested_amount'
          AND f.provenance = 'ai_suggested'
      ) AS has_ai,
      EXISTS (
        SELECT 1 FROM public.historical_case_facts f
        WHERE f.case_id = p_case_id
          AND public.historical_case_human_quote_key(f.fact_key)
      ) AS has_human,
      (SELECT f.value_text FROM public.historical_case_facts f
       WHERE f.case_id = p_case_id AND f.fact_key = 'quote_decision'
       LIMIT 1) AS decision
  ), evidence AS (
    SELECT
      CASE WHEN canonical.exists THEN canonical.has_ai ELSE legacy.has_ai END AS has_ai,
      CASE WHEN canonical.exists THEN canonical.has_human ELSE legacy.has_human END AS has_human,
      CASE
        WHEN canonical.exists THEN NULLIF(canonical.decision, 'unknown')
        ELSE legacy.decision
      END AS decision
    FROM canonical CROSS JOIN legacy
  )
  SELECT CASE p_tier
    WHEN 'A' THEN
      EXISTS (SELECT 1 FROM case_row WHERE completed_at IS NOT NULL)
      AND EXISTS (
        SELECT 1 FROM public.historical_case_facts f
        WHERE f.case_id = p_case_id
          AND f.fact_key = 'final_amount_collected'
          AND f.provenance = 'confirmed_outcome'
      )
    WHEN 'B' THEN EXISTS (SELECT 1 FROM evidence WHERE decision = 'accepted')
    WHEN 'C' THEN EXISTS (
      SELECT 1 FROM evidence WHERE has_human AND decision = 'accepted'
    )
    WHEN 'D' THEN EXISTS (SELECT 1 FROM evidence WHERE has_human)
    WHEN 'E' THEN EXISTS (
      SELECT 1 FROM evidence WHERE has_ai AND NOT has_human
    ) AND NOT EXISTS (
      SELECT 1 FROM public.historical_case_facts f
      WHERE f.case_id = p_case_id AND f.provenance = 'confirmed_outcome'
    )
    WHEN 'F' THEN NOT EXISTS (
      SELECT 1 FROM public.historical_case_facts f
      WHERE f.case_id = p_case_id AND f.provenance = 'confirmed_outcome'
    )
    ELSE FALSE
  END;
$$;

ALTER FUNCTION public.is_valid_quote_status_transition(TEXT, TEXT) OWNER TO postgres;
ALTER FUNCTION public.quote_text_array_valid(TEXT[]) OWNER TO postgres;
ALTER FUNCTION public.guard_quote_write() OWNER TO postgres;
ALTER FUNCTION public.audit_quote_transition() OWNER TO postgres;
ALTER FUNCTION public.guard_quote_event_write() OWNER TO postgres;
ALTER FUNCTION public.quote_create_revision(
  UUID, UUID, UUID, TEXT, TEXT, UUID, TEXT, TEXT, BIGINT, BIGINT, BIGINT,
  TEXT[], TEXT[], TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT
) OWNER TO postgres;
ALTER FUNCTION public.historical_case_evidence_supports_tier(UUID, TEXT) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.is_valid_quote_status_transition(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_valid_quote_status_transition(TEXT, TEXT)
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.quote_text_array_valid(TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.quote_text_array_valid(TEXT[])
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.quote_create_revision(
  UUID, UUID, UUID, TEXT, TEXT, UUID, TEXT, TEXT, BIGINT, BIGINT, BIGINT,
  TEXT[], TEXT[], TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.quote_create_revision(
  UUID, UUID, UUID, TEXT, TEXT, UUID, TEXT, TEXT, BIGINT, BIGINT, BIGINT,
  TEXT[], TEXT[], TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT
) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.guard_quote_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.audit_quote_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_quote_event_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.historical_case_evidence_supports_tier(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.historical_case_evidence_supports_tier(UUID, TEXT)
  TO authenticated, service_role;
