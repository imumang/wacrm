-- ============================================================
-- 054_image_analysis_observations.sql - canonical, per-image
-- persistence of validated image-analysis observations.
--
-- A NARROW OBJECTIVE-03 FOLLOW-THROUGH DEPENDENCY. It adds the
-- durable, source-traceable record that per-image semantic
-- embeddings need, and it adds nothing else: no retrieval, no
-- ranking, no nearest-neighbour search, no native image vectors,
-- no pricing, and no automatic analysis of anything.
--
-- The gap this closes
-- ------------------
-- Until now, a validated observation existed in exactly one place:
-- the frozen case-level `image_analysis` snapshot of a FINALIZED
-- historical case, assembled from `image_observed` facts. That is
-- reproducible, but it is not canonical. There is no per-image
-- record, so:
--
--   * "which observation came from which photograph?" has no
--     answer that survives independently of a finalization;
--   * one case with several materially different photographs is
--     represented as a single undifferentiated blob;
--   * re-analysing an image cannot be recognised as re-analysing
--     something already analysed, so the same paid vision call can
--     be repeated indefinitely; and
--   * the `image_observation_text` semantic path has no canonical
--     per-image source to be built from.
--
-- The model
-- ---------
--   image_analysis_runs                  1 : n  image_analysis_observations
--        |                                            |
--        |  1 : n                                      | 1 : n
--        v                                            v
--   image_analysis_run_images ......... image_analysis_observation_sources
--        (one row per ANALYSED IMAGE:      (which observation came from
--         ordinal, message, media object,   WHICH photograph)
--         mime, size, direction)
--
-- The fourth table is the load-bearing design decision. An
-- observation legitimately spans several photographs - "the same
-- three-seat sofa appears in photo 1 and photo 3" - so naively
-- duplicating the observation per source would inflate counts and
-- make the record a lie. Here the observation is stored exactly
-- once and the join table records which images it came from. That
-- is what lets objective 04 ask a per-image question without WACRM
-- having to guess what "the same item" means.
--
-- Analysis-level signals that are NOT per-observation
-- (`estimated_volume_range`, `need_more_photos`,
-- `follow_up_questions`, `notes`) stay properties of the RUN
-- rather than being smeared across observation rows: they describe
-- the analysis of a set of photographs, not any single photograph.
--
-- What is NOT stored, and why
-- ---------------------------
--   * No image bytes and no second media store. `source_media_id`
--     is the account-scoped storage OBJECT PATH that already exists
--     in `messages.media_url`, kept as metadata for an operator.
--     The `chat-media` bucket remains the single source of truth for
--     the photograph itself.
--   * No raw or unvalidated provider output. The table has no column
--     in which raw output could be written even by accident, and
--     observations may only exist under `status = 'succeeded'`.
--   * No price, no money column, no exact weight. The observation
--     payload is the validated contract, which has no such field.
--   * No signed URL and no credential. The write guard RE-DERIVES the
--     object path from the source message row rather than trusting
--     the caller, and the column refuses anything URL-shaped.
--   * No automatic backfill. Applying this migration stores nothing
--     and analyses nothing. Legacy media is never bulk analysed.
--
-- Guarantees enforced by the DATABASE (not only by TypeScript),
-- because a service-role write bypasses RLS entirely:
--
--   1. TENANT + SOURCE TRACEABILITY. Runs carry composite
--      `(id, account_id)` foreign keys to the conversation, the
--      enquiry and the historical case, so a privileged write cannot
--      attribute an analysis to another account's conversation or
--      case. `messages` has no `account_id` column, so
--      `guard_image_analysis_run_image_write` proves the source
--      message belongs to the run's own conversation and that the
--      recorded object path is exactly the path derived from that
--      message row's own `media_url`.
--   2. NO OBSERVATION WITHOUT A PHOTOGRAPH. Deleting a source message
--      cascades its run images away, and `prune_image_analysis_orphans`
--      removes any observation left with no surviving source rather
--      than leaving it readable as learning memory.
--   3. NO OBSERVATION ON AN UNVALIDATED RUN, and the scalar
--      projection beside `payload` must agree with `payload`.
--   4. IDEMPOTENCY. A unique index over the request identity
--      (account, conversation, source fingerprint, analyzer, provider,
--      model, analysis schema version, prompt version) means the same
--      immutable request can never produce two canonical runs.
--   5. LIFECYCLE IS EXPRESSED. `superseded` requires a named
--      replacement; observations are immutable.
--   6. PRIVACY PROPAGATION. Excluding a historical case withholds its
--      analyses, and a withheld analysis cannot be reactivated while
--      the case is still excluded. Deleting the source message, the
--      case, the conversation or the account removes the derived
--      observations with it.
--
-- Idempotent and additive. Migrations 001-053 are untouched.
-- ============================================================

-- Already enabled by 030 for the knowledge base and re-stated by 053.
-- Re-declared so this file is readable on its own.
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================
-- 1. IMAGE ANALYSIS RUNS
--
-- One row per analyzer invocation whose result passed the strict
-- validator, plus an optional observability row for a failure. A
-- failure row carries a safe, closed-vocabulary reason and never
-- carries provider output.
-- ============================================================

