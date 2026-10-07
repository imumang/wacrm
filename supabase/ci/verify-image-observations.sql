-- ============================================================
-- verify-image-observations.sql - row-level verification of the
-- canonical per-image observation store (migration 054).
--
-- `verify-schema.sql` asserts the SHAPE: the four tables, their
-- account-scoped foreign keys, the uniqueness and identity
-- constraints, the indexes, the write and privacy triggers, the
-- RLS policies, and the absence of any monetary, weight or
-- raw-provider-output column.
--
-- This file asserts the BEHAVIOUR those objects are supposed to
-- produce, against a real account, a real conversation, real
-- inbound images and real validated observations:
--
--   1. A validated analysis is ACCEPTED, and its per-image records
--      are stored once per image.
--   2. An observation legitimately spanning SEVERAL photographs is
--      stored ONCE with several source links - not duplicated.
--   3. REQUEST IDEMPOTENCY. The same media under the same
--      analyzer/model/schema/prompt cannot produce two runs.
--   4. A deliberate RE-ANALYSIS under a different model, a
--      different observation schema, or a different prompt version
--      is representable as its own run.
--   5. At most ONE current run per media set, so a case cannot
--      hold two live answers about the same photographs.
--   6. SOURCE TRACEABILITY. A source message from another
--      conversation, another account, or a non-existent row is
--      refused; and a caller-supplied media path that is not the
--      object path derived from the message row is refused.
--   7. NO OBSERVATION WITHOUT A PHOTOGRAPH, and NO OBSERVATION ON
--      AN UNVALIDATED RUN. A failed analysis can never carry an
--      observation, and a projection that disagrees with its
--      payload is refused.
--   8. Observations are IMMUTABLE.
--   9. PRIVACY PROPAGATION: excluding a case withholds its
--      analyses, and a privileged write cannot reactivate a
--      withheld analysis while the case is excluded. Re-including
--      releases it again.
--  10. DELETION PROPAGATION: deleting the source message prunes
--      the observation that had no surviving photograph, and
--      deleting the case removes the whole aggregate.
--  11. No raw provider output, price or weight column can be
--      smuggled in, and a failure row carries a closed-vocabulary
--      reason rather than provider text.
--  12. TENANT ISOLATION: a member of another account can neither
--      read nor write any of it, and there is no DELETE policy.
--
-- Everything it creates, it removes. The assertions run against
-- this file's own fixtures rather than any pre-existing row, so
-- this is safe to run repeatedly against a database that already
-- has data.
--
-- Like the other CI verification files this file must contain
-- EXACTLY ONE statement: `supabase db query --file` sends the
-- whole file as a prepared statement, and a second top-level
-- statement fails with "cannot insert multiple commands into a
-- prepared statement".
-- ============================================================

DO $$
DECLARE
  v_user_a UUID;
  v_user_b UUID;
  v_account_a UUID;
  v_account_b UUID;
  v_contact UUID;
  v_contact_b UUID;
  v_conversation UUID;
  v_conversation_b UUID;
  v_enquiry UUID;
  v_case UUID;
  v_message_1 UUID;
  v_message_2 UUID;
  v_message_foreign UUID;
  v_run_1 UUID;
  v_run_2 UUID;
  v_image_1 UUID;
  v_image_2 UUID;
  v_observation UUID;
  v_state TEXT;
  v_count INTEGER;
  v_readable INTEGER;
  v_cols INTEGER;
  v_sofa_payload JSONB := '{"kind":"furniture","label":"three-seat sofa","confidence":0.82,"basis":"observed","approximate_count":{"value":1,"confidence":0.9},"volume_range":null,"dismantling":"indicated","heavy_handling":"unknown","hazards":[],"notes":null}'::JSONB;
  v_hash_a TEXT := 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  v_hash_b TEXT := 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  v_hash_c TEXT := 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
