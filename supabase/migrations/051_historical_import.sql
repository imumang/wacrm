-- ============================================================
-- 051_historical_import.sql - the durable identity and audit
-- spine for historical import.
--
-- Roadmap objective 02 (Historical Import and Normalization),
-- building on the historical case model from 049 and the outcome
-- capture vocabulary from 050.
--
-- 049 created `source_kind = 'imported_historical'` and left it
-- deliberately inert. This migration gives an imported case three
-- things it could not have before:
--
--   1. `historical_import_runs` - what was attempted, when, by whom,
--      how many records were examined, created, reused, skipped or
--      left ambiguous, whether the run was a dry run, and the
--      bounded, body-free summary that explains the run.
--
--   2. `historical_case_sources` - a per-source-record ledger. Every
--      imported fact points back at one row here, and that row
--      names the source system, the source record, its version /
--      hash where one exists, the import run that brought it in,
--      and when. `UNIQUE (account_id, source_kind, source_record_id)`
--      is what makes a re-run idempotent: the same source record
--      cannot be attributed to two cases, so importing twice cannot
--      create a second case for the same evidence.
--
--   3. `import_quality` - a per-source-record verdict that says how
--      well the source mapped onto the case model. It is
--      deliberately NOT the evidence tier. A source record can map
--      cleanly onto a case and still leave a case with no evidence
--      at all, because the business never recorded an outcome; those
--      are two different questions and collapsing them is how an
--      untrustworthy dataset gets built. The roadmap's vocabulary is
--      used verbatim: exact / high_confidence_mapping / partial /
--      ambiguous / unusable.
--
-- What this migration deliberately does NOT add:
--
--   * No embeddings, no vector column, no similarity search.
--   * No quote calculation, no learned pricing, no booking.
--   * No automatic import. Nothing here runs by itself; a human
--     inspects, dry-runs, and then executes.
--   * No way for imported data to become a confirmed outcome.
--     `imported_historical` is a provenance class, not a promotion:
--     the evidence tiers and their SQL evidence check are untouched,
--     so an imported case that happens to classify as A still has to
--     have earned it.
--   * No conversion between loads and kilograms, and no
--     kilograms-per-load factor anywhere.
--
-- Idempotent and additive. Re-running this migration on a database
-- that already has 049 + 050 applied is safe.
-- ============================================================

-- ============================================================
-- 1. IMPORT RUNS
--
-- One row per importer attempt. A run is an audit record about a
-- process, not about a customer: nothing here stores a message body,
-- a customer name, a phone number, or a media URL. Source records
-- are named by id, so a run can be investigated without copying any
-- customer content into a second place.
-- ============================================================

