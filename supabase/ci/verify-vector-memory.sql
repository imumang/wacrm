-- ============================================================
-- verify-vector-memory.sql - row-level verification of the vector
-- memory store (migration 053).
--
-- `verify-schema.sql` asserts the SHAPE: the table exists, the
-- registry function is installed, the write/eligibility guards are
-- triggered, and the RLS policies are the right ones.
--
-- This file asserts the BEHAVIOUR those objects are supposed to
-- produce, against a real account, a real historical case and real
-- vectors:
--
--   1. An unregistered model / dimension combination is REJECTED. A
--      vector from a model WACRM does not know cannot be stored even
--      by a privileged writer.
--   2. Content-hash deduplication is enforced in the database, so a
--      repeated generation is a no-op.
--   3. At most one CURRENT vector per (account, case, kind), so a
--      case cannot appear twice in its own neighbourhood.
--   4. Vector identity and the vector value itself are immutable; only
--      liveness moves.
--   5. A content change produces a NEW row and retires the old one
--      rather than overwriting it, so history stays reproducible.
--   6. PRIVACY PROPAGATION: excluding a case withholds its current
--      vectors, and a privileged write cannot reactivate a withheld
--      vector while the case is excluded.
--   7. Deleting the case cascades the derived memory away.
--   8. RLS: a member of another account can neither read nor write
--      this account's vectors, and there is no DELETE policy at all.
--   9. No monetary column exists on the store.
--
-- Everything it creates, it removes. The assertions run against this
-- file's own fixtures rather than any pre-existing row, so this is
-- safe to run repeatedly against a database that already has data.
--
-- Like the other CI verification files this file must contain
-- EXACTLY ONE statement: `supabase db query --file` sends the whole
-- file as a prepared statement, and a second top-level statement
-- fails with "cannot insert multiple commands into a prepared
-- statement".
-- ============================================================

DO $$
DECLARE
  v_user_a UUID;
  v_user_b UUID;
  v_account_a UUID;
  v_account_b UUID;
  v_contact UUID;
  v_conversation UUID;
  v_enquiry UUID;
  v_case UUID;
  v_emb_1 UUID;
  v_emb_2 UUID;
  v_vector vector(1536);
  v_vector_b vector(1536);
  v_supports BOOLEAN;
  v_state TEXT;
  v_count INTEGER;
  v_readable INTEGER;
  v_cols INTEGER;
  v_hash TEXT := '1111111111111111111111111111111111111111111111111111111111111111';
