-- ============================================================
-- 053_embeddings_vector_memory.sql - the account-scoped vector
-- memory for historical cases.
--
-- Roadmap objective 03 (Embeddings and Vector Memory).
--
-- This migration creates MEMORY, not a quote prediction. There is no
-- similarity ranking here, no hybrid pricing, no confidence, and no
-- learned estimator. What it adds is the durable, versioned store
-- that objective 04 (Similar Job and Image Retrieval) will read,
-- plus the guarantees that make a store of vectors safe to keep:
--
--   1. MODEL / VERSION PINNING. A vector produced by model A is
--      never silently comparable with a vector produced by model B.
--      `public.case_embedding_registered_model` is a closed registry
--      mapping (provider, model, model_version) to a dimension
--      count; a row that does not match a registered combination is
--      rejected by a CHECK constraint, and every vector in the table
--      therefore belongs to exactly one compatibility group.
--   2. IDEMPOTENCY. A unique index over the identity of an embedding
--      (account, case, kind, semantic input version, provider, model,
--      model version, content hash) means the same content under the
--      same model can never produce two rows, and a partial unique
--      index means a case has at most ONE current embedding per kind.
--   3. STALENESS OVER SILENT OVERWRITE. Content change, model change
--      and a corrected source all produce a NEW row and mark the
--      previous one `stale`. The old vector is retained so a
--      retrieval result stays reproducible and a bad re-embedding is
--      reversible.
--   4. PRICE-LEAKAGE BY CONSTRUCTION. The table stores no monetary
--      column at all. Quoted, approved, suggested and collected
--      amounts remain canonical domain data on `historical_case_facts`
--      and `quotes`; a comparable case is retrieved by what it WAS,
--      and its money is joined afterwards by objective 04.
--   5. PRIVACY PROPAGATION. `learning_eligibility = 'excluded'` moves
--      the case's current embeddings to `withheld` from a trigger, and
--      a withheld embedding cannot be reactivated while its case is
--      still excluded. Deleting the case cascades to its vectors.
--      Derived memory therefore cannot outlive a privacy decision.
--
-- What this migration deliberately does NOT add:
--
--   * No `native_image` vectors. There is no approved provider in this
--     architecture that produces a native image embedding for WACRM's
--     controlled media, so the kind exists in the vocabulary as
--     explicitly unsupported and is not silently approximated by
--     embedding the text of a vision model's observations.
--   * No nearest-neighbour RPC, no ranking, no weights, no retrieval.
--   * No pricing. Nothing here reads or writes a monetary value.
--   * No background or automatic embedding generation. This migration
--     contains no data at all, so applying it costs nothing. Vectors
--     are produced only by an explicit, admin-triggered, bounded,
--     dry-runnable operation.
--   * No second AI configuration system. Embeddings continue to use
--     the existing `ai_configs.embeddings_api_key` from migration 030
--     and the existing `src/lib/ai/embeddings.ts` client.
--
-- Idempotent and additive.
-- ============================================================

-- Already enabled by 030 for the knowledge base. Re-stated so this
-- file is readable on its own and so a database that somehow lost it
-- fails here rather than at CREATE TABLE.
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================
-- 1. THE MODEL REGISTRY
--
-- The set of embedding models whose vectors WACRM knows how to store
-- and compare, and the dimension count each one produces.
--
-- This is deliberately a function with one hard-coded entry rather
-- than a table. A table would let a row be added at runtime, and a
-- runtime-added model is a way for two incompatible vector spaces to
-- end up sharing one index without anybody deciding that. Adding a
-- model is a migration, which is the point.
--
-- A new model therefore means, in one reviewed change:
--   * a new entry here,
--   * a decision about whether it shares the `vector(1536)` column or
--     gets its own column and its own HNSW index (see section 5),
--   * an explicit re-embedding plan for existing rows.
--
-- NULL means "not registered", and the CHECK constraint below turns
-- that into a rejected row rather than a silent store of vectors
-- whose dimensionality nobody has verified.
-- ============================================================
CREATE OR REPLACE FUNCTION public.case_embedding_registered_model(
  p_provider       TEXT,
  p_embedding_model TEXT,
  p_model_version  TEXT
)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    -- The single registered text-embedding model. Same provider,
    -- same 1536 dimensions and therefore the same column and the
    -- same HNSW index as `ai_knowledge_chunks` uses.
    WHEN p_provider = 'openai'
      AND p_embedding_model = 'text-embedding-3-small'
      AND p_model_version = 'text-embedding-3-small-1536-v1'
      THEN 1536
    ELSE NULL
  END;