CREATE TABLE IF NOT EXISTS historical_import_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Which source adapter produced this run. One run, one adapter:
  -- a mixed run could not be re-run in isolation, and "which source
  -- did this" is the first question anybody asks of a bad import.
  source_type TEXT NOT NULL CHECK (source_type IN (
    'enquiries', 'legacy_conversations', 'deals'
  )),
  -- running -> completed -> (re)written as completed_with_errors or
  -- failed. A run that never finished stays `running` so an
  -- interrupted import is visible rather than invisible.
  status TEXT NOT NULL CHECK (status IN (
    'running', 'completed', 'completed_with_errors', 'failed'
  )),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  -- TRUE means the run planned and reported without writing a single
  -- historical-case mutation. This is the mode every import must be
  -- reviewed in first, so it is a first-class flag rather than an
  -- inference from the counters.
  dry_run BOOLEAN NOT NULL DEFAULT TRUE,
  records_examined INTEGER NOT NULL DEFAULT 0 CHECK (records_examined >= 0),
  cases_created INTEGER NOT NULL DEFAULT 0 CHECK (cases_created >= 0),
  cases_updated INTEGER NOT NULL DEFAULT 0 CHECK (cases_updated >= 0),
  cases_reused INTEGER NOT NULL DEFAULT 0 CHECK (cases_reused >= 0),
  facts_imported INTEGER NOT NULL DEFAULT 0 CHECK (facts_imported >= 0),
  records_skipped INTEGER NOT NULL DEFAULT 0 CHECK (records_skipped >= 0),
  ambiguous_records INTEGER NOT NULL DEFAULT 0 CHECK (ambiguous_records >= 0),
  conflicts INTEGER NOT NULL DEFAULT 0 CHECK (conflicts >= 0),
  errors INTEGER NOT NULL DEFAULT 0 CHECK (errors >= 0),
  -- Bounded, machine-readable rollup: evidence-tier counts,
  -- import-quality counts, skip-reason counts, conflict-reason
  -- counts, and a small id-only sample per reason.
  summary JSONB NOT NULL DEFAULT '{}'::JSONB,
  -- Bounded list of {source_kind, source_record_id, reason}. Ids and
  -- reasons only: never a customer message body, a name, or a URL.
  error_metadata JSONB NOT NULL DEFAULT '[]'::JSONB,
  -- Which importer build produced the plan, so a mapping change can
  -- be identified without guessing from row contents.
  importer_version TEXT NOT NULL,
  triggered_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT historical_import_runs_id_account_key UNIQUE (id, account_id),
  CONSTRAINT historical_import_runs_importer_version_format CHECK (
    length(btrim(importer_version)) BETWEEN 1 AND 64
  ),
  CONSTRAINT historical_import_runs_source_type_format CHECK (
    length(btrim(source_type)) BETWEEN 1 AND 64
  ),
  -- A run is finished exactly when it is not `running`, and only a
  -- finished run may claim completed work.
  CONSTRAINT historical_import_runs_completion_check CHECK (
    (status = 'running' AND completed_at IS NULL)
    OR (status <> 'running' AND completed_at IS NOT NULL)
  ),
  -- A dry run creates and updates nothing. Stating it as a CHECK
  -- rather than a code convention is the point: the promise an
  -- operator is asked to rely on before approving a real import is
  -- now something the database will refuse to record a violation of.
  CONSTRAINT historical_import_runs_dry_run_no_writes CHECK (
    NOT dry_run OR (cases_created = 0 AND cases_updated = 0)
  ),
  CONSTRAINT historical_import_runs_summary_check CHECK (
    jsonb_typeof(summary) = 'object'
      AND octet_length(summary::TEXT) <= 8192
  ),
  CONSTRAINT historical_import_runs_error_metadata_check CHECK (
    jsonb_typeof(error_metadata) = 'array'
      AND octet_length(error_metadata::TEXT) <= 8192
  )
);

CREATE INDEX IF NOT EXISTS idx_historical_import_runs_account_started
  ON historical_import_runs(account_id, started_at DESC);

-- The dry-run review path: "the most recent dry run of this source,
-- for this account" is a single indexed read.
CREATE INDEX IF NOT EXISTS idx_historical_import_runs_account_dry_source
  ON historical_import_runs(account_id, source_type, started_at DESC)
  WHERE dry_run;

-- ============================================================
-- 2. SOURCE IDENTITY LEDGER
--
-- One row per (source record, case). This is the durable answer to
-- "where did this fact come from", and it is the mechanism that makes
-- import idempotent.
--
-- The idempotency argument in full:
--
--   * `historical_cases_one_per_enquiry` (049) already guarantees one
--     case per enquiry, so a re-run cannot create a second case for
--     an enquiry that already has one.
--
--   * `UNIQUE (account_id, source_kind, source_record_id)` here
--     guarantees the other direction: one source record cannot be
--     attributed to two cases. Without it, a legacy conversation
--     that somehow acquired two enquiry rows would be imported as
--     two cases, and the resulting dataset would double-count the
--     same business evidence.
--
--   * `historical_case_facts_one_per_key` (049) guarantees one value
--     per key per case, so re-running cannot duplicate a fact.
--
-- Together: re-running the importer changes nothing it has already
-- written, and any conflict it finds is reported rather than applied.
-- ============================================================