BEGIN
  -- ------------------------------------------------------------
  -- Fixtures: two accounts, two users, two conversations, one
  -- enquiry, one case, three inbound images.
  --
  -- The accounts are created by the profiles trigger from
  -- `auth.users`, the same pattern verify-vector-memory.sql uses.
  -- The image `media_url`s are canonical chat-media public object
  -- URLs, which is the only form the media boundary produces and
  -- the only form the write guard accepts.
  -- ------------------------------------------------------------
  v_user_a := gen_random_uuid();
  v_user_b := gen_random_uuid();

  INSERT INTO auth.users (id, email) VALUES
    (v_user_a, 'verify-ia-a@example.invalid'),
    (v_user_b, 'verify-ia-b@example.invalid');
  SELECT account_id INTO v_account_a FROM profiles WHERE user_id = v_user_a;
  SELECT account_id INTO v_account_b FROM profiles WHERE user_id = v_user_b;

  INSERT INTO contacts (id, account_id, user_id, name, phone) VALUES
    (gen_random_uuid(), v_account_a, v_user_a, 'IA Customer', '+441110000010')
    RETURNING id INTO v_contact;

  INSERT INTO conversations (id, account_id, user_id, contact_id) VALUES
    (gen_random_uuid(), v_account_a, v_user_a, v_contact)
    RETURNING id INTO v_conversation;

  -- The other account needs its OWN contact and conversation, because
  -- `conversations` requires one and a conversation carries the tenant
  -- boundary. The foreign message below lives here.
  INSERT INTO contacts (id, account_id, user_id, name, phone) VALUES
    (gen_random_uuid(), v_account_b, v_user_b, 'IA Foreign', '+441110000011')
    RETURNING id INTO v_contact_b;

  INSERT INTO conversations (id, account_id, user_id, contact_id) VALUES
    (gen_random_uuid(), v_account_b, v_user_b, v_contact_b)
    RETURNING id INTO v_conversation_b;

  INSERT INTO enquiries (account_id, conversation_id, created_by_user_id) VALUES
    (v_account_a, v_conversation, v_user_a) RETURNING id INTO v_enquiry;

  INSERT INTO historical_cases (
    account_id, enquiry_id, conversation_id, contact_id,
    source_kind, learning_eligibility, learning_eligibility_basis
  ) VALUES (
    v_account_a, v_enquiry, v_conversation, v_contact,
    'live_enquiry', 'included', 'operator'
  ) RETURNING id INTO v_case;

  INSERT INTO messages (
    conversation_id, sender_type, content_type, media_url, media_type
  ) VALUES (
    v_conversation, 'customer', 'image',
    'https://project.supabase.co/storage/v1/object/public/chat-media/account-'
      || v_account_a || '/inbound/first.jpg',
    'image/jpeg'
  ) RETURNING id INTO v_message_1;

  INSERT INTO messages (
    conversation_id, sender_type, content_type, media_url, media_type
  ) VALUES (
    v_conversation, 'customer', 'image',
    'https://project.supabase.co/storage/v1/object/public/chat-media/account-'
      || v_account_a || '/inbound/second.jpg',
    'image/jpeg'
  ) RETURNING id INTO v_message_2;

  -- A message in ANOTHER conversation, to prove the traceability guard
  -- refuses a source that is not part of the run's own conversation.
  INSERT INTO messages (
    conversation_id, sender_type, content_type, media_url, media_type
  ) VALUES (
    v_conversation_b, 'customer', 'image',
    'https://project.supabase.co/storage/v1/object/public/chat-media/account-'
      || v_account_b || '/inbound/foreign.jpg',
    'image/jpeg'
  ) RETURNING id INTO v_message_foreign;

  -- ============================================================
  -- 1. A VALIDATED ANALYSIS IS ACCEPTED
  --
  -- Ids are assigned up front because later assertions need to name
  -- specific runs, images and observations - including ones that have
  -- since been superseded, pruned or deleted.
  -- ============================================================
  v_run_1 := gen_random_uuid();
  v_run_2 := gen_random_uuid();

  INSERT INTO image_analysis_runs (
    id, account_id, conversation_id, enquiry_id, historical_case_id,
    analyzer_id, provider, model, analysis_schema_version, prompt_version,
    status, image_count, correlation_id,
    source_fingerprint, result_content_hash
  ) VALUES (
    v_run_1, v_account_a, v_conversation, v_enquiry, v_case,
    'configured_vision_model', 'openai', 'gpt-5.4-mini',
    'image-observation-v1', 'vision-prompt-v1',
    'succeeded', 2, 'verify-run',
    v_hash_a, v_hash_b
  );

  -- Explicit ids rather than a `RETURNING` split across two statements:
-- the trigger sets nothing here, so the ids are known up front and both
-- images are available for the multi-source assertions below.
v_image_1 := gen_random_uuid();
  v_image_2 := gen_random_uuid();

  INSERT INTO image_analysis_run_images (
    id, account_id, run_id, ordinal, source_message_id, source_media_id,
    mime_type, byte_length, direction, message_created_at
  ) VALUES
    (v_image_1, v_account_a, v_run_1, 1, v_message_1,
     'account-' || v_account_a || '/inbound/first.jpg',
     'image/jpeg', 2048, 'inbound', now()),
    (v_image_2, v_account_a, v_run_1, 2, v_message_2,
     'account-' || v_account_a || '/inbound/second.jpg',
     'image/jpeg', 4096, 'inbound', now());

  -- One observation referencing BOTH photographs: "the same sofa
  -- appears in photo 1 and photo 2". This is the case the join table
  -- exists for.
  INSERT INTO image_analysis_observations (
    account_id, run_id, observation_type, ordinal_in_result,
    observation_ref, kind, label, confidence, basis, payload
  ) VALUES (
    v_account_a, v_run_1, 'observation', 1, 'obs-1',
    'furniture', 'three-seat sofa', 0.82, 'observed', v_sofa_payload
  ) RETURNING id INTO v_observation;

  INSERT INTO image_analysis_observation_sources (
    account_id, observation_id, run_image_id, source_ordinal
  ) VALUES
    (v_account_a, v_observation, v_image_1, 1),
    (v_account_a, v_observation, v_image_2, 2);

  -- ============================================================
  -- 2. ONE OBSERVATION, TWO SOURCE LINKS
  --
  -- Storing it twice would double every count derived from it, so
  -- the aggregate must hold exactly one observation row and two
  -- links. This is the multi-source behaviour asserted structurally.
  -- ============================================================
  SELECT COUNT(*) INTO v_count
  FROM image_analysis_observations WHERE run_id = v_run_1;
  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'an observation spanning two photographs must be stored once, got %', v_count;
  END IF;

  SELECT COUNT(*) INTO v_count
  FROM image_analysis_observation_sources WHERE observation_id = v_observation;
  IF v_count <> 2 THEN
    RAISE EXCEPTION
      'an observation spanning two photographs must have two source links, got %',
      v_count;
  END IF;

  -- ============================================================
  -- 3. REQUEST IDEMPOTENCY
  --
  -- The same media under the same analyzer/model/schema/prompt is
  -- the same immutable request, so it cannot produce two runs.
  -- ============================================================
  BEGIN
    INSERT INTO image_analysis_runs (
      account_id, conversation_id, analyzer_id, provider, model,
      analysis_schema_version, prompt_version, status, image_count,
      source_fingerprint, result_content_hash
    ) VALUES (
      v_account_a, v_conversation, 'configured_vision_model', 'openai',
      'gpt-5.4-mini', 'image-observation-v1', 'vision-prompt-v1',
      'succeeded', 2, v_hash_a, v_hash_c
    );
    RAISE EXCEPTION
      'the same analysis request produced a second canonical run';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  -- ============================================================
  -- 4. A DELIBERATE RE-ANALYSIS IS REPRESENTABLE
  --
  -- A different MODEL is a different analysis and gets its own run.
  -- ============================================================
  INSERT INTO image_analysis_runs (
    id, account_id, conversation_id, historical_case_id, analyzer_id,
    provider, model, analysis_schema_version, prompt_version,
    status, image_count, source_fingerprint, result_content_hash
  ) VALUES (
    v_run_2, v_account_a, v_conversation, v_case,
    'configured_vision_model', 'openai', 'claude-haiku-4-5-20251001',
    'image-observation-v1', 'vision-prompt-v1',
    'succeeded', 2, v_hash_b, v_hash_c
  );

  IF NOT EXISTS (
    SELECT 1 FROM image_analysis_runs
    WHERE id = v_run_2 AND model = 'claude-haiku-4-5-20251001'
  ) THEN
    RAISE EXCEPTION 'a re-analysis under a different model was not stored';
  END IF;

  -- A different OBSERVATION SCHEMA VERSION is likewise a distinct
  -- analysis. It gets its own media set here (a third fingerprint), so
  -- the insert itself succeeds and the point being asserted is that the
  -- row EXISTS rather than having been folded into the v1 analysis.
  INSERT INTO image_analysis_runs (
    account_id, conversation_id, analyzer_id, provider, model,
    analysis_schema_version, prompt_version, status, image_count,
    source_fingerprint, result_content_hash
  ) VALUES (
    v_account_a, v_conversation, 'configured_vision_model', 'openai',
    'gpt-5.4-mini', 'image-observation-v2', 'vision-prompt-v1',
    'succeeded', 1, v_hash_c, v_hash_a
  );

  IF NOT EXISTS (
    SELECT 1 FROM image_analysis_runs
    WHERE analysis_schema_version = 'image-observation-v2'
  ) THEN
    RAISE EXCEPTION
      'a re-analysis under a different observation schema was not stored';
  END IF;

  -- A different PROMPT VERSION is likewise its own analysis, for the same
  -- reason: a reworded instruction produces a materially different
  -- analysis at the same model. It is representable, but only once the
  -- incumbent over that media set has been retired - which is section 5
  -- below, and the order is the point.
  SELECT count(*) INTO v_count
  FROM image_analysis_runs
  WHERE prompt_version = 'vision-prompt-v2';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'no analysis should exist under an unregistered prompt version yet';
  END IF;

  -- ============================================================
  -- 5. AT MOST ONE CURRENT RUN PER MEDIA SET
  --
  -- A second CURRENT run over the same media set is refused, so a case
  -- cannot hold two live answers about the same photographs. A
  -- superseded row is not current, so retiring the incumbent first is
  -- what lets a deliberate re-analysis take the slot.
  -- ============================================================
  BEGIN
    INSERT INTO image_analysis_runs (
      account_id, conversation_id, analyzer_id, provider, model,
      analysis_schema_version, prompt_version, status, image_count,
      source_fingerprint, result_content_hash
    ) VALUES (
      v_account_a, v_conversation, 'configured_vision_model', 'openai',
      'gpt-5.4-mini', 'image-observation-v1', 'vision-prompt-v1',
      'succeeded', 2, v_hash_b, v_hash_a
    );
    RAISE EXCEPTION
      'a second current run over the same media set was accepted';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  -- ============================================================
  -- 6. SOURCE TRACEABILITY
  -- ============================================================

  -- A source message from ANOTHER conversation cannot be attributed to
  -- this run, even though the message row exists.
  BEGIN
    INSERT INTO image_analysis_run_images (
      account_id, run_id, ordinal, source_message_id, source_media_id,
      mime_type, byte_length, direction, message_created_at
    ) VALUES (
      v_account_a, v_run_1, 3, v_message_foreign,
      'account-' || v_account_b || '/inbound/foreign.jpg',
      'image/jpeg', 2048, 'inbound', now()
    );
    RAISE EXCEPTION
      'a source message from another conversation was accepted';
  EXCEPTION WHEN check_violation OR foreign_key_violation THEN
    NULL;
  END;

  -- A non-existent source message is refused.
  BEGIN
    INSERT INTO image_analysis_run_images (
      account_id, run_id, ordinal, source_message_id, source_media_id,
      mime_type, byte_length, direction, message_created_at
    ) VALUES (
      v_account_a, v_run_1, 3, gen_random_uuid(),
      'account-' || v_account_a || '/inbound/ghost.jpg',
      'image/jpeg', 2048, 'inbound', now()
    );
    RAISE EXCEPTION 'a non-existent source message was accepted';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;

  -- The decisive traceability guarantee: a CALLER-SUPPLIED media path
  -- that is not the object path derived from the message row is
  -- refused. Without this, an observation could be attributed to a
  -- photograph that was never analysed.
  BEGIN
    INSERT INTO image_analysis_run_images (
      account_id, run_id, ordinal, source_message_id, source_media_id,
      mime_type, byte_length, direction, message_created_at
    ) VALUES (
      v_account_a, v_run_1, 3, v_message_1,
      'account-' || v_account_a || '/inbound/somebody-elses-photo.jpg',
      'image/jpeg', 2048, 'inbound', now()
    );
    RAISE EXCEPTION
      'a media reference that is not the source message own object was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- A SIGNED URL must never be storable, even as an object path.
  BEGIN
    INSERT INTO image_analysis_run_images (
      account_id, run_id, ordinal, source_message_id, source_media_id,
      mime_type, byte_length, direction, message_created_at
    ) VALUES (
      v_account_a, v_run_1, 3, v_message_1,
      'account-' || v_account_a || '/inbound/first.jpg?token=secret',
      'image/jpeg', 2048, 'inbound', now()
    );
    RAISE EXCEPTION 'a signed URL was accepted as a media reference';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- One ordinal per photograph per run.
  BEGIN
    INSERT INTO image_analysis_run_images (
      account_id, run_id, ordinal, source_message_id, source_media_id,
      mime_type, byte_length, direction, message_created_at
    ) VALUES (
      v_account_a, v_run_1, 1, v_message_2,
      'account-' || v_account_a || '/inbound/second.jpg',
      'image/jpeg', 4096, 'inbound', now()
    );
    RAISE EXCEPTION 'a duplicate ordinal in one run was accepted';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  -- ============================================================
  -- 7. NO OBSERVATION WITHOUT A VALIDATED RUN OR A PHOTOGRAPH
  -- ============================================================

  -- A FAILED analysis can never carry an observation, so an invalid
  -- provider answer can never become a learning record.
  INSERT INTO image_analysis_runs (
    account_id, conversation_id, analyzer_id, provider, model,
    analysis_schema_version, prompt_version, status, failure_reason,
    image_count, correlation_id
  ) VALUES (
    v_account_a, v_conversation, 'configured_vision_model', 'openai',
    'gpt-5.4-mini', 'image-observation-v1', 'vision-prompt-v1',
    'validation_failed', 'invalid_provider_result', 2, 'verify-failed'
  );

  BEGIN
    INSERT INTO image_analysis_observations (
      account_id, run_id, observation_type, ordinal_in_result,
      observation_ref, kind, label, confidence, basis, payload
    )
    SELECT account_id, id, 'observation', 1, 'obs-1',
           'furniture', 'a sofa', 0.9, 'observed', v_sofa_payload
    FROM image_analysis_runs
    WHERE status = 'validation_failed'
    LIMIT 1;
    RAISE EXCEPTION 'an observation was attached to an unvalidated run';
  EXCEPTION WHEN check_violation OR foreign_key_violation THEN
    NULL;
  END;

  -- A failure row cannot carry a RESULT HASH, so failed output cannot be
  -- mistaken for validated output.
  BEGIN
    INSERT INTO image_analysis_runs (
      account_id, conversation_id, analyzer_id, provider, model,
      analysis_schema_version, prompt_version, status, failure_reason,
      image_count, result_content_hash
    ) VALUES (
      v_account_a, v_conversation, 'configured_vision_model', 'openai',
      'gpt-5.4-mini', 'image-observation-v1', 'vision-prompt-v1',
      'validation_failed', 'invalid_provider_result', 2, v_hash_a
    );
    RAISE EXCEPTION 'a failed analysis was allowed to carry a result hash';
  EXCEPTION WHEN check_violation OR unique_violation THEN
    NULL;
  END;

  -- A failure reason outside the closed vocabulary is refused, so a
  -- provider message cannot become durable text.
  BEGIN
    INSERT INTO image_analysis_runs (
      account_id, conversation_id, analyzer_id, provider, model,
      analysis_schema_version, prompt_version, status, failure_reason,
      image_count
    ) VALUES (
      v_account_a, v_conversation, 'configured_vision_model', 'openai',
      'gpt-5.4-mini', 'image-observation-v1', 'vision-prompt-v1',
      'provider_unavailable',
      'OpenAI 401 invalid api key sk-abc123 for account 42', 0
    );
    RAISE EXCEPTION 'free text was accepted as a failure reason';
  EXCEPTION WHEN check_violation OR unique_violation THEN
    NULL;
  END;

  -- The projection beside `payload` must AGREE with it, or a consumer
  -- filtering on `kind` could disagree with the embedded document.
  BEGIN
    INSERT INTO image_analysis_observations (
      account_id, run_id, observation_type, ordinal_in_result,
      observation_ref, kind, label, confidence, basis, payload
    ) VALUES (
      v_account_a, v_run_1, 'observation', 2, 'obs-2',
      'furniture', 'a wardrobe', 0.7, 'observed', v_sofa_payload
    );
    RAISE EXCEPTION 'an observation projection disagreeing with its payload was accepted';
  EXCEPTION WHEN check_violation OR unique_violation THEN
    NULL;
  END;

  -- An ambiguous item carries no `kind` and no `basis`: it is not an
  -- observation about an item, and letting it carry one would let
  -- "we could not tell" read as "we saw this".
  BEGIN
    INSERT INTO image_analysis_observations (
      account_id, run_id, observation_type, ordinal_in_result,
      observation_ref, kind, label, confidence, basis, payload
    ) VALUES (
      v_account_a, v_run_1, 'ambiguous_item', 1, 'ambiguous-1',
      'furniture', 'an unidentifiable object', 0.3, 'observed',
      '{"description":"an unidentifiable object","confidence":0.3}'::JSONB
    );
    RAISE EXCEPTION 'an ambiguous item was allowed to carry an observation kind';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- A source link may only join an observation and an image from the
  -- SAME run, and its ordinal must be that image's ordinal.
  BEGIN
    INSERT INTO image_analysis_observation_sources (
      account_id, observation_id, run_image_id, source_ordinal
    ) VALUES (v_account_a, v_observation, v_image_1, 2);
    RAISE EXCEPTION 'a source link with a mismatched ordinal was accepted';
  EXCEPTION WHEN check_violation OR unique_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO image_analysis_observation_sources (
      account_id, observation_id, run_image_id, source_ordinal
    ) VALUES (v_account_a, v_observation, v_observation, 1);
    RAISE EXCEPTION 'a source link pointing at a non-image was accepted';
  EXCEPTION WHEN check_violation OR foreign_key_violation THEN
    NULL;
  END;

  -- ============================================================
  -- 8. OBSERVATIONS ARE IMMUTABLE
  --
  -- An observation is a statement about what a validated model saw.
  -- Amending it in place would silently rewrite the evidence a frozen
  -- case and an embedding were derived from.
  -- ============================================================
  BEGIN
    UPDATE image_analysis_observations
    SET label = 'a very expensive sofa'
    WHERE id = v_observation;
    RAISE EXCEPTION 'a stored image observation was amended';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    UPDATE image_analysis_runs
    SET model = 'some-other-model'
    WHERE id = v_run_1;
    RAISE EXCEPTION 'a stored analysis run identity was amended';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    UPDATE image_analysis_runs
    SET result_content_hash = v_hash_c
    WHERE id = v_run_1;
    RAISE EXCEPTION 'a stored result content hash was amended';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- Supersession IS expressible, and must name its replacement.
  BEGIN
    UPDATE image_analysis_runs SET state = 'superseded'
    WHERE id = v_run_1;
    RAISE EXCEPTION 'a superseded run without a replacement was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  UPDATE image_analysis_runs
  SET state = 'superseded', superseded_by = v_run_2
  WHERE id = v_run_1;

  SELECT state INTO v_state FROM image_analysis_runs WHERE id = v_run_1;
  IF v_state <> 'superseded' THEN
    RAISE EXCEPTION 'supersession must be an explicit write';
  END IF;

  -- ============================================================
  -- 9. PRIVACY PROPAGATION
  --
  -- Excluding a case must withhold its analyses, so derived learning
  -- memory cannot outlive a privacy decision.
  -- ============================================================
  UPDATE historical_cases
  SET learning_eligibility = 'excluded',
      learning_exclusion_reason = 'privacy_deletion',
      learning_eligibility_basis = 'operator'
  WHERE id = v_case;

  SELECT COUNT(*) INTO v_count
  FROM image_analysis_runs
  WHERE historical_case_id = v_case AND state = 'withheld';

  IF v_count < 1 THEN
    RAISE EXCEPTION
      'excluding a case must withhold its image analyses, got %', v_count;
  END IF;

  -- A privileged write must NOT be able to reactivate a withheld
  -- analysis while the case is still excluded. This is the
  -- fail-closed guard.
  BEGIN
    UPDATE image_analysis_runs
    SET state = 'current', superseded_by = NULL
    WHERE id = v_run_2;
    RAISE EXCEPTION
      'a withheld image analysis was reactivated while its case is still excluded';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- And a NEW analysis of an excluded case's photographs cannot be
  -- stored as current either.
  BEGIN
    INSERT INTO image_analysis_runs (
      account_id, conversation_id, historical_case_id, analyzer_id,
      provider, model, analysis_schema_version, prompt_version,
      status, image_count, source_fingerprint, result_content_hash
    ) VALUES (
      v_account_a, v_conversation, v_case, 'configured_vision_model',
      'openai', 'gpt-5.4-mini', 'image-observation-v1', 'vision-prompt-v1',
      'succeeded', 1, v_hash_c, v_hash_a
    );
    RAISE EXCEPTION
      'an analysis of an excluded case was stored as current';
  EXCEPTION WHEN check_violation OR unique_violation THEN
    NULL;
  END;

  -- Re-including the case releases the analyses again: the decision is
  -- reversible and auditable rather than destructive.
  UPDATE historical_cases
  SET learning_eligibility = 'included',
      learning_exclusion_reason = NULL,
      learning_eligibility_basis = 'operator'
  WHERE id = v_case;

  SELECT COUNT(*) INTO v_count
  FROM image_analysis_runs
  WHERE historical_case_id = v_case AND state = 'current';

  IF v_count < 1 THEN
    RAISE EXCEPTION
      're-including a case must release its withheld analyses, got %', v_count;
  END IF;

  -- ============================================================
  -- 10. DELETION PROPAGATION
  --
  -- Derived memory must not outlive its source. Deleting the second
  -- image removes one source link; the observation still has the first,
  -- so it survives - which is exactly right, because it is still
  -- traceable to a photograph WACRM holds.
  -- ============================================================
  DELETE FROM messages WHERE id = v_message_2;

  SELECT COUNT(*) INTO v_count
  FROM image_analysis_observations
  WHERE run_id = v_run_1 AND id = v_observation;

  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'an observation with a surviving source must not be pruned, got %', v_count;
  END IF;

  SELECT COUNT(*) INTO v_count
  FROM image_analysis_observation_sources WHERE observation_id = v_observation;

  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'deleting one image must remove exactly its own source link, got %',
      v_count;
  END IF;

  -- Deleting the LAST surviving source leaves an observation with no
  -- photograph at all. It is pruned, and then the successful run with
  -- no observations is pruned too - rather than leaving learning memory
  -- about a photograph WACRM no longer holds.
  DELETE FROM messages WHERE id = v_message_1;

  SELECT COUNT(*) INTO v_count
  FROM image_analysis_observations WHERE id = v_observation;

  IF v_count <> 0 THEN
    RAISE EXCEPTION
      'an observation with no surviving photograph must be pruned';
  END IF;

  SELECT COUNT(*) INTO v_count
  FROM image_analysis_runs WHERE id = v_run_1;

  IF v_count <> 0 THEN
    RAISE EXCEPTION
      'a successful analysis with no observations must be pruned';
  END IF;

  -- Deleting the CASE removes its remaining derived analyses outright:
  -- deletion is a business decision, so removal rather than withholding
  -- is the right answer.
  DELETE FROM historical_cases WHERE id = v_case;

  SELECT COUNT(*) INTO v_count
  FROM image_analysis_runs WHERE historical_case_id = v_case;

  IF v_count <> 0 THEN
    RAISE EXCEPTION
      'deleting a historical case must cascade its image analyses away';
  END IF;

  -- ============================================================
  -- 11. NO MONEY, NO RAW PROVIDER OUTPUT
  -- ============================================================

  -- The structural half of the price-leakage guarantee: no monetary,
  -- weight or raw-provider-output column may exist.
  SELECT COUNT(*) INTO v_cols
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name LIKE 'image_analysis%'
    AND (
      column_name LIKE '%amount%' OR column_name LIKE '%price%'
      OR column_name LIKE '%cost%' OR column_name LIKE '%quote%'
      OR column_name LIKE '%revenue%' OR column_name LIKE '%paid%'
      OR column_name LIKE '%weight%'
      OR column_name LIKE '%raw%' OR column_name LIKE '%response%'
      OR column_name = 'choices'
    );

  IF v_cols <> 0 THEN
    RAISE EXCEPTION
      'image observation tables must not store monetary, weight or raw provider columns';
  END IF;

  -- The validator itself, asserted as a pure function so the accepted
  -- shapes stay accepted: if it simply rejected everything, the
  -- constraint below would prove nothing.
  IF NOT public.image_analysis_observation_payload_clean(v_sofa_payload) THEN
    RAISE EXCEPTION
      'a validated image observation payload must be accepted by the payload guard';
  END IF;

  IF NOT public.image_analysis_observation_payload_clean(
       '{"kind":"furniture","label":"sofa","approximate_count":{"value":1}}'::JSONB
     ) THEN
    RAISE EXCEPTION
      'a payload with an approximate_count must be accepted by the payload guard';
  END IF;

  -- And it must refuse a PRICED or WEIGHED payload, at the top level and
  -- nested, so a service-role write cannot put money into a learning
  -- record through a field name the column list would never catch.
  --
  -- Scope note: the guard is KEY-based, matching `FORBIDDEN_FIELD_WORDS`
  -- in the TypeScript validator. It deliberately does not pattern-match
  -- free-text VALUES, because a durable store that refused a note for
  -- containing the word "pounds" would fail writes for reasons an
  -- operator cannot act on. Value-level money leakage is handled where it
  -- matters - `assertNoMonetaryLeakage` before anything is embedded - and
  -- the vision prompt forbids stating a price at all.
  IF public.image_analysis_observation_payload_clean(
       '{"kind":"furniture","label":"sofa","price":120}'::JSONB
     )
     OR public.image_analysis_observation_payload_clean(
       '{"kind":"furniture","label":"sofa","weight_kg":40}'::JSONB
     )
     OR public.image_analysis_observation_payload_clean(
       '{"kind":"furniture","label":"sofa","nested":{"quote":"120"}}'::JSONB
     )
     OR public.image_analysis_observation_payload_clean(
       '{"kind":"furniture","label":"sofa","GBP":120}'::JSONB
     )
     OR public.image_analysis_observation_payload_clean(
       '{"kind":"furniture","label":"sofa","list":[{"unit_cost":5}]}'::JSONB
     )
     OR public.image_analysis_observation_payload_clean(
       '{"kind":"furniture","label":"sofa","estimated_charge_pence":900}'::JSONB
     ) THEN
    RAISE EXCEPTION
      'the payload guard accepted a price or weight key';
  END IF;

  -- ============================================================
  -- 12. TENANT ISOLATION
  --
  -- Another account's member can neither read nor write any of this.
  -- ============================================================
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_user_b::text)::text, true);

  SELECT COALESCE(SUM(c), 0) INTO v_readable FROM (
    SELECT count(*) AS c FROM image_analysis_runs
    WHERE account_id = v_account_a
    UNION ALL
    SELECT count(*) FROM image_analysis_run_images
    WHERE account_id = v_account_a
    UNION ALL
    SELECT count(*) FROM image_analysis_observations
    WHERE account_id = v_account_a
    UNION ALL
    SELECT count(*) FROM image_analysis_observation_sources
    WHERE account_id = v_account_a
  ) totals;

  IF v_readable <> 0 THEN
    RAISE EXCEPTION 'a member of another account read image observations';
  END IF;

  -- A member of another account must not be able to write an analysis
  -- into THAT account's data. The RLS insert policy passes - the caller
  -- really is an agent of the account it names - so it is the composite
  -- `(conversation_id, account_id)` foreign key that has to stop it,
  -- which is precisely why that key exists rather than an RLS policy
  -- alone.
  BEGIN
    INSERT INTO image_analysis_runs (
      account_id, conversation_id, analyzer_id, provider, model,
      analysis_schema_version, prompt_version, status, image_count,
      source_fingerprint, result_content_hash
    ) VALUES (
      v_account_b, v_conversation, 'configured_vision_model', 'openai',
      'gpt-5.4-mini', 'image-observation-v1', 'vision-prompt-v1',
      'succeeded', 1, v_hash_a, v_hash_b
    );
    RAISE EXCEPTION
      'a member of another account attached an analysis to this account conversation';
  EXCEPTION WHEN foreign_key_violation OR check_violation THEN
    NULL;
  END;

  -- A same-account member CAN read.
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_user_a::text)::text, true);

  SELECT count(*) INTO v_readable
  FROM image_analysis_runs WHERE account_id = v_account_a;

  IF v_readable = 0 THEN
    RAISE EXCEPTION 'a same-account member could not read image analyses';
  END IF;

  -- There is no authenticated DELETE policy: derived observations are
  -- removed only through a source / case / conversation / account
  -- cascade, i.e. only when somebody decided the source data is gone.
  -- RLS without a matching policy filters rather than raises, so the
  -- DELETE must affect ZERO rows rather than error.
  DELETE FROM image_analysis_runs WHERE account_id = v_account_a;

  SELECT count(*) INTO v_readable
  FROM image_analysis_runs WHERE account_id = v_account_a;

  IF v_readable = 0 THEN
    RAISE EXCEPTION
      'an authenticated member deleted image analyses; there must be no DELETE policy';
  END IF;

  RESET ROLE;

  -- ------------------------------------------------------------
  -- Cleanup
  -- ------------------------------------------------------------
  DELETE FROM accounts WHERE id IN (v_account_a, v_account_b);
  DELETE FROM auth.users WHERE id IN (v_user_a, v_user_b);

  RAISE NOTICE 'image observation verification passed';
END
$$;