CREATE TABLE IF NOT EXISTS image_analysis_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,

  -- Provenance of the analyzer invocation. `conversation_id` is the
  -- scope the analysis was performed in. The other two are
  -- denormalised references so a learning read does not need a
  -- three-table join; each is NULL when genuinely not applicable (an
  -- analysis before the case existed, an enquiry since removed) and
  -- each is proven account-scoped by a composite foreign key, so it
  -- can never point at another tenant.
  conversation_id UUID NOT NULL,
  enquiry_id UUID,
  historical_case_id UUID,

  -- Provider-neutral identifier of the analyzer
  -- (`configured_vision_model`). Never a model version, endpoint, or
  -- credential.
  analyzer_id TEXT NOT NULL,
  -- The account's OWN configured provider and model. These are
  -- version metadata, not credentials: they are what makes "this
  -- analysis was produced by model X" answerable, and what makes a
  -- deliberate re-analysis under a different model a DISTINCT row
  -- rather than an overwrite.
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  -- Which validated observation contract the stored payload obeys
  -- (`IMAGE_ANALYSIS_SCHEMA_VERSION` in the TypeScript layer). A
  -- change here means a stored analysis is not interchangeable with a
  -- new one even when the label looks the same.
  analysis_schema_version TEXT NOT NULL,
  -- Which instruction text produced it (`VISION_PROMPT_VERSION`). A
  -- prompt rewrite is a different analysis even at the same model.
  prompt_version TEXT NOT NULL,

  status TEXT NOT NULL CHECK (status IN (
    'succeeded',
    'provider_unavailable',
    'timed_out',
    'cancelled',
    'validation_failed'
  )),
  -- A closed vocabulary of safe reasons, mirroring the failure table
  -- in docs/image-analysis.md. Never a provider message, a status
  -- line, or any other free text.
  failure_reason TEXT CHECK (
    failure_reason IS NULL OR failure_reason IN (
      'account_not_configured',
      'provider_error',
      'provider_timeout',
      'caller_cancelled',
      'invalid_provider_result'
    )
  ),
  image_count INTEGER NOT NULL DEFAULT 0 CHECK (image_count >= 0),

  -- Run-scoped breadcrumb. Ties an analysis back to the tool audit row
  -- and the `ai_usage_log` spend row for the same call without
  -- duplicating either record's contents here.
  correlation_id TEXT,

  -- SHA-256 (lowercase hex) over the deterministic identity of the
  -- REQUEST: the conversation plus the ordered per-image media
  -- identities (ordinal, message id, object path, MIME, byte length).
  -- It holds no image bytes, no URL and no credential - it is the
  -- idempotency key, not an archive of the photographs.
  --
  -- NULL for a failure row, because a run that failed before its media
  -- was resolved has no request identity to speak of.
  source_fingerprint TEXT,

  -- SHA-256 over the canonical serialisation of the validated result.
  -- A pure function of what was observed, so a repeated analysis of
  -- identical media under an identical model is recognisable as the
  -- same observation set rather than as new evidence.
  result_content_hash TEXT,

  -- Lifecycle, mirroring `case_embeddings.state` (migration 053).
  --
  -- `current`     the live analysis of its media set.
  -- `superseded`  a newer analysis replaced it under a different model
  --               or schema; `superseded_by` names the replacement.
  -- `withheld`    the source case is excluded from learning. Present
  --               and auditable, never retrievable.
  --
  -- Deletion is never used to express any of these. Deletion happens
  -- only through the source/case/conversation/account cascade.
  state TEXT NOT NULL DEFAULT 'current'
    CHECK (state IN ('current', 'superseded', 'withheld')),
  superseded_by UUID,

  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT image_analysis_runs_id_account_key UNIQUE (id, account_id),
  CONSTRAINT image_analysis_runs_conversation_account_fk
    FOREIGN KEY (conversation_id, account_id)
    REFERENCES conversations(id, account_id)
    ON DELETE CASCADE,
  -- `ON DELETE SET NULL (enquiry_id)` is the PostgreSQL 15+ column-list
  -- form, and it is what makes the deletion semantics right: removing
  -- an enquiry removes the ENQUIRY reference, not the account
  -- reference that keeps the row tenant-scoped.
  CONSTRAINT image_analysis_runs_enquiry_account_fk
    FOREIGN KEY (enquiry_id, account_id)
    REFERENCES enquiries(id, account_id)
    ON DELETE SET NULL (enquiry_id),
  -- Deleting a case removes its derived analyses. Deletion is a
  -- business decision, so removal (rather than withholding) is right
  -- here; exclusion is handled as withholding instead.
  CONSTRAINT image_analysis_runs_case_account_fk
    FOREIGN KEY (historical_case_id, account_id)
    REFERENCES historical_cases(id, account_id)
    ON DELETE CASCADE,
  CONSTRAINT image_analysis_runs_superseded_by_account_fk
    FOREIGN KEY (superseded_by, account_id)
    REFERENCES image_analysis_runs(id, account_id)
    DEFERRABLE INITIALLY DEFERRED,

  CONSTRAINT image_analysis_runs_analyzer_id_check CHECK (
    length(btrim(analyzer_id)) BETWEEN 1 AND 64
  ),
  CONSTRAINT image_analysis_runs_provider_check CHECK (
    length(btrim(provider)) BETWEEN 1 AND 64
  ),
  CONSTRAINT image_analysis_runs_model_check CHECK (
    length(btrim(model)) BETWEEN 1 AND 200
  ),
  CONSTRAINT image_analysis_runs_analysis_schema_version_check CHECK (
    length(btrim(analysis_schema_version)) BETWEEN 1 AND 64
  ),
  CONSTRAINT image_analysis_runs_prompt_version_check CHECK (
    length(btrim(prompt_version)) BETWEEN 1 AND 64
  ),
  CONSTRAINT image_analysis_runs_correlation_id_check CHECK (
    correlation_id IS NULL OR length(btrim(correlation_id)) BETWEEN 1 AND 200
  ),
  CONSTRAINT image_analysis_runs_source_fingerprint_check CHECK (
    source_fingerprint IS NULL OR source_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT image_analysis_runs_result_content_hash_check CHECK (
    result_content_hash IS NULL OR result_content_hash ~ '^[0-9a-f]{64}$'
  ),
  -- A successful analysis is the only one that has a request identity
  -- and an observation set; a failure is only ever an observability
  -- row, and it can never carry a result hash.
  CONSTRAINT image_analysis_runs_success_shape_check CHECK (
    (status = 'succeeded'
      AND failure_reason IS NULL
      AND source_fingerprint IS NOT NULL
      AND result_content_hash IS NOT NULL
      AND image_count > 0)
    OR
    (status <> 'succeeded'
      AND failure_reason IS NOT NULL
      AND result_content_hash IS NULL)
  ),
  CONSTRAINT image_analysis_runs_timestamps_check CHECK (
    completed_at IS NULL OR completed_at >= started_at
  ),
  CONSTRAINT image_analysis_runs_state_supersede_check CHECK (
    (state = 'superseded' AND superseded_by IS NOT NULL)
    OR (state <> 'superseded' AND superseded_by IS NULL)
  )
);