$$;

-- ============================================================
-- 2. CASE EMBEDDINGS
--
-- One row per (case, kind, model, content). A case therefore has as
-- many rows as it has needed embedding revisions, and at most one
-- CURRENT row per kind (enforced in section 4).
--
-- There is deliberately no money here. See the header.
-- ============================================================
CREATE TABLE IF NOT EXISTS case_embeddings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  historical_case_id UUID NOT NULL,

  -- What the vector represents. `case_text` is a text embedding of the
  -- canonical business description of the job. `image_observation_text`
  -- is a text embedding derived from validated structured visual
  -- observations - it is NOT a pixel/visual vector and must never be
  -- presented as one. `native_image` is a true visual vector; it is
  -- registered as a kind so the vocabulary is explicit, but nothing
  -- can currently produce one.
  embedding_kind TEXT NOT NULL CHECK (embedding_kind IN (
    'case_text',
    'image_observation_text',
    'native_image'
  )),

  -- Which canonical record the semantic input was derived from.
  source_entity TEXT NOT NULL CHECK (source_entity IN (
    'historical_case',
    'historical_case_snapshot'
  )),
  -- A non-secret, bounded reference back to that record: a snapshot id,
  -- or a source media id for an image-observation embedding. Never a
  -- URL, never a signed URL, never a storage path, never an api key.
  source_reference TEXT,
  -- The version of the deterministic semantic-input builder that
  -- produced `content_hash`. Bumping it deliberately re-embeds
  -- everything, because the text it produces has changed meaning.
  semantic_input_version TEXT NOT NULL,

  -- SHA-256 (lowercase hex) of the exact text handed to the provider.
  -- This is the idempotency key for the whole operation: same content
  -- under the same model can never produce two rows.
  content_hash TEXT NOT NULL,

  -- The compatibility group. Two vectors may only ever be compared
  -- when all four of these match.
  provider TEXT NOT NULL,
  embedding_model TEXT NOT NULL,
  model_version TEXT NOT NULL,
  dimensions INTEGER NOT NULL,

  vector vector(1536) NOT NULL,

  -- `current`    participates in active retrieval.
  -- `stale`      the source content or the model changed; a newer row
  --              replaced it. Retained for reproducibility.
  -- `superseded` explicitly replaced, with `superseded_by` naming the
  --              row that replaced it.
  -- `withheld`   the source case is excluded from learning. Present
  --              and auditable, never retrievable.
  state TEXT NOT NULL DEFAULT 'current'
    CHECK (state IN ('current', 'stale', 'superseded', 'withheld')),

  superseded_by UUID,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Last time this row became the current representation of its
  -- source. Distinct from `created_at`, which is when the vector was
  -- first computed; a re-activated row keeps both.
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT case_embeddings_id_account_key UNIQUE (id, account_id),
  -- Account-scoped composite foreign key, the same boundary the
  -- historical-case model uses. A privileged write cannot attach a
  -- vector to another account's case, and deleting the case (or the
  -- account) removes the derived memory with it.
  CONSTRAINT case_embeddings_case_account_fk
    FOREIGN KEY (historical_case_id, account_id)
    REFERENCES historical_cases(id, account_id)
    ON DELETE CASCADE,
  -- The supersede chain stays inside the account and is deferred so
  -- the new row can be inserted before the old one is repointed.
  CONSTRAINT case_embeddings_superseded_by_account_fk
    FOREIGN KEY (superseded_by, account_id)
    REFERENCES case_embeddings(id, account_id)
    DEFERRABLE INITIALLY DEFERRED,

  -- Every vector in this table belongs to exactly one registered
  -- model, at exactly its registered dimensionality. COALESCE, not
  -- `=`, because an unregistered combination yields NULL and a CHECK
  -- that evaluates to NULL passes.
  CONSTRAINT case_embeddings_model_registered_check CHECK (
    COALESCE(
      public.case_embedding_registered_model(
        provider, embedding_model, model_version
      ),
      -1
    ) = dimensions
  ),
  CONSTRAINT case_embeddings_dimensions_positive_check CHECK (
    dimensions > 0
  ),
  CONSTRAINT case_embeddings_content_hash_check CHECK (
    content_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT case_embeddings_source_reference_check CHECK (
    source_reference IS NULL OR length(btrim(source_reference)) BETWEEN 1 AND 200
  ),
  CONSTRAINT case_embeddings_semantic_input_version_check CHECK (
    length(btrim(semantic_input_version)) BETWEEN 1 AND 64
  ),
  CONSTRAINT case_embeddings_model_version_check CHECK (
    length(btrim(model_version)) BETWEEN 1 AND 64
  ),
  -- Supersession is expressed, not implied.
  CONSTRAINT case_embeddings_state_supersede_check CHECK (
    (state = 'superseded' AND superseded_by IS NOT NULL)
    OR (state <> 'superseded' AND superseded_by IS NULL)
  )
);

