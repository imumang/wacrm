-- ============================================================
-- 049_historical_cases.sql â€” the canonical historical case model
--
-- Roadmap objective 01 (Historical Case and Outcome Model).
--
-- A historical case is the learning-facing view of ONE enquiry/job
-- lifecycle. It is deliberately NOT a second CRM:
--
--   * Identity comes from `enquiries`. The case stores no copy of the
--     enquiry's facts, its state, or its history. `enquiry_id` is the
--     only link, and it is UNIQUE, so there is exactly one case per
--     enquiry.
--   * `conversation_id` and `contact_id` are denormalised *references*
--     so retrieval does not need a three-table join. They are guarded
--     by composite foreign keys, so they cannot drift to another
--     account or contradict the enquiry they came from.
--   * Only facts that WACRM cannot reconstruct from a canonical
--     entity later are stored here, each with its own provenance, in
--     `historical_case_facts`.
--   * Anything that must remain reproducible even if the operational
--     record is later edited goes into the append-only
--     `historical_case_snapshots` instead of being copied onto the
--     case row.
--
-- Two guarantees are enforced by the DATABASE, not only by TypeScript,
-- because a service-role write bypasses RLS:
--
--   1. Evidence tier cannot be claimed without the evidence.
--      `historical_case_evidence_supports_tier` re-reads the case's own
--      facts, so `A` requires a confirmed final amount, `C`/`D` require
--      a human-issued quote, and `E` is only reachable when there is no
--      human quote and no confirmed outcome at all.
--
--   2. An AI suggestion is a prediction, never ground truth.
--      `historical_case_fact_shape_valid` forbids `ai_suggested`
--      provenance on any confirmed outcome, human-approved, or
--      customer-decision fact, and forbids every provenance except
--      `ai_suggested` on `ai_suggested_amount`. A model therefore
--      cannot write its own price into the training truth, even by
--      accident and even through a privileged write path.
--
-- Learning eligibility is a separate, operator-owned decision
-- (`pending` / `included` / `excluded`) and is deliberately NOT derived
-- from the evidence tier: retrieval and model training have different
-- rules, and an excluded case is never deleted, only withheld.
--
-- Not in this migration: embeddings, vector search, retrieval, quote
-- calculation, pricing models, booking, outcome capture, or job
-- completion. Historical cases are created explicitly by the domain
-- layer; nothing in the inbound path creates one.
--
-- Idempotent and additive.
-- ============================================================

-- The composite key lets the case hold an account-scoped foreign key to
-- the contact. `contacts.id` is already the primary key, so the index is
-- unique by construction; this exists only to give Postgres a key it can
-- target from a FOREIGN KEY.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_id_account
  ON contacts(id, account_id);