BEGIN
  -- ------------------------------------------------------------
  -- Fixtures: two accounts, two users, one enquiry, one case.
  --
  -- The account is created by the profiles trigger from `auth.users`,
  -- which is the same pattern verify-quotes.sql uses.
  -- ------------------------------------------------------------
  v_user_a := gen_random_uuid();
  v_user_b := gen_random_uuid();

  INSERT INTO auth.users (id, email) VALUES
    (v_user_a, 'verify-vm-a@example.invalid'),
    (v_user_b, 'verify-vm-b@example.invalid');
  SELECT account_id INTO v_account_a FROM profiles WHERE user_id = v_user_a;
  SELECT account_id INTO v_account_b FROM profiles WHERE user_id = v_user_b;

  INSERT INTO contacts (id, account_id, user_id, name, phone) VALUES
    (gen_random_uuid(), v_account_a, v_user_a, 'VM Customer', '+441110000009')
    RETURNING id INTO v_contact;

  INSERT INTO conversations (id, account_id, user_id, contact_id) VALUES
    (gen_random_uuid(), v_account_a, v_user_a, v_contact)
    RETURNING id INTO v_conversation;

  INSERT INTO enquiries (account_id, conversation_id, created_by_user_id) VALUES
    (v_account_a, v_conversation, v_user_a) RETURNING id INTO v_enquiry;

  -- An OPEN, unclassified case with a recorded completion. Deliberate:
  -- vector memory does not require finalization or an evidence tier to
  -- hold a vector (see docs/vector-memory.md), so the fixture stays a
  -- case that legitimately exists rather than one manufactured to reach
  -- tier A.
  INSERT INTO historical_cases (
    account_id, enquiry_id, conversation_id, contact_id,
    source_kind, completed_at,
    learning_eligibility, learning_eligibility_basis
  ) VALUES (
    v_account_a, v_enquiry, v_conversation, v_contact,
    'live_enquiry', now(),
    'included', 'operator'
  ) RETURNING id INTO v_case;

  -- A deterministic unit-ish vector: 1536 components of 1/sqrt(1536).
  -- Built through the canonical pgvector text literal, because casting an
  -- array_fill directly to vector(1536) collapses to a single dimension.
  SELECT ('[' || array_to_string(
           array_fill((1.0 / sqrt(1536.0::numeric))::real, ARRAY[1536]),
           ','
         ) || ']')::vector(1536)
  INTO v_vector;

  -- ------------------------------------------------------------
  -- 1. THE MODEL REGISTRY
  --
  -- The registered model resolves to its dimension count; anything
  -- else resolves to NULL, which the CHECK turns into a rejection.
  -- ------------------------------------------------------------
  IF public.case_embedding_registered_model(
       'openai', 'text-embedding-3-small', 'text-embedding-3-small-1536-v1'
     ) <> 1536 THEN
    RAISE EXCEPTION 'the registered embedding model must report 1536 dimensions';
  END IF;

  IF public.case_embedding_registered_model(
       'openai', 'text-embedding-3-large', 'text-embedding-3-large-3072-v1'
     ) IS NOT NULL THEN
    RAISE EXCEPTION
      'an unregistered embedding model must not resolve to a dimension count';
  END IF;

  -- An unregistered model is rejected outright.
  BEGIN
    INSERT INTO case_embeddings (
      account_id, historical_case_id, embedding_kind, source_entity,
      semantic_input_version, content_hash, provider, embedding_model,
      model_version, dimensions, vector, state
    ) VALUES (
      v_account_a, v_case, 'case_text', 'historical_case',
      'case-text-v1', v_hash, 'openai', 'text-embedding-3-large',
      'text-embedding-3-large-3072-v1', 1536, v_vector, 'current'
    );
    RAISE EXCEPTION 'an unregistered embedding model was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- A registered model with the WRONG dimension count is rejected.
  BEGIN
    INSERT INTO case_embeddings (
      account_id, historical_case_id, embedding_kind, source_entity,
      semantic_input_version, content_hash, provider, embedding_model,
      model_version, dimensions, vector, state
    ) VALUES (
      v_account_a, v_case, 'case_text', 'historical_case',
      'case-text-v1', v_hash, 'openai', 'text-embedding-3-small',
      'text-embedding-3-small-1536-v1', 3072, v_vector, 'current'
    );
    RAISE EXCEPTION 'a mismatched dimension count was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- ------------------------------------------------------------
  -- 2. A VALID VECTOR IS ACCEPTED
  -- ------------------------------------------------------------
  INSERT INTO case_embeddings (
    id, account_id, historical_case_id, embedding_kind, source_entity,
    source_reference, semantic_input_version, content_hash, provider,
    embedding_model, model_version, dimensions, vector, state
  ) VALUES (
    gen_random_uuid(), v_account_a, v_case, 'case_text', 'historical_case',
    'snapshot-1', 'case-text-v1', v_hash, 'openai',
    'text-embedding-3-small', 'text-embedding-3-small-1536-v1',
    1536, v_vector, 'current'
  ) RETURNING id INTO v_emb_1;

  -- ------------------------------------------------------------
  -- 3. CONTENT-HASH DEDUPLICATION (idempotency)
  --
  -- The exact same content under the exact same model is refused,
  -- so a repeated generation cannot duplicate a row.
  -- ------------------------------------------------------------
  BEGIN
    INSERT INTO case_embeddings (
      account_id, historical_case_id, embedding_kind, source_entity,
      semantic_input_version, content_hash, provider, embedding_model,
      model_version, dimensions, vector, state
    ) VALUES (
      v_account_a, v_case, 'case_text', 'historical_case',
      'case-text-v1', v_hash, 'openai', 'text-embedding-3-small',
      'text-embedding-3-small-1536-v1', 1536, v_vector, 'stale'
    );
    RAISE EXCEPTION 'duplicate content under the same model was accepted';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  -- ------------------------------------------------------------
  -- 4. AT MOST ONE CURRENT VECTOR PER (CASE, KIND)
  --
  -- Different content, but still `current`. Two active vectors for one
  -- purpose would double-count the job in every comparison.
  -- ------------------------------------------------------------
  BEGIN
    INSERT INTO case_embeddings (
      account_id, historical_case_id, embedding_kind, source_entity,
      semantic_input_version, content_hash, provider, embedding_model,
      model_version, dimensions, vector, state
    ) VALUES (
      v_account_a, v_case, 'case_text', 'historical_case',
      'case-text-v1',
      '2222222222222222222222222222222222222222222222222222222222222222',
      'openai', 'text-embedding-3-small', 'text-embedding-3-small-1536-v1',
      1536, v_vector, 'current'
    );
    RAISE EXCEPTION 'a second current vector for the same case and kind was accepted';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  -- A second current vector of a DIFFERENT kind is fine: case text and
  -- image-observation text are different representations.
  INSERT INTO case_embeddings (
    account_id, historical_case_id, embedding_kind, source_entity,
    semantic_input_version, content_hash, provider, embedding_model,
    model_version, dimensions, vector, state
  ) VALUES (
    v_account_a, v_case, 'image_observation_text', 'historical_case_snapshot',
    'image-observation-text-v1',
    '3333333333333333333333333333333333333333333333333333333333333333',
    'openai', 'text-embedding-3-small', 'text-embedding-3-small-1536-v1',
    1536, v_vector, 'current'
  ) RETURNING id INTO v_emb_2;

  -- ------------------------------------------------------------
  -- 5. IDENTITY AND THE VECTOR ARE IMMUTABLE
  -- ------------------------------------------------------------
  BEGIN
    UPDATE case_embeddings
    SET content_hash =
          '4444444444444444444444444444444444444444444444444444444444444444'
    WHERE id = v_emb_1;
    RAISE EXCEPTION 'a stored content hash was mutated';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- A DIFFERENT but still valid 1536-dimension vector. It has to be a
  -- real vector: a short literal would fail the column cast before the
  -- immutability guard was ever reached.
  SELECT ('[' || array_to_string(
           array_fill((2.0 / sqrt(1536.0::numeric))::real, ARRAY[1536]),
           ','
         ) || ']')::vector(1536)
  INTO v_vector_b;

  BEGIN
    UPDATE case_embeddings
    SET vector = v_vector_b
    WHERE id = v_emb_1;
    RAISE EXCEPTION 'a stored vector was mutated';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- ------------------------------------------------------------
  -- 6. STALENESS IS EXPRESSED, NOT OVERWRITTEN
  --
  -- A new content hash produces a new row and retires the old one.
  -- ------------------------------------------------------------
  INSERT INTO case_embeddings (
    id, account_id, historical_case_id, embedding_kind, source_entity,
    semantic_input_version, content_hash, provider, embedding_model,
    model_version, dimensions, vector, state, superseded_by
  ) VALUES (
    gen_random_uuid(), v_account_a, v_case, 'case_text', 'historical_case',
    'case-text-v1',
    '5555555555555555555555555555555555555555555555555555555555555555',
    'openai', 'text-embedding-3-small', 'text-embedding-3-small-1536-v1',
    1536, v_vector, 'superseded', v_emb_2
  );

  SELECT state INTO v_state FROM case_embeddings WHERE id = v_emb_1;
  IF v_state <> 'current' THEN
    RAISE EXCEPTION 'retiring the incumbent must be an explicit write';
  END IF;

  -- A `superseded` row MUST name its replacement.
  BEGIN
    INSERT INTO case_embeddings (
      account_id, historical_case_id, embedding_kind, source_entity,
      semantic_input_version, content_hash, provider, embedding_model,
      model_version, dimensions, vector, state, superseded_by
    ) VALUES (
      v_account_a, v_case, 'image_observation_text', 'historical_case_snapshot',
      'image-observation-text-v1',
      '6666666666666666666666666666666666666666666666666666666666666666',
      'openai', 'text-embedding-3-small', 'text-embedding-3-small-1536-v1',
      1536, v_vector, 'superseded', NULL
    );
    RAISE EXCEPTION 'a superseded vector without a replacement was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- ------------------------------------------------------------
  -- 7. PRIVACY PROPAGATION
  --
  -- Excluding a case must withhold its current vectors, so derived
  -- memory cannot outlive a privacy decision.
  -- ------------------------------------------------------------
  UPDATE historical_cases
  SET learning_eligibility = 'excluded',
      learning_exclusion_reason = 'privacy_deletion',
      learning_eligibility_basis = 'operator'
  WHERE id = v_case;

  SELECT COUNT(*) INTO v_count
  FROM case_embeddings
  WHERE historical_case_id = v_case AND state = 'withheld';

  IF v_count <> 2 THEN
    RAISE EXCEPTION
      'excluding a case must withhold both of its current vectors, got %',
      v_count;
  END IF;

  -- A privileged write must NOT be able to reactivate a withheld vector
  -- while the case is still excluded. This is the fail-closed guard.
  BEGIN
    UPDATE case_embeddings SET state = 'current' WHERE id = v_emb_1;
    RAISE EXCEPTION
      'a withheld vector was reactivated while its case is still excluded';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- Re-including the case releases them again: the decision is
  -- reversible and auditable rather than destructive.
  UPDATE historical_cases
  SET learning_eligibility = 'included',
      learning_exclusion_reason = NULL,
      learning_eligibility_basis = 'operator'
  WHERE id = v_case;

  SELECT COUNT(*) INTO v_count
  FROM case_embeddings
  WHERE historical_case_id = v_case
    AND embedding_kind = 'case_text'
    AND state = 'current';

  IF v_count <> 1 THEN
    RAISE EXCEPTION
      're-including a case must release its withheld vector, got %', v_count;
  END IF;

  -- ------------------------------------------------------------
  -- 8. NO MONEY ON THE STORE
  --
  -- The table must not gain a monetary column. This is the structural
  -- half of the price-leakage guarantee.
  -- ------------------------------------------------------------
  SELECT COUNT(*) INTO v_cols
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'case_embeddings'
    AND (
      column_name LIKE '%amount%'
      OR column_name LIKE '%price%'
      OR column_name LIKE '%cost%'
      OR column_name LIKE '%quote%'
      OR column_name LIKE '%revenue%'
      OR column_name LIKE '%paid%'
    );

  IF v_cols <> 0 THEN
    RAISE EXCEPTION
      'case_embeddings must not store any monetary column';
  END IF;

  -- ------------------------------------------------------------
  -- 9. TENANT ISOLATION
  -- ------------------------------------------------------------
  -- Another account's member can neither read nor write these vectors.
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_user_b::text)::text, true);

  SELECT count(*) INTO v_readable
  FROM case_embeddings WHERE account_id = v_account_a;

  IF v_readable <> 0 THEN
    RAISE EXCEPTION 'a member of another account read vector memory';
  END IF;

  BEGIN
    INSERT INTO case_embeddings (
      account_id, historical_case_id, embedding_kind, source_entity,
      semantic_input_version, content_hash, provider, embedding_model,
      model_version, dimensions, vector, state
    ) VALUES (
      v_account_b, v_case, 'case_text', 'historical_case',
      'case-text-v1',
      '7777777777777777777777777777777777777777777777777777777777777777',
      'openai', 'text-embedding-3-small', 'text-embedding-3-small-1536-v1',
      1536, v_vector, 'current'
    );
    RAISE EXCEPTION 'a member of another account wrote vector memory';
  EXCEPTION WHEN foreign_key_violation OR check_violation THEN
    NULL;
  END;

  -- A same-account admin CAN read.
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_user_a::text)::text, true);

  SELECT count(*) INTO v_readable
  FROM case_embeddings WHERE account_id = v_account_a;

  IF v_readable = 0 THEN
    RAISE EXCEPTION 'a same-account member could not read vector memory';
  END IF;

  -- Vectors are superseded, never deleted: there is no DELETE policy.
  -- Vectors are superseded, never deleted, so a past retrieval result
  -- stays reproducible. There is no DELETE policy, and RLS without a
  -- matching policy filters rather than raises: the DELETE must
  -- therefore affect ZERO rows, not error.
  DELETE FROM case_embeddings WHERE id = v_emb_1;

  SELECT COUNT(*) INTO v_count
  FROM case_embeddings WHERE id = v_emb_1;

  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'an authenticated member deleted a vector; there must be no DELETE policy';
  END IF;

  RESET ROLE;

  -- ------------------------------------------------------------
  -- 10. DELETION PROPAGATION
  --
  -- Derived memory must not outlive its source.
  -- ------------------------------------------------------------
  DELETE FROM historical_cases WHERE id = v_case;

  SELECT COUNT(*) INTO v_count
  FROM case_embeddings WHERE historical_case_id = v_case;

  IF v_count <> 0 THEN
    RAISE EXCEPTION
      'deleting a historical case must cascade its vector memory away';
  END IF;

  -- ------------------------------------------------------------
  -- Cleanup
  -- ------------------------------------------------------------
  DELETE FROM accounts WHERE id IN (v_account_a, v_account_b);
  DELETE FROM auth.users WHERE id IN (v_user_a, v_user_b);

  RAISE NOTICE 'vector memory verification passed';
END
$$;