CREATE TABLE IF NOT EXISTS historical_case_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- The case this evidence was attributed to.
  case_id UUID NOT NULL,
  -- Which kind of record this is. The vocabulary is closed, because
  -- an open one would make "where did this come from" unanswerable
  -- by a query.
  source_kind TEXT NOT NULL CHECK (source_kind IN (
    'enquiry', 'legacy_conversation', 'message', 'deal', 'contact'
  )),
  -- The canonical row's own id. Enquiries, conversations, messages,
  -- deals and contacts all have UUID primary keys, so one column
  -- holds the identity without a per-kind type discriminator.
  source_record_id UUID NOT NULL,
  -- The table/system the record came from, e.g. `wacrm.enquiries`.
  -- Recorded so a later migration that introduces a second source
  -- system does not have to reinterpret rows written before it.
  source_system TEXT NOT NULL,
  -- Version or content hash of the source record where one is
  -- available. NULL is honest: most WACRM rows have no natural
  -- version, and inventing one would be a fabricated fingerprint.
  source_version TEXT,
  -- The source record's own timestamp, normalized to an instant.
  -- The import time is a separate column: "when the customer messaged"
  -- and "when we imported it" are different facts.
  source_observed_at TIMESTAMPTZ,
  -- The run that brought this in. NULL when a source row was
  -- attached outside an import (live outcome capture), which is a
  -- real state rather than a missing one.
  import_run_id UUID REFERENCES historical_import_runs(id) ON DELETE SET NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- How well this source record mapped onto the case model. NOT the
  -- evidence tier: `exact` here means "this record mapped cleanly",
  -- and says nothing about whether the business ever recorded an
  -- outcome.
  import_quality TEXT NOT NULL CHECK (import_quality IN (
    'exact', 'high_confidence_mapping', 'partial', 'ambiguous', 'unusable'
  )),
  -- Bounded, null-free reasons for the quality verdict. Never a
  -- customer message body: a reason is a vocabulary word or a short
  -- operator-readable clause.
  import_quality_reasons TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  CONSTRAINT historical_case_sources_id_account_key UNIQUE (id, account_id),
  CONSTRAINT historical_case_sources_case_account_fk
    FOREIGN KEY (case_id, account_id)
    REFERENCES historical_cases(id, account_id)
    ON DELETE CASCADE,
  -- One source record, one case. See the idempotency argument above.
  CONSTRAINT historical_case_sources_one_record_one_case
    UNIQUE (account_id, source_kind, source_record_id),
  CONSTRAINT historical_case_sources_source_system_format CHECK (
    length(btrim(source_system)) BETWEEN 1 AND 64
  ),
  CONSTRAINT historical_case_sources_source_version_format CHECK (
    source_version IS NULL
    OR length(btrim(source_version)) BETWEEN 1 AND 128
  ),
  CONSTRAINT historical_case_sources_import_quality_reasons_valid CHECK (
    public.historical_case_evidence_reasons_valid(import_quality_reasons)
  )
);

CREATE INDEX IF NOT EXISTS idx_historical_case_sources_case
  ON historical_case_sources(case_id, source_kind);

-- The import hot path: "which source records of this kind have
-- already been attributed, for this account".
CREATE INDEX IF NOT EXISTS idx_historical_case_sources_account_kind
  ON historical_case_sources(account_id, source_kind, source_record_id);

-- "What came from an import, and in which run?" - the audit read.
CREATE INDEX IF NOT EXISTS idx_historical_case_sources_account_run
  ON historical_case_sources(account_id, import_run_id)
  WHERE import_run_id IS NOT NULL;

-- ============================================================
-- 3. WRITE GUARD
--
-- The source ledger is an append-only statement about where evidence
-- came from. Two rules, both of which the importer's conflict policy
-- depends on:
--
--   1. It cannot be amended. Changing a source row would silently
--      rewrite the origin of a fact that may already be frozen into
--      a training example.
--
--   2. A finalized case accepts no new source rows. A finalized
--      case is immutable learning truth (049/050): the training
--      example must stay reproducible from what it was built from.
--      Attaching an import source to one afterwards would add
--      evidence to a frozen example without re-freezing it, which
--      is exactly the "do not silently mutate" case the importer is
--      required to flag instead of applying.
--
-- The importer handles (2) by skipping finalized cases and reporting
-- a conflict; the trigger makes it unavoidable even on a privileged
-- write.
-- ============================================================