-- Bounded, null-free rationale list for a classification. Defined before
-- the table because a CHECK constraint resolves its function at CREATE
-- TABLE time.
CREATE OR REPLACE FUNCTION public.historical_case_evidence_reasons_valid(
  reasons TEXT[]
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT reasons IS NOT NULL
    AND array_position(reasons, NULL) IS NULL
    AND cardinality(reasons) <= 20
    AND NOT EXISTS (
      SELECT 1 FROM unnest(reasons) AS reason
      WHERE length(btrim(reason)) NOT BETWEEN 1 AND 200
    );
$$;

-- ============================================================
-- 1. HISTORICAL CASES
-- ============================================================

CREATE TABLE IF NOT EXISTS historical_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- The canonical source of this case. UNIQUE = one case per enquiry.
  enquiry_id UUID NOT NULL,
  -- Denormalised *references*, not copies. Both are proven to belong to
  -- this account by composite foreign keys.
  conversation_id UUID NOT NULL,
  contact_id UUID NOT NULL,
  -- How this case came into existence. `imported_historical` exists for
  -- objective 03 and is deliberately inert here: an imported case still
  -- starts with learning_eligibility = 'pending', so historical data can
  -- never be trusted into training by arriving here.
  source_kind TEXT NOT NULL DEFAULT 'live_enquiry'
    CHECK (source_kind IN ('live_enquiry', 'imported_historical')),
  case_state TEXT NOT NULL DEFAULT 'open'
    CHECK (case_state IN ('open', 'finalized')),
  -- Completed-job timestamp. Mirrors a terminal `completed` enquiry; it
  -- is learning metadata, so it is written when the outcome is known
  -- rather than being derived from the enquiry row on every read.
  completed_at TIMESTAMPTZ,
  -- Evidence classification. NULL tier = explicitly UNCLASSIFIED, not
  -- "tier A with missing data". rule_version records which rule set
  -- produced the value so a classification can be recomputed after the
  -- rules change without losing the previous answer.
  evidence_quality_tier TEXT
    CHECK (evidence_quality_tier IN ('A', 'B', 'C', 'D', 'E', 'F')),
  evidence_rule_version TEXT,
  evidence_reasons TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  evidence_classified_at TIMESTAMPTZ,
  -- Operator-owned learning decision. Default 'pending' means the case
  -- trains nothing until somebody decides otherwise.
  learning_eligibility TEXT NOT NULL DEFAULT 'pending'
    CHECK (learning_eligibility IN ('pending', 'included', 'excluded')),
  learning_exclusion_reason TEXT
    CHECK (learning_exclusion_reason IS NULL OR learning_exclusion_reason IN (
      'incomplete', 'ambiguous', 'bad_data', 'outlier',
      'operator_excluded', 'privacy_deletion', 'test_data'
    )),
  learning_eligibility_basis TEXT
    CHECK (learning_eligibility_basis IS NULL OR learning_eligibility_basis IN (
      'operator', 'system_rule', 'import_policy'
    )),
  -- Frozen learning truth. Set once, never cleared; after this the case
  -- row, its facts, and its snapshots are read-only.
  finalized_at TIMESTAMPTZ,
  created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT historical_cases_id_account_key UNIQUE (id, account_id),
  CONSTRAINT historical_cases_enquiry_account_fk
    FOREIGN KEY (enquiry_id, account_id)
    REFERENCES enquiries(id, account_id)
    ON DELETE CASCADE,
  CONSTRAINT historical_cases_conversation_account_fk
    FOREIGN KEY (conversation_id, account_id)
    REFERENCES conversations(id, account_id)
    ON DELETE CASCADE,
  CONSTRAINT historical_cases_contact_account_fk
    FOREIGN KEY (contact_id, account_id)
    REFERENCES contacts(id, account_id)
    ON DELETE CASCADE,
  -- One historical case per enquiry. This is the whole "durable case
  -- identity" guarantee, and it is enforced for every write path.
  CONSTRAINT historical_cases_one_per_enquiry UNIQUE (enquiry_id),
  CONSTRAINT historical_cases_rule_version_check CHECK (
    (evidence_classified_at IS NULL AND evidence_rule_version IS NULL)
    OR
    (evidence_classified_at IS NOT NULL AND evidence_rule_version IS NOT NULL)
  ),
  CONSTRAINT historical_cases_finalized_state_check CHECK (
    (finalized_at IS NULL AND case_state = 'open')
    OR (finalized_at IS NOT NULL AND case_state = 'finalized')
  ),
  CONSTRAINT historical_cases_exclusion_reason_check CHECK (
    (learning_eligibility = 'excluded' AND learning_exclusion_reason IS NOT NULL)
    OR (learning_eligibility <> 'excluded' AND learning_exclusion_reason IS NULL)
  ),
  CONSTRAINT historical_cases_eligibility_basis_check CHECK (
    (learning_eligibility = 'pending' AND learning_eligibility_basis IS NULL)
    OR (learning_eligibility <> 'pending' AND learning_eligibility_basis IS NOT NULL)
  ),
  CONSTRAINT historical_cases_rule_version_format CHECK (
    evidence_rule_version IS NULL OR length(btrim(evidence_rule_version)) BETWEEN 1 AND 64
  ),
  CONSTRAINT historical_cases_evidence_reasons_check CHECK (
    public.historical_case_evidence_reasons_valid(evidence_reasons)
  )
);

-- Retrieval / training reads are per account and per recency.
CREATE INDEX IF NOT EXISTS idx_historical_cases_account_created
  ON historical_cases(account_id, created_at DESC);