-- ============================================================
-- 3. INDEXES
-- ============================================================

-- "Which vectors does this account currently hold for this case?"
CREATE INDEX IF NOT EXISTS idx_case_embeddings_account_case
  ON case_embeddings (account_id, historical_case_id);

-- The generation path: bounded batches of cases that still need a
-- vector, newest first, deterministic tiebreak on id.
CREATE INDEX IF NOT EXISTS idx_case_embeddings_account_state_kind
  ON case_embeddings (account_id, embedding_kind, state, created_at DESC);

-- Account coverage reporting.
CREATE INDEX IF NOT EXISTS idx_case_embeddings_account_kind
  ON case_embeddings (account_id, embedding_kind);

-- ============================================================
-- 4. IDEMPOTENCY
--
-- Two uniqueness rules, and they answer different questions.
-- ============================================================

-- (a) One CURRENT embedding per (case, kind). Objective 04 reads only
--     `current` rows, so without this a re-run could put two vectors
--     for the same purpose into the same neighbourhood and a
--     comparison would silently double-count a job.
CREATE UNIQUE INDEX IF NOT EXISTS idx_case_embeddings_one_current
  ON case_embeddings (account_id, historical_case_id, embedding_kind)
  WHERE state = 'current';

-- (b) One row per (source, kind, semantic input version, model,
--     content). This is the content-hash dedup: regenerating an
--     unchanged case under an unchanged model is a no-op, no matter
--     how many times the bounded operation runs.
CREATE UNIQUE INDEX IF NOT EXISTS idx_case_embeddings_identity_unique
  ON case_embeddings (
    account_id,
    historical_case_id,
    embedding_kind,
    semantic_input_version,
    provider,
    embedding_model,
    model_version,
    content_hash
  );

-- ============================================================
-- 5. VECTOR INDEX
--
-- Distance metric: COSINE (`vector_cosine_ops`).
--
-- Chosen because every embedding model registered above emits L2
-- normalised vectors, so cosine distance and inner product rank
-- identically, and because cosine is what `match_ai_knowledge_semantic`
-- already compares with for the knowledge base - one metric across
-- both vector stores rather than two that disagree by a scale factor.
--
-- HNSW rather than IVFFlat, for the reason recorded in migration 030:
-- per-account case vectors start empty and grow incrementally, and
-- IVFFlat has to be trained on existing rows, so its centroids are
-- meaningless - and its recall poor - until the table is large enough
-- to REINDEX. HNSW needs no training.
--
-- COMPATIBILITY GROUPS. This one index is correct today because the
-- registry in section 1 holds exactly one entry, so every row in the
-- table is a 1536-dimension OpenAI vector from the same model and
-- therefore comparable. If a second model is ever registered, this
-- index must NOT be shared across two vector spaces: the new model
-- gets its own column and its own index, and objective 04 selects the
-- index by compatibility group. Mixing two vector spaces in one ANN
-- index is the classic silent-wrong-answer bug, which is why the
-- registry is a migration and not a runtime setting.
--
-- Filters (`state`, `account_id`) are applied by the caller above the
-- ANN scan. At learning-dataset scale (hundreds to low thousands of
-- vectors per account) a partial index is not worth the write-path
-- complexity; revisit when it is.
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_case_embeddings_vector_hnsw
  ON case_embeddings USING hnsw (vector vector_cosine_ops);