-- "Which analyses does this account hold for this conversation?"
CREATE INDEX IF NOT EXISTS idx_image_analysis_runs_account_conversation
  ON image_analysis_runs (account_id, conversation_id, created_at DESC);

-- The learning read: a case's analyses, newest first.
CREATE INDEX IF NOT EXISTS idx_image_analysis_runs_account_case
  ON image_analysis_runs (account_id, historical_case_id, created_at DESC)
  WHERE historical_case_id IS NOT NULL;

-- Idempotency. The same immutable request under the same analyzer,
-- model and contract can never produce two canonical runs, and a
-- deliberate re-analysis under a NEW model/version can always be
-- represented because it produces a different identity.
CREATE UNIQUE INDEX IF NOT EXISTS idx_image_analysis_runs_request_identity
  ON image_analysis_runs (
    account_id,
    conversation_id,
    source_fingerprint,
    analyzer_id,
    provider,
    model,
    analysis_schema_version,
    prompt_version
  )
  WHERE source_fingerprint IS NOT NULL;

-- At most one CURRENT analysis per media set, so a re-analysis under a
-- different model hands the slot over instead of leaving two live
-- answers about the same photographs.
CREATE UNIQUE INDEX IF NOT EXISTS idx_image_analysis_runs_one_current
  ON image_analysis_runs (account_id, conversation_id, source_fingerprint)
  WHERE state = 'current';

-- ============================================================
-- 2. IMAGE ANALYSIS RUN IMAGES
--
-- One row per ANALYSED photograph. This is the per-image record: it
-- says which canonical message and which canonical storage object the
-- model looked at, in which position, with what factual metadata. It
-- is deliberately NOT a media store - the bytes live in `chat-media`
-- exactly once, referenced by object path.
-- ============================================================

CREATE TABLE IF NOT EXISTS image_analysis_run_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  run_id UUID NOT NULL,

  -- 1-based position in the analysed set, exactly as the provider saw
  -- it. Deterministic and immutable, so "ordinal 3" always names the
  -- same photograph for the lifetime of the run.
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  source_message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  -- The account-scoped storage OBJECT PATH (`account-<id>/inbound/…`),
  -- never a URL and never a signed URL. It is what an operator needs
  -- to find the attachment again, and it is metadata only: nothing in
  -- a semantic text may ever contain it.
  source_media_id TEXT NOT NULL,

  -- Safe, factual image metadata. Not an interpretation.
  mime_type TEXT NOT NULL CHECK (
    mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif')
  ),
  byte_length INTEGER NOT NULL CHECK (byte_length > 0),
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  -- When the source message was created, carried here so an operator
  -- can order photographs without a second join.
  message_created_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT image_analysis_run_images_id_account_key UNIQUE (id, account_id),
  CONSTRAINT image_analysis_run_images_run_account_fk
    FOREIGN KEY (run_id, account_id)
    REFERENCES image_analysis_runs(id, account_id)
    ON DELETE CASCADE,
  -- One row per ordinal, and one row per photograph, within a run.
  CONSTRAINT image_analysis_run_images_one_per_ordinal UNIQUE (run_id, ordinal),
  CONSTRAINT image_analysis_run_images_one_per_source
    UNIQUE (run_id, source_message_id),
  CONSTRAINT image_analysis_run_images_source_media_format CHECK (
    length(btrim(source_media_id)) BETWEEN 1 AND 200
  ),
  -- The object path is metadata, so it may not smuggle a URL, a
  -- signed-URL query, a fragment, a credential or whitespace into
  -- storage.
  CONSTRAINT image_analysis_run_images_source_media_is_object_path CHECK (
    source_media_id NOT LIKE '%://%'
    AND source_media_id NOT LIKE '%?%'
    AND source_media_id NOT LIKE '%#%'
    AND source_media_id NOT LIKE '% %'
  )
);

