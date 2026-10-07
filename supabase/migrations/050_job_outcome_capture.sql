-- ============================================================
-- 050_job_outcome_capture.sql - the operational completion /
-- lost-business capture path for historical cases.
--
-- Roadmap objective 02 (Job Outcome Capture), building on the
-- historical case model from 049.
--
-- 049 deliberately left the outcome side of the case model inert:
-- the fact keys for actual load, actual disposal weight, actual
-- labour, crew count, and final notes existed, but nothing could
-- write them, there was no completed-job workflow, and there was no
-- finalization entry point. This migration opens that path without
-- inventing a job, quote, payment, or booking entity.
--
-- What this migration adds:
--
--   1. A `timestamp` fact value kind and `arrival_at` / `departed_at`
--      keys, so on-site timing is a provenance-carrying fact rather
--      than a duplicated column on the case row.
--   2. `actual_dismantling_required`, `scope_change_type` and
--      `final_operational_outcome`: the operational facts that only
--      exist after the crew leaves.
--   3. An extended commercial-outcome vocabulary on `quote_decision`
--      so an explicit price rejection, "found a better price", a
--      no-response and a customer cancellation are four different
--      recorded facts instead of one "rejected".
--   4. `historical_case_derive_labour_minutes`, a pure derivation of
--      `actual_labour_minutes` from the two timestamps, enforced in a
--      trigger so a hand-typed duration cannot contradict them.
--   5. A narrow, explicit post-finalization correction window: a
--      finalized case is frozen learning truth, and the ONE thing that
--      may still change is that it stops being training evidence.
--   6. A unique index that makes the finalization snapshots (one per
--      kind per case) idempotent in the database rather than only in
--      application code.
--
-- What this migration deliberately does NOT add:
--
--   * No embeddings, no vector column, no similarity search.
--   * No quote calculation, no learned pricing, no booking.
--   * No automatic finalization. Nothing here runs by itself; a human
--     captures an outcome and a human finalizes the case.
--   * No way for an AI suggestion to become a completed-job label.
--     The provenance rules from 049 are widened to the new keys with
--     the same verdict: `ai_suggested` is forbidden on every
--     post-job, operator-judgement and customer-decision key.
--
-- Idempotent and additive. Idempotent with respect to replaying this
-- migration on a database that already has 049 applied.
-- ============================================================

-- ============================================================
-- 1. A TIMESTAMP IS A FACT VALUE KIND
--
-- Arrival and departure are the only two facts in the vocabulary
-- that are neither text, a number, nor a boolean. Adding them as a
-- column pair on `historical_cases` would have moved operator
-- judgement out of the provenance-carrying fact table and onto the
-- identity row, which is the one row that is frozen at
-- finalization and therefore the one row a correction could not
-- reach. They are facts, so they go in with everything else.
-- ============================================================

ALTER TABLE historical_case_facts
  ADD COLUMN IF NOT EXISTS value_timestamp TIMESTAMPTZ;

-- ============================================================
-- 2. FINALIZATION SNAPSHOTS ARE UNIQUE, AND A CORRECTION IS ITS OWN KIND
--
-- `correction` records that a finalized case was withdrawn from
-- training after the fact. It is deliberately repeatable (a case can
-- be excluded, reviewed, and excluded again with a different reason),
-- so it is excluded from the uniqueness rule below.
-- ============================================================

-- 049 declared the vocabulary as an inline column CHECK, so Postgres
-- named it `historical_case_snapshots_snapshot_kind_check`. Both that
-- name and the explicit one this migration installs are dropped, so the
-- statement is correct both on a fresh replay and on a database where
-- this migration has already run once.
ALTER TABLE historical_case_snapshots
  DROP CONSTRAINT IF EXISTS historical_case_snapshots_snapshot_kind_check;

ALTER TABLE historical_case_snapshots
  DROP CONSTRAINT IF EXISTS historical_case_snapshots_kind_check;

ALTER TABLE historical_case_snapshots
  ADD CONSTRAINT historical_case_snapshots_kind_check CHECK (
    snapshot_kind IN (
      'evidence_classification', 'enquiry_facts', 'image_analysis',
      'commercial', 'outcome', 'correction'
    )
  );