-- ============================================================
-- 6. WRITE GUARDS
--
-- The invariants that must hold even on a service-role write, which
-- bypasses RLS entirely.
-- ============================================================

-- 6a. An embedding row: identity is immutable, only liveness moves.
CREATE OR REPLACE FUNCTION public.guard_case_embedding_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := NOW();
    NEW.refreshed_at := COALESCE(NEW.refreshed_at, NEW.created_at);

    -- Fail closed on privacy: a vector for a case that is currently
    -- excluded must never be stored as `current`. The trigger in 6c
    -- handles the existing rows; this handles the new one.
    IF NEW.state = 'current' AND EXISTS (
      SELECT 1 FROM public.historical_cases c
      WHERE c.id = NEW.historical_case_id
        AND c.account_id = NEW.account_id
        AND c.learning_eligibility = 'excluded'
    ) THEN
      RAISE EXCEPTION
        'the source historical case is excluded from learning; its embedding cannot be current'
        USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
  END IF;

  -- The vector itself, and everything that identifies which model and
  -- which content produced it, is frozen. A "correction" that quietly
  -- repoints a row at different content would make every past
  -- retrieval result unreproducible.
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.historical_case_id IS DISTINCT FROM OLD.historical_case_id
     OR NEW.embedding_kind IS DISTINCT FROM OLD.embedding_kind
     OR NEW.source_entity IS DISTINCT FROM OLD.source_entity
     OR NEW.source_reference IS DISTINCT FROM OLD.source_reference
     OR NEW.semantic_input_version IS DISTINCT FROM OLD.semantic_input_version
     OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.embedding_model IS DISTINCT FROM OLD.embedding_model
     OR NEW.model_version IS DISTINCT FROM OLD.model_version
     OR NEW.dimensions IS DISTINCT FROM OLD.dimensions
     OR NEW.vector IS DISTINCT FROM OLD.vector
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'case embedding identity and vector are immutable'
      USING ERRCODE = '23514';
  END IF;

  -- The mirror of 6a's exclusion check. A withheld vector is the
  -- memory of a case an operator or a privacy request removed from
  -- learning, so it must not be turned back on by a privileged write
  -- while the case is still excluded. Re-inclusion of the CASE (which
  -- is the reversible, auditable decision) is the only way out, and it
  -- goes through the trigger in 6c.
  IF OLD.state = 'withheld' AND NEW.state <> 'withheld' AND EXISTS (
    SELECT 1 FROM public.historical_cases c
    WHERE c.id = OLD.historical_case_id
      AND c.account_id = OLD.account_id
      AND c.learning_eligibility = 'excluded'
  ) THEN
    RAISE EXCEPTION
      'an embedding withheld by a case exclusion cannot be reactivated while the case is excluded'
      USING ERRCODE = '23514';
  END IF;

  -- Only becoming-current refreshes. A stale-marking must not rewrite
  -- the age of the vector it is retiring.
  IF NEW.state = 'current' AND OLD.state <> 'current' THEN
    NEW.refreshed_at := NOW();
  ELSE
    NEW.refreshed_at := OLD.refreshed_at;
  END IF;

  RETURN NEW;
END;
$$;

-- 6b. Privacy propagation: an exclusion must reach the vectors.
--
-- `historical_cases.learning_eligibility` already means "this case is
-- withheld from learning, with a reason" (migration 049, widened for
-- finalized cases by 050). Without this trigger that decision would
-- stop at the case row, and the vector memory - derived data that
-- still physically contains the job description - would remain
-- retrievable after an operator excluded the case, which is exactly
-- the gap a privacy request is meant to close.
--
-- Both directions are handled so the decision stays reversible:
-- exclude -> withhold, include/pending -> release. The vectors are not
-- deleted, so an accidental exclusion is undone by including the case
-- again rather than by regenerating paid embeddings.
CREATE OR REPLACE FUNCTION public.sync_case_embedding_eligibility()
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

  -- `superseded` and `stale` rows are history and stay as they are.
  -- They are not retrievable, so withholding them too would destroy
  -- the reproducibility record for no privacy gain.
  UPDATE public.case_embeddings e
  SET state = v_state
  WHERE e.historical_case_id = NEW.id
    AND e.account_id = NEW.account_id
    AND e.state IN ('current', 'withheld');

  RETURN NEW;