-- "Which analyses have looked at this photograph?"
CREATE INDEX IF NOT EXISTS idx_image_analysis_run_images_source
  ON image_analysis_run_images (account_id, source_message_id);

CREATE INDEX IF NOT EXISTS idx_image_analysis_run_images_media
  ON image_analysis_run_images (account_id, source_media_id);

-- ============================================================
-- 3. IMAGE ANALYSIS OBSERVATIONS
--
-- One row per validated observation, ambiguity or quality report.
--
-- `payload` holds the validated structured fields EXACTLY as
-- `parseImageAnalysisResult` produced them (minus `sources`, which
-- live in the join table below). It is not a second schema: the
-- TypeScript layer re-parses it through the same closed vocabularies
-- before anything may read it, and a row that could not have been
-- written cannot be read back.
--
-- The scalar columns beside it are the fields objective 04 needs to
-- filter and group on. They are a projection of `payload`, not an
-- alternative to it, and the write guard proves they agree.
-- ============================================================

CREATE TABLE IF NOT EXISTS image_analysis_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  run_id UUID NOT NULL,

  -- `observation`, `ambiguous_item` or `image_quality`. The
  -- discriminator: an ambiguity and a quality report are NOT an
  -- observation about an item, and collapsing them would let "we
  -- could not tell" read as "we saw this".
  observation_type TEXT NOT NULL CHECK (observation_type IN (
    'observation', 'ambiguous_item', 'image_quality'
  )),
  -- Position within its own type in the validated result. Together
  -- with `observation_type` this is the observation's identity inside
  -- a run.
  ordinal_in_result INTEGER NOT NULL CHECK (ordinal_in_result >= 1),
  -- The validated `observation_id` (`obs-1`, …) for observations, and a
  -- `ambiguous-`/`quality-` prefixed identity otherwise. Retained so a
  -- snapshot built from these rows can name the same observation the
  -- tool output named.
  observation_ref TEXT NOT NULL,

  -- Projection of `payload`. Nullable because the three observation
  -- types carry different fields: an image_quality entry has a detail
  -- rather than a label, and an ambiguous item has a description and
  -- no `kind`.
  kind TEXT,
  label TEXT,
  confidence NUMERIC CHECK (
    confidence IS NULL OR (confidence >= 0 AND confidence <= 1)
  ),
  basis TEXT CHECK (basis IS NULL OR basis IN ('observed', 'ambiguous')),
  detail TEXT,

  -- The exact validated structured fields.
  payload JSONB NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT image_analysis_observations_id_account_key UNIQUE (id, account_id),
  CONSTRAINT image_analysis_observations_run_account_fk
    FOREIGN KEY (run_id, account_id)
    REFERENCES image_analysis_runs(id, account_id)
    ON DELETE CASCADE,
  CONSTRAINT image_analysis_observations_one_per_ref
    UNIQUE (run_id, observation_type, observation_ref),
  CONSTRAINT image_analysis_observations_ref_check CHECK (
    length(btrim(observation_ref)) BETWEEN 1 AND 64
  ),
  CONSTRAINT image_analysis_observations_payload_object CHECK (
    jsonb_typeof(payload) = 'object'
  ),
  -- Bounded, so one pathological provider answer cannot turn a
  -- learning record into an unbounded document.
  CONSTRAINT image_analysis_observations_payload_size CHECK (
    octet_length(payload::TEXT) <= 8192
  ),
  -- A type-appropriate minimum: an `observation` is meaningless
  -- without its kind and label, an `ambiguous_item` without its
  -- description, an `image_quality` entry without its issue kind.
  CONSTRAINT image_analysis_observations_projection_check CHECK (
    (observation_type = 'observation'
      AND kind IS NOT NULL AND label IS NOT NULL
      AND length(btrim(label)) BETWEEN 1 AND 120
      AND confidence IS NOT NULL
      AND basis IS NOT NULL
      AND detail IS NULL)
    OR (observation_type = 'ambiguous_item'
      AND kind IS NULL AND basis IS NULL AND detail IS NULL
      AND label IS NOT NULL AND length(btrim(label)) BETWEEN 1 AND 120
      AND confidence IS NOT NULL)
    OR (observation_type = 'image_quality'
      AND kind IS NOT NULL AND label IS NULL AND basis IS NULL
      AND confidence IS NULL
      AND (detail IS NULL OR length(btrim(detail)) <= 400))
  )
);

-- The learning read: a run's observations in result order.
CREATE INDEX IF NOT EXISTS idx_image_analysis_observations_run
  ON image_analysis_observations (run_id, observation_type, ordinal_in_result);

CREATE INDEX IF NOT EXISTS idx_image_analysis_observations_account_kind
  ON image_analysis_observations (account_id, kind)
  WHERE kind IS NOT NULL;

-- ============================================================
-- 4. OBSERVATION SOURCES
--
-- Which observation came from which photograph. Stored once per
-- (observation, image) pair, so an observation that legitimately spans
-- three photographs is ONE observation row plus three join rows -
-- never three duplicated observations.
-- ============================================================