-- The training-eligibility path: which of this account's cases may train
-- a model, newest first.
CREATE INDEX IF NOT EXISTS idx_historical_cases_account_training
  ON historical_cases(account_id, created_at DESC)
  WHERE learning_eligibility = 'included';

-- The retrieval path: cases with a classified tier that are not
-- operator-excluded. Retrieval and training read different populations.
CREATE INDEX IF NOT EXISTS idx_historical_cases_account_tier
  ON historical_cases(account_id, evidence_quality_tier)
  WHERE learning_eligibility <> 'excluded';

CREATE INDEX IF NOT EXISTS idx_historical_cases_enquiry
  ON historical_cases(enquiry_id);

-- ============================================================
-- 2. FACT KEY VOCABULARY
--
-- A closed vocabulary, in two halves:
--
--   * `canonical` keys annotate a column that already exists on
--     `enquiries`. They carry a PROVENANCE and no value, so the case can
--     record where a fact came from without duplicating it. This is the
--     cheapest way to answer "was this customer-stated or
--     operator-entered?" for the operational record.
--
--   * `captured` keys hold a value that has no canonical home, because
--     WACRM has no quote, payment, booking, or job entity yet.
--
-- The vocabulary is deliberately small and closed. New facts are added
-- by adding a key here (and in `src/lib/historical-cases/model.ts`),
-- never by inventing a free-form key at runtime.
-- ============================================================

-- Returns the value kind of a fact key, or NULL when the key is not part
-- of the vocabulary. `canonical` keys return their canonical column type;
-- `captured` keys return the type of the value the case stores.
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
    WHEN 'scope_change_reason'           THEN 'text'
    WHEN 'final_job_notes'               THEN 'text'
    WHEN 'carry_distance_metres'         THEN 'integer'
    WHEN 'item_count'                    THEN 'integer'
    WHEN 'travel_time_minutes'           THEN 'integer'
    WHEN 'crew_count'                    THEN 'integer'
    WHEN 'estimated_labour_minutes'      THEN 'integer'
    WHEN 'actual_labour_minutes'         THEN 'integer'
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
    WHEN 'outcome_no_show'               THEN 'boolean'
    WHEN 'scope_changed'                 THEN 'boolean'
    ELSE NULL
  END;
$$;

-- Provenance classes that may describe a confirmed, post-job fact.
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
    'scope_change_reason',
    'final_job_notes'
  );
$$;

-- A human-issued quote: the amount a person approved or sent. This is the
-- definition used by the evidence tiers, so it must exclude anything the
-- model produced.
CREATE OR REPLACE FUNCTION public.historical_case_human_quote_key(p_key TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_key IN ('human_approved_amount', 'customer_facing_quote_amount');
$$;

-- Shape and provenance compatibility for one fact row.
--
-- This is the AI feedback-loop protection, expressed once so the database
-- and the TypeScript parser cannot drift:
--
--   * unknown key                  -> rejected
--   * canonical key                -> no value columns set
--   * captured key                 -> exactly one value column set, of
--                                     the declared kind
--   * `ai_suggested` provenance    -> forbidden on any confirmed-outcome,
--                                     human-quote, or customer-decision key
--   * `ai_suggested_amount`        -> provenance must be `ai_suggested`
--   * `confirmed_outcome`          -> only on keys that can be known after
--                                     the job
CREATE OR REPLACE FUNCTION public.historical_case_fact_shape_valid(
  p_key TEXT,
  p_value_source TEXT,
  p_value_text TEXT,
  p_value_number NUMERIC,
  p_value_integer INTEGER,
  p_value_boolean BOOLEAN,
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
        + (p_value_boolean IS NOT NULL)::int AS set_count,
      public.historical_case_confirmed_outcome_key(p_key) AS confirmed_ok,
      public.historical_case_human_quote_key(p_key) AS human_quote,
      p_key IN (
        'final_amount_collected', 'actual_load_units',
        'actual_disposal_weight_kg', 'actual_labour_minutes',
        'quote_decision', 'final_job_notes', 'scope_changed',
        'scope_change_reason', 'outcome_no_show', 'human_approved_amount',
        'customer_facing_quote_amount', 'quote_adjustment_amount',
        'quote_adjustment_reason'
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
        ))
    )
    -- A quote decision is a closed vocabulary, not free text.
    AND (p_key <> 'quote_decision'
      OR (p_value_text IN ('accepted', 'rejected', 'pending', 'unknown')))
    -- AI output is a prediction: it may never describe a confirmed
    -- outcome, a human-issued quote, or a customer decision.
    AND (p_provenance <> 'ai_suggested' OR NOT shape.ai_forbidden)
    AND (p_key <> 'ai_suggested_amount' OR p_provenance = 'ai_suggested')
    -- Only a post-job fact can be a confirmed outcome.
    AND (p_provenance <> 'confirmed_outcome' OR shape.confirmed_ok)
  FROM shape;