-- One frozen truth per finalization kind per case. This is what makes
-- finalization idempotent in the database: a replayed or concurrent
-- finalize cannot append a second "outcome" snapshot, so the training
-- example can never be ambiguous about what it was built from.
-- `evidence_classification` and `correction` are intentionally
-- repeatable and stay outside this index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_historical_case_snapshots_one_finalization
  ON historical_case_snapshots(case_id, snapshot_kind)
  WHERE snapshot_kind IN (
    'enquiry_facts', 'image_analysis', 'commercial', 'outcome'
  );

-- The lost-business population is selected by decision value, so the
-- decision read path gets its own index rather than relying on the
-- per-case index. `id_historical_case_facts_account_provenance`
-- (049) covers provenance reads; this covers value reads.
CREATE INDEX IF NOT EXISTS idx_historical_case_facts_account_decision
  ON historical_case_facts(account_id, value_text)
  WHERE fact_key = 'quote_decision';

-- ============================================================
-- 3. EXTENDED FACT VOCABULARY
--
-- Five keys are added. Everything else in the vocabulary is reused
-- as-is, because 049 already modelled final_amount_collected,
-- actual_load_units, actual_disposal_weight_kg, crew_count,
-- actual_labour_minutes, scope_changed, scope_change_reason,
-- outcome_no_show and final_job_notes correctly.
-- ============================================================