CREATE TABLE IF NOT EXISTS image_analysis_observation_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  observation_id UUID NOT NULL,
  run_image_id UUID NOT NULL,
  -- Mirrors the image's ordinal, so a read of this table alone can
  -- answer "from photograph N" without a second join. The write guard
  -- proves it agrees with the referenced image row.
  source_ordinal INTEGER NOT NULL CHECK (source_ordinal >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT image_analysis_observation_sources_id_account_key
    UNIQUE (id, account_id),
  CONSTRAINT image_analysis_observation_sources_observation_account_fk
    FOREIGN KEY (observation_id, account_id)
    REFERENCES image_analysis_observations(id, account_id)
    ON DELETE CASCADE,
  CONSTRAINT image_analysis_observation_sources_image_account_fk
    FOREIGN KEY (run_image_id, account_id)
    REFERENCES image_analysis_run_images(id, account_id)
    ON DELETE CASCADE,
  -- A source is set membership, not a fact that can be recorded twice.
  CONSTRAINT image_analysis_observation_sources_unique
    UNIQUE (observation_id, run_image_id)
);

-- The per-image read: "which observations came from photograph N?"
CREATE INDEX IF NOT EXISTS idx_image_analysis_observation_sources_image
  ON image_analysis_observation_sources (account_id, run_image_id);

-- ============================================================
-- 5. WRITE GUARDS
-- ============================================================

-- 5a. Run identity is immutable; only lifecycle state and the
-- completion timestamp may move. A "correction" that quietly repoints
-- a run at different content or a different model would make every
-- downstream embedding and snapshot unreproducible.
CREATE OR REPLACE FUNCTION public.guard_image_analysis_run_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := NOW();
    NEW.updated_at := NEW.created_at;

    -- Fail closed on privacy: an analysis of an excluded case's
    -- photographs must never be stored as `current`.
    IF NEW.state = 'current' AND EXISTS (
      SELECT 1 FROM public.historical_cases c
      WHERE c.id = NEW.historical_case_id
        AND c.account_id = NEW.account_id
        AND c.learning_eligibility = 'excluded'
    ) THEN
      RAISE EXCEPTION
        'the source historical case is excluded from learning; its image analysis cannot be current'
        USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
     OR NEW.enquiry_id IS DISTINCT FROM OLD.enquiry_id
     OR NEW.historical_case_id IS DISTINCT FROM OLD.historical_case_id
     OR NEW.analyzer_id IS DISTINCT FROM OLD.analyzer_id
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.model IS DISTINCT FROM OLD.model
     OR NEW.analysis_schema_version IS DISTINCT FROM OLD.analysis_schema_version
     OR NEW.prompt_version IS DISTINCT FROM OLD.prompt_version
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.failure_reason IS DISTINCT FROM OLD.failure_reason
     OR NEW.image_count IS DISTINCT FROM OLD.image_count
     OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
     OR NEW.source_fingerprint IS DISTINCT FROM OLD.source_fingerprint
     OR NEW.result_content_hash IS DISTINCT FROM OLD.result_content_hash
     OR NEW.started_at IS DISTINCT FROM OLD.started_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'image analysis run identity and findings are immutable'
      USING ERRCODE = '23514';
  END IF;

  -- The mirror of the INSERT-time exclusion check. An analysis
  -- withheld by a privacy decision must not be turned back on by a
  -- privileged write while its case is still excluded. Re-including
  -- the CASE is the reversible, auditable decision, and it goes
  -- through the trigger in 5f.
  IF OLD.state = 'withheld' AND NEW.state <> 'withheld' AND EXISTS (
    SELECT 1 FROM public.historical_cases c
    WHERE c.id = OLD.historical_case_id
      AND c.account_id = OLD.account_id
      AND c.learning_eligibility = 'excluded'
  ) THEN
    RAISE EXCEPTION
      'an image analysis withheld by a case exclusion cannot be reactivated while the case is excluded'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.state = 'current' AND OLD.state <> 'current' THEN
    NEW.updated_at := NOW();
  ELSE
    NEW.updated_at := OLD.updated_at;
  END IF;

  RETURN NEW;
END;
$$;

-- 5b. A run image must be traceable to a real photograph in the run's
-- own conversation.
--
-- `messages` carries no `account_id` (migration 017 reaches it through
-- its parent conversation), so the boundary is proved here rather than
-- by a composite foreign key - exactly as migration 049 does for
-- `historical_case_facts.source_message_id`.
--
-- The object path is RE-DERIVED from the message row's own `media_url`
-- and compared. That is what makes "no arbitrary URL/path supplied by
-- the caller" a database guarantee: a caller cannot attribute an
-- observation to a photograph it did not analyse, and cannot invent a
-- path.
CREATE OR REPLACE FUNCTION public.guard_image_analysis_run_image_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conversation UUID;
  v_media_url TEXT;
  v_derived_path TEXT;