$$;

-- ============================================================
-- 3. HISTORICAL CASE FACTS
--
-- One row per (case, fact_key). Provenance belongs to the fact, not to
-- the case: the same case can hold a customer-stated postcode, an
-- operator-entered quote, and an AI-suggested amount at the same time,
-- and each keeps its own label.
-- ============================================================

CREATE TABLE IF NOT EXISTS historical_case_facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  case_id UUID NOT NULL,
  fact_key TEXT NOT NULL,
  value_source TEXT NOT NULL CHECK (value_source IN ('canonical', 'captured')),
  value_text TEXT,
  value_number NUMERIC,
  value_integer INTEGER,
  value_boolean BOOLEAN,
  provenance TEXT NOT NULL CHECK (provenance IN (
    'customer_stated', 'operator_entered', 'image_observed',
    'system_derived', 'imported_historical', 'ai_suggested',
    'confirmed_outcome'
  )),
  -- Where the value came from. `messages` has no account_id column, so
  -- ownership is verified in `guard_historical_case_fact_write` below
  -- rather than by a composite foreign key.
  source_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  -- Non-secret account-scoped storage object id, matching
  -- `ImageSourceRef.source_media_id` in the image-analysis layer. Never a
  -- signed URL and never a credential.
  source_media_id TEXT,
  -- When the fact became known to WACRM, as opposed to when it was typed.
  observed_at TIMESTAMPTZ,
  recorded_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT historical_case_facts_id_account_key UNIQUE (id, account_id),
  CONSTRAINT historical_case_facts_case_account_fk
    FOREIGN KEY (case_id, account_id)
    REFERENCES historical_cases(id, account_id)
    ON DELETE CASCADE,
  -- One value per key per case. The fact is identified by its key, not by
  -- a row id the caller chooses.
  CONSTRAINT historical_case_facts_one_per_key UNIQUE (case_id, fact_key),
  CONSTRAINT historical_case_facts_shape_check CHECK (
    public.historical_case_fact_shape_valid(
      fact_key, value_source, value_text, value_number,
      value_integer, value_boolean, provenance
    )
  ),
  -- An image observation without a source image is not evidence. This is
  -- what keeps `image_observed` from becoming an unfalsifiable label.
  CONSTRAINT historical_case_facts_image_source_check CHECK (
    provenance <> 'image_observed'
    OR (source_message_id IS NOT NULL AND source_media_id IS NOT NULL)
  ),
  CONSTRAINT historical_case_facts_source_media_format CHECK (
    source_media_id IS NULL OR length(btrim(source_media_id)) BETWEEN 1 AND 200
  )
);

CREATE INDEX IF NOT EXISTS idx_historical_case_facts_case
  ON historical_case_facts(case_id);

-- Provenance lookups: "which confirmed outcomes does this account have?"
CREATE INDEX IF NOT EXISTS idx_historical_case_facts_account_provenance
  ON historical_case_facts(account_id, provenance);

-- ============================================================
-- 4. HISTORICAL CASE SNAPSHOTS
--
-- The immutable learning/training truth at a particular point in the
-- lifecycle. A canonical entity is current operational truth and may be
-- edited forever; a snapshot is frozen and is what keeps a training
-- example reproducible after somebody corrects a postcode or re-types an
-- item list.
--
-- Nothing snapshots eagerly. `enquiry_facts`, `image_analysis`,
-- `commercial`, and `outcome` are written at finalization (objective 02);
-- `evidence_classification` is written by every reclassification so the
-- current answer and its history both exist.
-- ============================================================