CREATE OR REPLACE FUNCTION public.guard_historical_case_source_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_finalized TIMESTAMPTZ;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'historical case sources are immutable'
      USING ERRCODE = '23514';
  END IF;

  -- DELETE: allowed only while the owning case is being removed with
  -- it, which is the same rule the snapshot guard uses.
  IF EXISTS (
    SELECT 1 FROM public.historical_cases c
    WHERE c.id = OLD.case_id AND c.account_id = OLD.account_id
  ) THEN
    RAISE EXCEPTION 'historical case sources are append-only'
      USING ERRCODE = '23514';
  END IF;

  RETURN OLD;
END;
$$;

-- The finalized-case refusal has to fire on INSERT, so it lives in
-- its own trigger function rather than being bolted onto the
-- append-only one above.
CREATE OR REPLACE FUNCTION public.guard_historical_case_source_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_finalized TIMESTAMPTZ;
BEGIN
  SELECT c.finalized_at INTO v_finalized
  FROM public.historical_cases c
  WHERE c.id = NEW.case_id AND c.account_id = NEW.account_id;

  IF v_finalized IS NOT NULL THEN
    RAISE EXCEPTION
      'a finalized historical case accepts no new imported sources'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_historical_case_source_write
  ON historical_case_sources;
CREATE TRIGGER guard_historical_case_source_write
  BEFORE UPDATE OR DELETE ON historical_case_sources
  FOR EACH ROW EXECUTE FUNCTION public.guard_historical_case_source_write();

DROP TRIGGER IF EXISTS guard_historical_case_source_insert
  ON historical_case_sources;
CREATE TRIGGER guard_historical_case_source_insert
  BEFORE INSERT ON historical_case_sources
  FOR EACH ROW EXECUTE FUNCTION public.guard_historical_case_source_insert();

ALTER FUNCTION public.guard_historical_case_source_write() OWNER TO postgres;
ALTER FUNCTION public.guard_historical_case_source_insert() OWNER TO postgres;

REVOKE ALL ON FUNCTION public.guard_historical_case_source_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_historical_case_source_insert() FROM PUBLIC;

-- ============================================================
-- 4. ROW LEVEL SECURITY
--
-- The import ledger holds the same customer-adjacent metadata the
-- case tables hold, so it gets the same posture: members read, and
-- only admin-and-above may write. Admin rather than agent is
-- deliberate - a bulk dataset import is a workspace-level action
-- that changes what a future training set will contain, and the
-- narrower the write role, the less a single compromised agent
-- account can do to the dataset.
--
-- There is no authenticated UPDATE policy, because the rows are
-- immutable, and no authenticated DELETE policy, because an import
-- run and its source ledger are an audit trail rather than something
-- an operator tidies up. Removal happens only through the account
-- cascade.
-- ============================================================

ALTER TABLE historical_import_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE historical_case_sources ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS historical_import_runs_select ON historical_import_runs;
CREATE POLICY historical_import_runs_select ON historical_import_runs FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS historical_import_runs_insert ON historical_import_runs;
CREATE POLICY historical_import_runs_insert ON historical_import_runs FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS historical_import_runs_update ON historical_import_runs;
CREATE POLICY historical_import_runs_update ON historical_import_runs FOR UPDATE
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

-- `historical_case_sources` gets member-read plus admin-write, but no
-- UPDATE policy: the rows are immutable and a policy would only ever
-- be refused by the trigger.

DROP POLICY IF EXISTS historical_case_sources_select
  ON historical_case_sources;
CREATE POLICY historical_case_sources_select
  ON historical_case_sources FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS historical_case_sources_insert
  ON historical_case_sources;
CREATE POLICY historical_case_sources_insert
  ON historical_case_sources FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));