BEGIN
  SELECT m.conversation_id, m.media_url
  INTO v_conversation, v_media_url
  FROM public.messages m
  WHERE m.id = NEW.source_message_id;

  IF v_conversation IS NULL THEN
    RAISE EXCEPTION 'source_message_id does not exist'
      USING ERRCODE = '23503';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.conversations c
    WHERE c.id = v_conversation AND c.account_id = NEW.account_id
  ) THEN
    RAISE EXCEPTION 'source_message_id does not belong to this account'
      USING ERRCODE = '23503';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.image_analysis_runs r
    WHERE r.id = NEW.run_id
      AND r.account_id = NEW.account_id
      AND r.conversation_id = v_conversation
  ) THEN
    RAISE EXCEPTION
      'source_message_id is not part of the conversation this analysis ran in'
      USING ERRCODE = '23514';
  END IF;

  IF v_media_url IS NULL THEN
    RAISE EXCEPTION 'the source message has no media reference'
      USING ERRCODE = '23514';
  END IF;

  -- The same derivation as `resolveMediaObjectPath` in
  -- src/lib/ai/image-analysis/media.ts: parse the stored reference,
  -- require the analysis bucket, and take the object path from the
  -- canonical prefix. The URL's host is never used and nothing is
  -- fetched - this function performs no network call.
  IF v_media_url NOT LIKE 'https://%' THEN
    RAISE EXCEPTION
      'the source message media reference is not a WACRM media object'
      USING ERRCODE = '23514';
  END IF;
  v_derived_path := regexp_replace(
    v_media_url,
    '^https://[^/]+/storage/v1/object/public/chat-media/',
    ''
  );
  IF v_derived_path = v_media_url THEN
    RAISE EXCEPTION
      'the source message media reference is not a chat-media object'
      USING ERRCODE = '23514';
  END IF;
  IF v_derived_path IS DISTINCT FROM NEW.source_media_id THEN
    RAISE EXCEPTION
      'source_media_id must be the object path derived from the source message'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

-- 5c. An observation is immutable, may only exist under a successful
-- run, and its projection must agree with its payload.
CREATE OR REPLACE FUNCTION public.guard_image_analysis_observation_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_status TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT r.status INTO v_status
    FROM public.image_analysis_runs r
    WHERE r.id = NEW.run_id AND r.account_id = NEW.account_id;

    IF v_status IS NULL THEN
      RAISE EXCEPTION 'image analysis run not found in this account'
        USING ERRCODE = '23503';
    END IF;
    IF v_status <> 'succeeded' THEN
      RAISE EXCEPTION
        'only a validated, successful analysis may carry observations'
        USING ERRCODE = '23514';
    END IF;

    -- The projection is a denormalisation of `payload`, so the two must
    -- agree. Without this, a future edit could filter on `kind` while
    -- the embedded payload says something else - the classic
    -- silently-wrong-answer bug.
    IF NEW.observation_type = 'observation' THEN
      IF NEW.payload->>'kind' IS DISTINCT FROM NEW.kind
         OR NEW.payload->>'label' IS DISTINCT FROM NEW.label
         OR NEW.payload->>'basis' IS DISTINCT FROM NEW.basis
         OR (NEW.payload->>'confidence')::NUMERIC
              IS DISTINCT FROM NEW.confidence THEN
        RAISE EXCEPTION 'observation projection does not match its payload'
          USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.observation_type = 'ambiguous_item' THEN
      IF NEW.payload->>'description' IS DISTINCT FROM NEW.label
         OR (NEW.payload->>'confidence')::NUMERIC
              IS DISTINCT FROM NEW.confidence THEN
        RAISE EXCEPTION 'ambiguous item projection does not match its payload'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      IF NEW.payload->>'kind' IS DISTINCT FROM NEW.kind
         OR NEW.payload->>'detail' IS DISTINCT FROM NEW.detail THEN
        RAISE EXCEPTION 'image quality projection does not match its payload'
          USING ERRCODE = '23514';
      END IF;
    END IF;

    RETURN NEW;
  END IF;

  -- UPDATE: an observation is a statement about what a validated model
  -- saw. Amending it in place would silently rewrite the evidence a
  -- frozen case and an embedding were derived from.
  RAISE EXCEPTION 'image analysis observations are immutable'
    USING ERRCODE = '23514';
END;
$$;

-- 5d. A source link must join an observation and an image from the SAME
-- run, and its ordinal must be that image's ordinal.
CREATE OR REPLACE FUNCTION public.guard_image_analysis_observation_source_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_observation_run UUID;
  v_image_run UUID;
  v_ordinal INTEGER;
BEGIN
  SELECT o.run_id INTO v_observation_run
  FROM public.image_analysis_observations o
  WHERE o.id = NEW.observation_id AND o.account_id = NEW.account_id;

  IF v_observation_run IS NULL THEN
    RAISE EXCEPTION 'image analysis observation not found in this account'
      USING ERRCODE = '23503';
  END IF;

  SELECT i.run_id, i.ordinal INTO v_image_run, v_ordinal
  FROM public.image_analysis_run_images i
  WHERE i.id = NEW.run_image_id AND i.account_id = NEW.account_id;

  IF v_image_run IS NULL THEN
    RAISE EXCEPTION 'image analysis run image not found in this account'
      USING ERRCODE = '23503';
  END IF;

  IF v_image_run IS DISTINCT FROM v_observation_run THEN
    RAISE EXCEPTION
      'an observation may only reference images from its own analysis'
      USING ERRCODE = '23514';
  END IF;

  IF v_ordinal IS DISTINCT FROM NEW.source_ordinal THEN
    RAISE EXCEPTION
      'source_ordinal must match the referenced image ordinal'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