END;
$$;

-- 6c. Deletion propagation is a foreign key, not a trigger: the
-- composite `case_embeddings_case_account_fk` is ON DELETE CASCADE, so
-- a deleted case (or a deleted account) takes its derived memory with
-- it. `privacy_deletion` is an EXCLUSION reason in the current model,
-- which withholds rather than deletes; a future hard-delete path
-- inherits cascade removal for free.

DROP TRIGGER IF EXISTS guard_case_embedding_write ON case_embeddings;
CREATE TRIGGER guard_case_embedding_write
  BEFORE INSERT OR UPDATE ON case_embeddings
  FOR EACH ROW EXECUTE FUNCTION public.guard_case_embedding_write();

DROP TRIGGER IF EXISTS sync_case_embedding_eligibility
  ON historical_cases;
CREATE TRIGGER sync_case_embedding_eligibility
  AFTER UPDATE OF learning_eligibility ON historical_cases
  FOR EACH ROW EXECUTE FUNCTION public.sync_case_embedding_eligibility();

-- ============================================================
-- 7. ROW LEVEL SECURITY
--
-- Reading is account-scoped and member-only: vectors describe customer
-- jobs, so there is no anon access and no cross-account read.
--
-- Writing is admin-and-above, matching `canImportHistoricalData` and
-- the migration-051/052 write policies. Embedding generation spends the
-- account's own money on a paid API, so an ordinary agent must not be
-- able to trigger a bulk re-embed of the dataset.
--
-- There is deliberately NO authenticated DELETE policy. Vectors are
-- superseded, never deleted, so that a past retrieval result stays
-- reproducible. The only removal is the account/case cascade, which is
-- the one deletion that is a business decision.
-- ============================================================
ALTER TABLE case_embeddings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS case_embeddings_select ON case_embeddings;
CREATE POLICY case_embeddings_select ON case_embeddings FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS case_embeddings_insert ON case_embeddings;
CREATE POLICY case_embeddings_insert ON case_embeddings FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS case_embeddings_update ON case_embeddings;
CREATE POLICY case_embeddings_update ON case_embeddings FOR UPDATE
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

-- ============================================================
-- 8. USAGE LOGGING
--
-- Embeddings spend the account's BYO key, so the spend belongs in the
-- EXISTING `ai_usage_log` trail rather than a second accounting system
-- (the same reasoning migration 048 used for `image_analysis`).
--
-- `logAiUsage` skips a row when the provider reports no usage, which
-- is why the embeddings client now returns the provider's usage block
-- instead of discarding it. No column is added and no existing row
-- changes meaning.
-- ============================================================
ALTER TABLE ai_usage_log
  DROP CONSTRAINT IF EXISTS ai_usage_log_mode_check;

ALTER TABLE ai_usage_log
  ADD CONSTRAINT ai_usage_log_mode_check
  CHECK (mode IN ('auto_reply', 'draft', 'image_analysis', 'embeddings'));

-- ============================================================
-- 9. GRANTS
-- ============================================================
ALTER FUNCTION public.case_embedding_registered_model(TEXT, TEXT, TEXT)
  OWNER TO postgres;
ALTER FUNCTION public.guard_case_embedding_write() OWNER TO postgres;
ALTER FUNCTION public.sync_case_embedding_eligibility() OWNER TO postgres;

-- The registry runs from a CHECK constraint, so every role that may
-- write an embedding needs EXECUTE on it.
GRANT EXECUTE ON FUNCTION public.case_embedding_registered_model(TEXT, TEXT, TEXT)
  TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.case_embedding_registered_model(TEXT, TEXT, TEXT)
  FROM PUBLIC;