CREATE OR REPLACE FUNCTION public.historical_case_fact_kind(p_key TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_key
    -- Canonical `enquiries` columns. Annotated, never copied.
    WHEN 'customer_intent'       THEN 'canonical:text'
    WHEN 'postcode'              THEN 'canonical:text'
    WHEN 'address'               THEN 'canonical:text'
    WHEN 'property_type'         THEN 'canonical:text'
    WHEN 'floor'                 THEN 'canonical:text'
    WHEN 'lift_available'        THEN 'canonical:boolean'
    WHEN 'parking'               THEN 'canonical:text'
    WHEN 'access_constraints'    THEN 'canonical:text'
    WHEN 'item_descriptions'     THEN 'canonical:text'
    WHEN 'waste_type'            THEN 'canonical:text'
    WHEN 'estimated_volume'      THEN 'canonical:text'
    WHEN 'heavy_special_items'   THEN 'canonical:text'
    WHEN 'photos_received'       THEN 'canonical:boolean'
    -- Captured learning facts with no canonical home.
    WHEN 'service_type'                  THEN 'text'
    WHEN 'quote_decision'                THEN 'text'
    WHEN 'quote_adjustment_reason'       THEN 'text'
    WHEN 'final_operational_outcome'     THEN 'text'
    WHEN 'scope_change_type'             THEN 'text'
    WHEN 'scope_change_reason'           THEN 'text'
    WHEN 'final_job_notes'               THEN 'text'
    WHEN 'carry_distance_metres'         THEN 'integer'
    WHEN 'item_count'                    THEN 'integer'
    WHEN 'travel_time_minutes'           THEN 'integer'
    WHEN 'crew_count'                    THEN 'integer'
    WHEN 'estimated_labour_minutes'      THEN 'integer'
    WHEN 'actual_labour_minutes'         THEN 'integer'
    WHEN 'arrival_at'                    THEN 'timestamp'
    WHEN 'departed_at'                   THEN 'timestamp'
    WHEN 'estimated_load_units'          THEN 'number'
    WHEN 'actual_load_units'             THEN 'number'
    WHEN 'actual_disposal_weight_kg'     THEN 'number'
    WHEN 'travel_distance_km'            THEN 'number'
    WHEN 'ai_suggested_amount'           THEN 'number'
    WHEN 'human_approved_amount'         THEN 'number'
    WHEN 'customer_facing_quote_amount'  THEN 'number'
    WHEN 'final_amount_collected'        THEN 'number'
    WHEN 'quote_adjustment_amount'       THEN 'number'
    WHEN 'dismantling_required'          THEN 'boolean'
    WHEN 'actual_dismantling_required'   THEN 'boolean'
    WHEN 'outcome_no_show'               THEN 'boolean'
    WHEN 'scope_changed'                 THEN 'boolean'
    ELSE NULL
  END;
$$;

-- Provenance classes that may describe a confirmed, post-job fact.
--
-- Widened with the two on-site timestamps: they can only be known
-- once somebody is standing at the property. `actual_dismantling_required`,
-- `scope_change_type` and `final_operational_outcome` are deliberately
-- NOT here - they are operator judgements about what happened, not
-- measurements of it, so `operator_entered` is their honest
-- provenance and `confirmed_outcome` stays reserved for measured
-- ground truth.
CREATE OR REPLACE FUNCTION public.historical_case_confirmed_outcome_key(p_key TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_key IN (
    'final_amount_collected',
    'actual_load_units',
    'actual_disposal_weight_kg',
    'actual_labour_minutes',
    'arrival_at',
    'departed_at',
    'scope_change_reason',
    'final_job_notes'
  );
$$;

-- Shape and provenance compatibility for one fact row.
--
-- The 8th parameter is new (p_value_timestamp). The CHECK constraint
-- that depends on this function is therefore dropped and rebuilt
-- below; Postgres resolves a CHECK against the function OID, so a
-- plain CREATE OR REPLACE with a changed signature would fail.
CREATE OR REPLACE FUNCTION public.historical_case_fact_shape_valid(
  p_key TEXT,
  p_value_source TEXT,
  p_value_text TEXT,
  p_value_number NUMERIC,
  p_value_integer INTEGER,
  p_value_boolean BOOLEAN,
  p_value_timestamp TIMESTAMPTZ,
  p_provenance TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  WITH kind AS (
    SELECT public.historical_case_fact_kind(p_key) AS k
  ), shape AS (
    SELECT
      kind.k,
      (p_value_text IS NOT NULL)::int
        + (p_value_number IS NOT NULL)::int
        + (p_value_integer IS NOT NULL)::int
        + (p_value_boolean IS NOT NULL)::int
        + (p_value_timestamp IS NOT NULL)::int AS set_count,
      public.historical_case_confirmed_outcome_key(p_key) AS confirmed_ok,
      public.historical_case_human_quote_key(p_key) AS human_quote,
      p_key IN (
        'final_amount_collected', 'actual_load_units',
        'actual_disposal_weight_kg', 'actual_labour_minutes',
        'arrival_at', 'departed_at',
        'quote_decision', 'final_job_notes', 'scope_changed',
        'scope_change_type', 'scope_change_reason', 'outcome_no_show',
        'final_operational_outcome', 'actual_dismantling_required',
        'human_approved_amount', 'customer_facing_quote_amount',
        'quote_adjustment_amount', 'quote_adjustment_reason'
      ) AS ai_forbidden
    FROM kind
  )
  SELECT shape.k IS NOT NULL
    AND (
      (shape.k LIKE 'canonical:%'
        AND p_value_source = 'canonical'
        AND shape.set_count = 0)
      OR
      (shape.k NOT LIKE 'canonical:%'
        AND p_value_source = 'captured'
        AND shape.set_count = 1
        AND (
          (shape.k = 'text' AND p_value_text IS NOT NULL
            AND length(btrim(p_value_text)) BETWEEN 1 AND 2000)
          OR (shape.k = 'integer' AND p_value_integer IS NOT NULL
            AND p_value_integer BETWEEN -1000000 AND 1000000)
          OR (shape.k = 'number' AND p_value_number IS NOT NULL
            AND p_value_number BETWEEN -1000000000 AND 1000000000)
          OR (shape.k = 'boolean' AND p_value_boolean IS NOT NULL)
          OR (shape.k = 'timestamp' AND p_value_timestamp IS NOT NULL)
        ))
    )
    -- A commercial decision is a closed vocabulary, not free text.
    --
    -- The loss values are deliberately distinct rather than one
    -- "rejected": `no_response` is silence and establishes nothing
    -- about the correct price, `rejected_price` is an explicit
    -- statement that the number was too high, and
    -- `found_better_price` is a statement the customer actually
    -- supplied a competing number. `rejected` is retained because
    -- 049 already allowed it and historical rows may carry it.
    AND (p_key <> 'quote_decision'
      OR (p_value_text IN (
            'accepted', 'rejected', 'rejected_price', 'found_better_price',
            'no_response', 'cancelled_by_customer', 'other_lost',
            'pending', 'unknown'
          )))
    -- The final operational outcome and the scope change are operator
    -- judgements about the day, so both are closed vocabularies too.
    AND (p_key <> 'final_operational_outcome'
      OR (p_value_text IN (
            'completed', 'partially_completed', 'cancelled_on_arrival',
            'no_show'
          )))
    AND (p_key <> 'scope_change_type'
      OR (p_value_text IN (
            'no_material_change', 'more_waste_than_expected',
            'less_waste_than_expected', 'access_harder_than_expected',
            'access_easier_than_expected', 'customer_added_work',
            'customer_removed_work', 'other'
          )))
    -- AI output is a prediction: it may never describe a confirmed
    -- outcome, a human-issued quote, or a customer decision.
    AND (p_provenance <> 'ai_suggested' OR NOT shape.ai_forbidden)
    AND (p_key <> 'ai_suggested_amount' OR p_provenance = 'ai_suggested')
    -- Only a post-job fact can be a confirmed outcome.
    AND (p_provenance <> 'confirmed_outcome' OR shape.confirmed_ok)
  FROM shape;
$$;

-- The fact shape constraint has to be rebuilt against the new
-- signature. Order matters: drop the constraint, drop the old
-- function, create the new one, then re-add the constraint.
ALTER TABLE historical_case_facts
  DROP CONSTRAINT IF EXISTS historical_case_facts_shape_check;

DROP FUNCTION IF EXISTS public.historical_case_fact_shape_valid(
  TEXT, TEXT, TEXT, NUMERIC, INTEGER, BOOLEAN, TEXT
);

ALTER TABLE historical_case_facts
  ADD CONSTRAINT historical_case_facts_shape_check CHECK (
    public.historical_case_fact_shape_valid(
      fact_key, value_source, value_text, value_number,
      value_integer, value_boolean, value_timestamp, provenance
    )
  );

-- ============================================================
-- 4. DERIVED LABOUR DURATION
--
-- `actual_labour_minutes` is not a measurement anybody takes with a
-- stopwatch on the way out of the job; it is the difference between
-- two timestamps. Making that derivation one pure, immutable function
-- is what lets the trigger below insist that a recorded duration
-- agrees with the timestamps it claims to come from, on every write
-- path, including a service-role write.
--
-- Truncating towards zero (not rounding) is deliberate: it is the one
-- behaviour that both the SQL and the TypeScript twin agree on
-- without a half-up rule, so a duration can never be accepted by one
-- layer and rejected by the other.
--
-- Unknown stays unknown. One missing timestamp yields NULL, and NULL
-- is not zero minutes.
-- ============================================================

CREATE OR REPLACE FUNCTION public.historical_case_derive_labour_minutes(
  p_arrival_at TIMESTAMPTZ,
  p_departed_at TIMESTAMPTZ
)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_arrival_at IS NULL OR p_departed_at IS NULL THEN NULL
    WHEN p_departed_at <= p_arrival_at THEN NULL
    ELSE GREATEST(
      0,
      FLOOR(EXTRACT(EPOCH FROM (p_departed_at - p_arrival_at)) / 60.0)
    )::INTEGER
  END;
$$;

-- ============================================================
-- 5. FACT WRITE GUARD
--
-- 049's guard is reproduced with one extra rule: a recorded
-- `actual_labour_minutes` must equal the duration derived from the
-- case's own `arrival_at` / `departed_at` facts. Without this, "90
-- minutes on site" and "09:00 to 10:45" could both be true in the
-- same row set and a future learning pipeline would have no way to
-- know which one to believe.
--
-- The rule is deliberately one-directional. It is not applied to a
-- write of `arrival_at` / `departed_at`, because a correction is
-- exactly the case where they change: blocking the timestamp until
-- the derived duration was also updated would make an operator who
-- mistyped 17:00 for 16:30 unable to correct it. The capture service
-- closes that instead by always rewriting the derived duration in the
-- same call that writes the timestamps, so the two cannot drift apart
-- through any workflow WACRM actually runs.
-- ============================================================

CREATE OR REPLACE FUNCTION public.guard_historical_case_fact_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_finalized TIMESTAMPTZ;
  v_stored_arrival TIMESTAMPTZ;
  v_stored_departed TIMESTAMPTZ;
  v_effective_arrival TIMESTAMPTZ;
  v_effective_departed TIMESTAMPTZ;
  v_expected_minutes INTEGER;
BEGIN
  -- `messages` carries no account_id (migration 017 reaches it through its
  -- parent conversation), so the cross-account boundary is checked here
  -- instead of by a composite foreign key.
  IF NEW.source_message_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.messages m
    JOIN public.conversations c ON c.id = m.conversation_id
    WHERE m.id = NEW.source_message_id
      AND c.account_id = NEW.account_id
  ) THEN
    RAISE EXCEPTION 'source_message_id does not belong to this account'
      USING ERRCODE = '23503';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT c.finalized_at INTO v_finalized
    FROM public.historical_cases c
    WHERE c.id = NEW.case_id AND c.account_id = NEW.account_id;

    IF v_finalized IS NOT NULL THEN
      RAISE EXCEPTION 'facts of a finalized historical case are immutable'
        USING ERRCODE = '23514';
    END IF;

    NEW.created_at := NOW();
    NEW.updated_at := NEW.created_at;
  ELSE
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.account_id IS DISTINCT FROM OLD.account_id
       OR NEW.case_id IS DISTINCT FROM OLD.case_id
       OR NEW.fact_key IS DISTINCT FROM OLD.fact_key
       OR NEW.value_source IS DISTINCT FROM OLD.value_source
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'historical case fact identity is immutable'
        USING ERRCODE = '23514';
    END IF;

    SELECT c.finalized_at INTO v_finalized
    FROM public.historical_cases c
    WHERE c.id = NEW.case_id AND c.account_id = NEW.account_id;

    IF v_finalized IS NOT NULL THEN
      RAISE EXCEPTION 'facts of a finalized historical case are immutable'
        USING ERRCODE = '23514';
    END IF;

    NEW.updated_at := NOW();
  END IF;

  -- ------------------------------------------------------------
  -- Labour duration must agree with the timestamps.
  -- ------------------------------------------------------------
  IF NEW.fact_key IN ('arrival_at', 'departed_at', 'actual_labour_minutes') THEN
    SELECT
      MAX(f.value_timestamp) FILTER (WHERE f.fact_key = 'arrival_at'),
      MAX(f.value_timestamp) FILTER (WHERE f.fact_key = 'departed_at')
    INTO v_stored_arrival, v_stored_departed
    FROM public.historical_case_facts f
    WHERE f.case_id = NEW.case_id
      AND f.fact_key IN ('arrival_at', 'departed_at');

    -- The row being written is not in the table yet (BEFORE trigger), so
    -- its own timestamp is folded in explicitly.
    v_effective_arrival := CASE
      WHEN NEW.fact_key = 'arrival_at' THEN NEW.value_timestamp
      ELSE v_stored_arrival
    END;
    v_effective_departed := CASE
      WHEN NEW.fact_key = 'departed_at' THEN NEW.value_timestamp
      ELSE v_stored_departed
    END;

    v_expected_minutes := public.historical_case_derive_labour_minutes(
      v_effective_arrival, v_effective_departed
    );

    IF NEW.fact_key = 'actual_labour_minutes' THEN
      IF v_expected_minutes IS DISTINCT FROM NEW.value_integer THEN
        RAISE EXCEPTION
          'actual_labour_minutes must equal the duration derived from arrival_at and departed_at'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- ============================================================
-- 6. CASE WRITE GUARD
--
-- 049 froze a finalized case completely. That is right for the
-- learning facts, but it left one hole: `learning_eligibility` is the
-- only mechanism Objective 01 designed for withholding a case from
-- training, and it was the one field a frozen row could not reach.
-- A bad or unconsented case would therefore be stuck in the dataset
-- forever.
--
-- The fix is deliberately narrow rather than a versioning framework:
-- exactly three columns may change on a finalized case, the new
-- state must be `excluded` with a reason and a basis (or `included`
-- again, when the exclusion was itself the mistake), and the caller
-- is required to append an immutable `correction` snapshot saying
-- what was withdrawn. Nothing the case said can change, so no
-- training example can be silently rewritten.
-- ============================================================

CREATE OR REPLACE FUNCTION public.guard_historical_case_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_enquiry_conversation UUID;
  v_conversation_contact UUID;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- The denormalised references must agree with the enquiry and the
    -- conversation they claim to come from. Composite foreign keys prove
    -- account ownership; this proves internal consistency, which no
    -- foreign key can.
    SELECT e.conversation_id INTO v_enquiry_conversation
    FROM public.enquiries e
    WHERE e.id = NEW.enquiry_id AND e.account_id = NEW.account_id;

    IF v_enquiry_conversation IS NULL THEN
      RAISE EXCEPTION 'historical case enquiry not found in this account'
        USING ERRCODE = '23503';
    END IF;
    IF v_enquiry_conversation IS DISTINCT FROM NEW.conversation_id THEN
      RAISE EXCEPTION 'historical case conversation must match its enquiry'
        USING ERRCODE = '23514';
    END IF;

    SELECT c.contact_id INTO v_conversation_contact
    FROM public.conversations c
    WHERE c.id = NEW.conversation_id AND c.account_id = NEW.account_id;

    IF v_conversation_contact IS NULL THEN
      RAISE EXCEPTION 'historical case conversation not found in this account'
        USING ERRCODE = '23503';
    END IF;
    IF v_conversation_contact IS DISTINCT FROM NEW.contact_id THEN
      RAISE EXCEPTION 'historical case contact must match its conversation'
        USING ERRCODE = '23514';
    END IF;

    NEW.created_at := NOW();
    NEW.updated_at := NEW.created_at;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.enquiry_id IS DISTINCT FROM OLD.enquiry_id
     OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
     OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
     OR NEW.source_kind IS DISTINCT FROM OLD.source_kind
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'historical case identity is immutable'
      USING ERRCODE = '23514';
  END IF;

  -- Attribution follows the same rule as enquiries: it may only be lost
  -- when the referenced auth user is deleted.
  IF NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
     AND NOT (
       NEW.created_by_user_id IS NULL AND pg_trigger_depth() > 1
     ) THEN
    RAISE EXCEPTION 'created_by_user_id cannot be reassigned'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.finalized_at IS NOT NULL THEN
    -- Frozen learning truth. Everything the case SAYS is immutable.
    IF NEW.case_state IS DISTINCT FROM OLD.case_state
       OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
       OR NEW.evidence_quality_tier IS DISTINCT FROM OLD.evidence_quality_tier
       OR NEW.evidence_rule_version IS DISTINCT FROM OLD.evidence_rule_version
       OR NEW.evidence_reasons IS DISTINCT FROM OLD.evidence_reasons
       OR NEW.evidence_classified_at IS DISTINCT FROM OLD.evidence_classified_at
       OR NEW.finalized_at IS DISTINCT FROM OLD.finalized_at THEN
      RAISE EXCEPTION 'finalized historical cases are immutable'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.learning_eligibility IS NOT DISTINCT FROM OLD.learning_eligibility
       AND NEW.learning_exclusion_reason IS NOT DISTINCT FROM OLD.learning_exclusion_reason
       AND NEW.learning_eligibility_basis IS NOT DISTINCT FROM OLD.learning_eligibility_basis THEN
      NEW.updated_at := NOW();
      RETURN NEW;
    END IF;

    IF NEW.learning_eligibility <> 'excluded'
       AND NOT (
         OLD.learning_eligibility = 'excluded'
         AND NEW.learning_eligibility = 'included'
       ) THEN
      RAISE EXCEPTION
        'a finalized historical case can only be corrected by excluding it from training, or by re-including a case that was wrongly excluded'
        USING ERRCODE = '23514';
    END IF;

    NEW.updated_at := NOW();
    RETURN NEW;
  END IF;

  -- Finalization itself is one-way.
  IF NEW.finalized_at IS NOT NULL AND OLD.finalized_at IS NULL THEN
    IF NEW.case_state <> 'finalized' THEN
      RAISE EXCEPTION 'a finalized case must have case_state = finalized'
        USING ERRCODE = '23514';
    END IF;
    NEW.updated_at := NOW();
    RETURN NEW;
  END IF;

  IF NEW.evidence_quality_tier IS DISTINCT FROM OLD.evidence_quality_tier
     AND NEW.evidence_quality_tier IS NOT NULL
     AND NOT public.historical_case_evidence_supports_tier(
       OLD.id, NEW.evidence_quality_tier
     ) THEN
    RAISE EXCEPTION
      'evidence tier % is not supported by this case''s recorded evidence',
      NEW.evidence_quality_tier
      USING ERRCODE = '23514';
  END IF;

  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

-- ============================================================
-- 7. EVIDENCE-TIER EVIDENCE CHECK
--
-- Unchanged in substance. The extended `quote_decision` vocabulary
-- makes one detail explicit: `no_response` is silence, so it is not
-- evidence of an accepted job, and it is not evidence of a completed
-- one either. It places the case at F exactly like an explicit
-- rejection does, and the fact that distinguishes the two lives on
-- the `quote_decision` value, where a lost-business analysis can read
-- it and a price model cannot mistake it for ground truth.
--
-- `A` is the only tier that carries a training-grade final amount, and
-- it still requires `completed_at` plus a `confirmed_outcome`
-- `final_amount_collected`. No amount of new capture vocabulary can
-- change that.
-- ============================================================

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
  SELECT CASE p_tier
    WHEN 'A' THEN
      EXISTS (
        SELECT 1 FROM public.historical_cases c
        WHERE c.id = p_case_id AND c.completed_at IS NOT NULL
      )
      AND EXISTS (
        SELECT 1 FROM public.historical_case_facts f
        WHERE f.case_id = p_case_id
          AND f.fact_key = 'final_amount_collected'
          AND f.provenance = 'confirmed_outcome'
      )
    WHEN 'B' THEN
      EXISTS (
        SELECT 1 FROM public.historical_case_facts f
        WHERE f.case_id = p_case_id
          AND f.fact_key = 'quote_decision'
          AND f.value_text = 'accepted'
      )
    WHEN 'C' THEN
      EXISTS (
        SELECT 1 FROM public.historical_case_facts f
        WHERE f.case_id = p_case_id
          AND public.historical_case_human_quote_key(f.fact_key)
      )
      AND EXISTS (
        SELECT 1 FROM public.historical_case_facts f
        WHERE f.case_id = p_case_id
          AND f.fact_key = 'quote_decision'
          AND f.value_text IN ('accepted', 'rejected', 'rejected_price')
      )
    WHEN 'D' THEN
      EXISTS (
        SELECT 1 FROM public.historical_case_facts f
        WHERE f.case_id = p_case_id
          AND public.historical_case_human_quote_key(f.fact_key)
      )
    WHEN 'E' THEN
      EXISTS (
        SELECT 1 FROM public.historical_case_facts f
        WHERE f.case_id = p_case_id
          AND f.fact_key = 'ai_suggested_amount'
          AND f.provenance = 'ai_suggested'
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.historical_case_facts f
        WHERE f.case_id = p_case_id
          AND public.historical_case_human_quote_key(f.fact_key)
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.historical_case_facts f
        WHERE f.case_id = p_case_id
          AND f.provenance = 'confirmed_outcome'
      )
    WHEN 'F' THEN
      NOT EXISTS (
        SELECT 1 FROM public.historical_case_facts f
        WHERE f.case_id = p_case_id
          AND f.provenance = 'confirmed_outcome'
      )
    ELSE FALSE
  END;
$$;

-- ============================================================
-- 8. PRIVILEGES
--
-- Same posture as 049: the pure vocabularies and derivations are
-- executable by the roles that write facts and by nothing else, and
-- the trigger functions are never callable directly.
-- ============================================================

ALTER FUNCTION public.historical_case_fact_kind(TEXT) OWNER TO postgres;
ALTER FUNCTION public.historical_case_confirmed_outcome_key(TEXT) OWNER TO postgres;
ALTER FUNCTION public.historical_case_fact_shape_valid(
  TEXT, TEXT, TEXT, NUMERIC, INTEGER, BOOLEAN, TIMESTAMPTZ, TEXT
) OWNER TO postgres;
ALTER FUNCTION public.historical_case_derive_labour_minutes(
  TIMESTAMPTZ, TIMESTAMPTZ
) OWNER TO postgres;
ALTER FUNCTION public.historical_case_evidence_supports_tier(UUID, TEXT) OWNER TO postgres;
ALTER FUNCTION public.guard_historical_case_write() OWNER TO postgres;
ALTER FUNCTION public.guard_historical_case_fact_write() OWNER TO postgres;

GRANT EXECUTE ON FUNCTION public.historical_case_fact_kind(TEXT)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.historical_case_confirmed_outcome_key(TEXT)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.historical_case_fact_shape_valid(
  TEXT, TEXT, TEXT, NUMERIC, INTEGER, BOOLEAN, TIMESTAMPTZ, TEXT
) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.historical_case_derive_labour_minutes(
  TIMESTAMPTZ, TIMESTAMPTZ
) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.historical_case_evidence_supports_tier(UUID, TEXT)
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.historical_case_fact_kind(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.historical_case_confirmed_outcome_key(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.historical_case_fact_shape_valid(
  TEXT, TEXT, TEXT, NUMERIC, INTEGER, BOOLEAN, TIMESTAMPTZ, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.historical_case_derive_labour_minutes(
  TIMESTAMPTZ, TIMESTAMPTZ
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.historical_case_evidence_supports_tier(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_historical_case_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_historical_case_fact_write() FROM PUBLIC;

-- The superseded 7-argument shape validator no longer exists; the DROP
-- above is the only thing that removes its grants, and it cannot be
-- dropped while the old CHECK constraint still referenced it - which
-- is why the constraint is dropped first, further up.