-- 5e. An observation without a surviving photograph is not evidence.
--
-- This is the deletion half of guarantee 2. Deleting a source message
-- cascades its run images away; without this trigger an observation
-- would survive with no traceable source and would still be readable as
-- learning memory about a photograph WACRM no longer holds. Pruning
-- removes it - and then removes a successful run that has no
-- observations left - rather than leaving an orphan retrievable.
CREATE OR REPLACE FUNCTION public.prune_image_analysis_orphans()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run UUID;
BEGIN
  -- The owning run is resolved THROUGH the observation rather than read
  -- from the deleted row. `image_analysis_observation_sources`
  -- deliberately has no `run_id` column: it would be a denormalisation
  -- that could disagree with the image row it points at, and the
  -- observation it references already carries the authoritative answer.
  SELECT o.run_id INTO v_run
  FROM public.image_analysis_observations o
  WHERE o.id = OLD.observation_id;

  DELETE FROM public.image_analysis_observations o
  WHERE o.id = OLD.observation_id
    AND NOT EXISTS (
      SELECT 1 FROM public.image_analysis_observation_sources s
      WHERE s.observation_id = o.id
    );

  IF v_run IS NOT NULL THEN
    DELETE FROM public.image_analysis_runs r
    WHERE r.id = v_run
      AND r.status = 'succeeded'
      AND NOT EXISTS (
        SELECT 1 FROM public.image_analysis_observations o
        WHERE o.run_id = r.id
      );
  END IF;

  RETURN OLD;
END;
$$;

-- 5f. Privacy propagation: a case exclusion must reach the analyses
-- derived from that case's photographs.
--
-- Both directions are handled so the decision stays reversible:
-- exclude withholds, include releases. Nothing is deleted, so an
-- accidental exclusion is undone by including the case again rather
-- than by re-running a paid vision call.
CREATE OR REPLACE FUNCTION public.sync_image_analysis_run_eligibility()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_state TEXT;
BEGIN
  IF NEW.learning_eligibility IS NOT DISTINCT FROM OLD.learning_eligibility THEN
    RETURN NEW;
  END IF;

  v_state := CASE
    WHEN NEW.learning_eligibility = 'excluded' THEN 'withheld'
    ELSE 'current'
  END;

  UPDATE public.image_analysis_runs r
  SET state = v_state
  WHERE r.historical_case_id = NEW.id
    AND r.account_id = NEW.account_id
    AND r.state IN ('current', 'withheld');

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_image_analysis_run_write ON image_analysis_runs;
CREATE TRIGGER guard_image_analysis_run_write
  BEFORE INSERT OR UPDATE ON image_analysis_runs
  FOR EACH ROW EXECUTE FUNCTION public.guard_image_analysis_run_write();

DROP TRIGGER IF EXISTS guard_image_analysis_run_image_write
  ON image_analysis_run_images;
CREATE TRIGGER guard_image_analysis_run_image_write
  BEFORE INSERT ON image_analysis_run_images
  FOR EACH ROW EXECUTE FUNCTION public.guard_image_analysis_run_image_write();

DROP TRIGGER IF EXISTS guard_image_analysis_observation_write
  ON image_analysis_observations;
CREATE TRIGGER guard_image_analysis_observation_write
  BEFORE INSERT OR UPDATE ON image_analysis_observations
  FOR EACH ROW EXECUTE FUNCTION public.guard_image_analysis_observation_write();

DROP TRIGGER IF EXISTS guard_image_analysis_observation_source_write
  ON image_analysis_observation_sources;
CREATE TRIGGER guard_image_analysis_observation_source_write
  BEFORE INSERT ON image_analysis_observation_sources
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_image_analysis_observation_source_write();

DROP TRIGGER IF EXISTS prune_image_analysis_orphans
  ON image_analysis_observation_sources;
CREATE TRIGGER prune_image_analysis_orphans
  AFTER DELETE ON image_analysis_observation_sources
  FOR EACH ROW EXECUTE FUNCTION public.prune_image_analysis_orphans();

DROP TRIGGER IF EXISTS sync_image_analysis_run_eligibility
  ON historical_cases;
CREATE TRIGGER sync_image_analysis_run_eligibility
  AFTER UPDATE OF learning_eligibility ON historical_cases
  FOR EACH ROW EXECUTE FUNCTION public.sync_image_analysis_run_eligibility();

DROP TRIGGER IF EXISTS set_updated_at_image_analysis_runs
  ON image_analysis_runs;
CREATE TRIGGER set_updated_at_image_analysis_runs
  BEFORE UPDATE ON image_analysis_runs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 5g. Price and weight cannot enter a persisted payload, even by