CREATE TABLE IF NOT EXISTS historical_case_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  case_id UUID NOT NULL,
  snapshot_kind TEXT NOT NULL CHECK (snapshot_kind IN (
    'evidence_classification', 'enquiry_facts', 'image_analysis',
    'commercial', 'outcome'
  )),
  payload JSONB NOT NULL,
  -- The rule set / capture version the payload was produced under, so a
  -- snapshot is reproducible and re-derivable.
  source_version TEXT NOT NULL,
  recorded_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT historical_case_snapshots_case_account_fk
    FOREIGN KEY (case_id, account_id)
    REFERENCES historical_cases(id, account_id)
    ON DELETE CASCADE,
  -- Bounded, object-shaped payload: this is a learning fact record, not a
  -- chat transcript. Chat text stays in `messages`.
  CONSTRAINT historical_case_snapshots_payload_check CHECK (
    jsonb_typeof(payload) = 'object'
    AND octet_length(payload::TEXT) <= 16384
  ),
  CONSTRAINT historical_case_snapshots_source_version_check CHECK (
    length(btrim(source_version)) BETWEEN 1 AND 64
  )
);

CREATE INDEX IF NOT EXISTS idx_historical_case_snapshots_case
  ON historical_case_snapshots(case_id, created_at DESC);

-- ============================================================
-- 5. EVIDENCE-TIER EVIDENCE CHECK
--
-- Re-reads the case's own facts to confirm the tier is earned. Runs as
-- the security definer so the facts table's RLS cannot make a legitimate
-- classification look unsupported.
--
--   A  completed job + a confirmed final amount
--   B  a known accepted decision
--   C  a human-issued quote + a known decision
--   D  a human-issued quote, decision unknown
--   E  an AI-suggested amount, and nothing a human or a job produced
--   F  no confirmed outcome (rejected / abandoned)
--
-- Every tier requires positive evidence of its own, so none of them is
-- reachable by omission: a case with nothing recorded stays UNCLASSIFIED.
-- A case whose only money fact is `ai_suggested_amount` can therefore
-- reach at most `E`, and only `A` can carry training-grade final amounts.
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
          AND f.value_text IN ('accepted', 'rejected')
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
-- 6. WRITE GUARDS
-- ============================================================

-- Case identity is durable, and a finalized case is frozen.
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
    RAISE EXCEPTION 'finalized historical cases are immutable'
      USING ERRCODE = '23514';
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

-- Fact integrity: account-scoped source references and a frozen case.
CREATE OR REPLACE FUNCTION public.guard_historical_case_fact_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_finalized TIMESTAMPTZ;
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

  RETURN NEW;
END;
$$;

-- A snapshot is a statement about a past moment: append it, never amend
-- or remove it. Deletion stays possible only as the account/case cascade,
-- which is the one removal that is a business decision rather than an edit.
CREATE OR REPLACE FUNCTION public.guard_historical_case_snapshot_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'historical case snapshots are immutable'
      USING ERRCODE = '23514';
  END IF;

  -- DELETE: allowed only while the owning case is being removed with it.
  IF EXISTS (
    SELECT 1 FROM public.historical_cases c
    WHERE c.id = OLD.case_id AND c.account_id = OLD.account_id
  ) THEN
    RAISE EXCEPTION 'historical case snapshots are append-only'
      USING ERRCODE = '23514';
  END IF;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS guard_historical_case_write ON historical_cases;
CREATE TRIGGER guard_historical_case_write
  BEFORE INSERT OR UPDATE ON historical_cases
  FOR EACH ROW EXECUTE FUNCTION public.guard_historical_case_write();

DROP TRIGGER IF EXISTS guard_historical_case_fact_write
  ON historical_case_facts;
CREATE TRIGGER guard_historical_case_fact_write
  BEFORE INSERT OR UPDATE ON historical_case_facts
  FOR EACH ROW EXECUTE FUNCTION public.guard_historical_case_fact_write();

DROP TRIGGER IF EXISTS guard_historical_case_snapshot_write
  ON historical_case_snapshots;