-- key name nobody thought to check.
--
-- The TypeScript validator (`parseImageAnalysisResult`) already rejects
-- a pricing or weight key, so this is defence in depth rather than the
-- primary defence. It is here because the database is the layer a
-- service-role write cannot bypass: without it, a privileged write could
-- put `{"label":"sofa","price":120}` into a learning record and the
-- retrieval layer would have no way to know.
--
-- The word list mirrors `FORBIDDEN_FIELD_WORDS` in
-- `src/lib/ai/image-analysis/result.ts`, and the check walks the payload
-- recursively so a nested object cannot smuggle a key past it.
CREATE OR REPLACE FUNCTION public.image_analysis_observation_payload_clean(
  p_payload JSONB
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  WITH RECURSIVE nodes(value) AS (
    -- A recursive CTE may reference itself only in its non-recursive
    -- (second) term, so both descent branches - object values and array
    -- elements - are combined into that single term.
    SELECT p_payload
    UNION ALL
    SELECT child.value
    FROM nodes n
    CROSS JOIN LATERAL (
      SELECT value FROM jsonb_each(
        CASE WHEN jsonb_typeof(n.value) = 'object'
             THEN n.value ELSE '{}'::JSONB END
      )
      UNION ALL
      SELECT element.value FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(n.value) = 'array'
             THEN n.value ELSE '[]'::JSONB END
      ) AS element(value)
    ) AS child(value)
  ),
  keys AS (
    -- `jsonb_object_keys` returns TEXT, but the recursion carries JSONB
    -- nodes, so the key is cast back down to text for the pattern match.
    SELECT k.key::TEXT AS key
    FROM nodes n
    CROSS JOIN LATERAL jsonb_object_keys(
      CASE WHEN jsonb_typeof(n.value) = 'object' THEN n.value ELSE '{}'::JSONB END
    ) AS k(key)
  )
  SELECT NOT EXISTS (
    SELECT 1 FROM keys
    WHERE lower(key) ~ (
      '(^|_)(price|prices|pricing|cost|costs|charge|charges|charged|charging|'
      || 'fee|fees|amount|amounts|quote|quotes|quoted|payment|paid|'
      || 'invoice|invoices|bill|billed|budget|rate|rates|surcharge|markup|'
      || 'weight|weights|kg|kgs|kilo|kilos|kilogram|kilograms|'
      || 'tonne|tonnes|ton|tons|pounds|gbp|eur|usd|inr|brl|currency|currencies)(_|$)'
    )
  );
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'image_analysis_observations_payload_clean_check'
      AND conrelid = 'public.image_analysis_observations'::regclass
  ) THEN
    ALTER TABLE image_analysis_observations
      ADD CONSTRAINT image_analysis_observations_payload_clean_check
      CHECK (public.image_analysis_observation_payload_clean(payload));
  END IF;
END
$$;

-- ============================================================
-- 6. ROW LEVEL SECURITY
--
-- Observations describe customer photographs and what a model said
-- about them, so reads are account-scoped and member-only. Writes are
-- agent-and-above, matching `historical_case_facts` and `enquiries`:
-- recording an analysis is ordinary operator/domain work, unlike the
-- admin-gated paid re-embedding path in migration 053.
--
-- There is deliberately no authenticated DELETE policy. Derived
-- observations are removed only through a source / case / conversation /
-- account cascade, i.e. only when somebody decided the source data
-- itself is gone.
-- ============================================================

ALTER TABLE image_analysis_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE image_analysis_run_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE image_analysis_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE image_analysis_observation_sources ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS image_analysis_runs_select ON image_analysis_runs;
CREATE POLICY image_analysis_runs_select ON image_analysis_runs FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS image_analysis_runs_insert ON image_analysis_runs;
CREATE POLICY image_analysis_runs_insert ON image_analysis_runs FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS image_analysis_runs_update ON image_analysis_runs;
CREATE POLICY image_analysis_runs_update ON image_analysis_runs FOR UPDATE
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS image_analysis_run_images_select
  ON image_analysis_run_images;
CREATE POLICY image_analysis_run_images_select ON image_analysis_run_images
  FOR SELECT USING (is_account_member(account_id));

DROP POLICY IF EXISTS image_analysis_run_images_insert
  ON image_analysis_run_images;
CREATE POLICY image_analysis_run_images_insert ON image_analysis_run_images
  FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS image_analysis_observations_select
  ON image_analysis_observations;
CREATE POLICY image_analysis_observations_select ON image_analysis_observations
  FOR SELECT USING (is_account_member(account_id));

DROP POLICY IF EXISTS image_analysis_observations_insert
  ON image_analysis_observations;
CREATE POLICY image_analysis_observations_insert ON image_analysis_observations
  FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS image_analysis_observation_sources_select
  ON image_analysis_observation_sources;
CREATE POLICY image_analysis_observation_sources_select
  ON image_analysis_observation_sources FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS image_analysis_observation_sources_insert
  ON image_analysis_observation_sources;
CREATE POLICY image_analysis_observation_sources_insert
  ON image_analysis_observation_sources FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

-- ============================================================
-- 7. GRANTS
-- ============================================================
ALTER FUNCTION public.image_analysis_observation_payload_clean(JSONB)
  OWNER TO postgres;
ALTER FUNCTION public.guard_image_analysis_run_write() OWNER TO postgres;
ALTER FUNCTION public.guard_image_analysis_run_image_write() OWNER TO postgres;
ALTER FUNCTION public.guard_image_analysis_observation_write() OWNER TO postgres;
ALTER FUNCTION public.guard_image_analysis_observation_source_write()
  OWNER TO postgres;
ALTER FUNCTION public.prune_image_analysis_orphans() OWNER TO postgres;
ALTER FUNCTION public.sync_image_analysis_run_eligibility() OWNER TO postgres;

REVOKE ALL ON FUNCTION public.image_analysis_observation_payload_clean(JSONB)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_image_analysis_run_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_image_analysis_run_image_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_image_analysis_observation_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_image_analysis_observation_source_write()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prune_image_analysis_orphans() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_image_analysis_run_eligibility() FROM PUBLIC;

-- The payload-clean validator runs from a CHECK constraint, so every
-- role that may write an observation needs EXECUTE on it.
GRANT EXECUTE ON FUNCTION public.image_analysis_observation_payload_clean(JSONB)
  TO authenticated, service_role;