CREATE TRIGGER guard_historical_case_snapshot_write
  BEFORE INSERT OR UPDATE OR DELETE ON historical_case_snapshots
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_historical_case_snapshot_write();

DROP TRIGGER IF EXISTS set_updated_at ON historical_cases;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON historical_cases
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at_historical_case_facts
  ON historical_case_facts;
CREATE TRIGGER set_updated_at_historical_case_facts
  BEFORE UPDATE ON historical_case_facts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER FUNCTION public.historical_case_fact_kind(TEXT) OWNER TO postgres;
ALTER FUNCTION public.historical_case_confirmed_outcome_key(TEXT) OWNER TO postgres;
ALTER FUNCTION public.historical_case_human_quote_key(TEXT) OWNER TO postgres;
ALTER FUNCTION public.historical_case_fact_shape_valid(
  TEXT, TEXT, TEXT, NUMERIC, INTEGER, BOOLEAN, TEXT
) OWNER TO postgres;
ALTER FUNCTION public.historical_case_evidence_reasons_valid(TEXT[]) OWNER TO postgres;
ALTER FUNCTION public.historical_case_evidence_supports_tier(UUID, TEXT) OWNER TO postgres;
ALTER FUNCTION public.guard_historical_case_write() OWNER TO postgres;
ALTER FUNCTION public.guard_historical_case_fact_write() OWNER TO postgres;
ALTER FUNCTION public.guard_historical_case_snapshot_write() OWNER TO postgres;

-- The vocabularies and shape validator run from CHECK constraints, so
-- every role that may write a fact needs EXECUTE on them.
GRANT EXECUTE ON FUNCTION public.historical_case_fact_kind(TEXT)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.historical_case_confirmed_outcome_key(TEXT)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.historical_case_human_quote_key(TEXT)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.historical_case_fact_shape_valid(
  TEXT, TEXT, TEXT, NUMERIC, INTEGER, BOOLEAN, TEXT
) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.historical_case_evidence_reasons_valid(TEXT[])
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.historical_case_evidence_supports_tier(UUID, TEXT)
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.historical_case_fact_kind(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.historical_case_confirmed_outcome_key(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.historical_case_human_quote_key(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.historical_case_fact_shape_valid(
  TEXT, TEXT, TEXT, NUMERIC, INTEGER, BOOLEAN, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.historical_case_evidence_reasons_valid(TEXT[])
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.historical_case_evidence_supports_tier(UUID, TEXT)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_historical_case_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_historical_case_fact_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_historical_case_snapshot_write() FROM PUBLIC;

-- ============================================================
-- 7. ROW LEVEL SECURITY
--
-- Reading is account-scoped and member-only. Learning data is customer
-- content: there is no anon access, no cross-account read, and no way for
-- a member of one account to see another account's cases.
--
-- Writing is agent-and-above. There is no authenticated DELETE policy:
-- an excluded case is withheld from training, never removed, and removal
-- happens only through the account cascade.
-- ============================================================

ALTER TABLE historical_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE historical_case_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE historical_case_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS historical_cases_select ON historical_cases;
CREATE POLICY historical_cases_select ON historical_cases FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS historical_cases_insert ON historical_cases;
CREATE POLICY historical_cases_insert ON historical_cases FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS historical_cases_update ON historical_cases;
CREATE POLICY historical_cases_update ON historical_cases FOR UPDATE
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS historical_case_facts_select ON historical_case_facts;
CREATE POLICY historical_case_facts_select ON historical_case_facts FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS historical_case_facts_insert ON historical_case_facts;
CREATE POLICY historical_case_facts_insert ON historical_case_facts FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS historical_case_facts_update ON historical_case_facts;
CREATE POLICY historical_case_facts_update ON historical_case_facts FOR UPDATE
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));

-- Snapshots are append-only. No UPDATE or DELETE policy for `authenticated`;
-- the immutability trigger above protects them from privileged edits too.
DROP POLICY IF EXISTS historical_case_snapshots_select
  ON historical_case_snapshots;
CREATE POLICY historical_case_snapshots_select
  ON historical_case_snapshots FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS historical_case_snapshots_insert
  ON historical_case_snapshots;
CREATE POLICY historical_case_snapshots_insert
  ON historical_case_snapshots FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
