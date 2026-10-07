-- ============================================================
-- verify-historical-import.sql - row-level verification of the
-- historical import identity spine (migration 051).
--
-- `verify-schema.sql` asserts the SHAPE: the tables exist, the
-- uniqueness guard and the dry-run CHECK are installed, the guards
-- are triggered, and the RLS policies are the right ones.
--
-- This file asserts the BEHAVIOUR those objects are supposed to
-- produce, against a real account with a real enquiry and a real
-- historical case:
--
--   1. A dry run cannot record a created or updated case. This is the
--      guarantee an operator relies on when they are asked to approve
--      a real import, so it has to be true in the database rather
--      than in a convention.
--   2. A run is finished exactly when it is not `running`.
--   3. The summary and error metadata are bounded and correctly
--      shaped, so an import log cannot become a place customer
--      message bodies accumulate.
--   4. One source record cannot be attributed to two cases, and a
--      re-attribution of the same record is refused. That is the
--      database half of import idempotency.
--   5. The source ledger is append-only while its case exists, and a
--      finalized case accepts no new imported source at all.
--   6. `imported_historical` provenance is accepted on a fact, and it
--      is NOT a promotion: an imported collected amount does not make
--      a case support tier A.
--   7. A member of another account can neither read nor write this
--      account's import ledger, tested as `authenticated` rather than
--      as the table owner.
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
  v_run UUID;
  v_source UUID;
  v_supports_a BOOLEAN;
  v_eligibility TEXT;
  v_readable INTEGER;
BEGIN
  -- ------------------------------------------------------------
  -- Fixtures. Two accounts, because the isolation assertions are
  -- only meaningful with something to be isolated FROM.
  --
  -- The accounts come from `handle_new_user()` (migration 017), which
  -- creates a personal account per inserted auth user; inserting
  -- accounts by hand as well would collide with
  -- `idx_accounts_one_per_owner`.
  -- ------------------------------------------------------------
  v_user_a := gen_random_uuid();
  v_user_b := gen_random_uuid();
  INSERT INTO auth.users (id, email) VALUES
    (v_user_a, 'verify-import-a@example.invalid'),
    (v_user_b, 'verify-import-b@example.invalid');

  SELECT account_id INTO v_account_a FROM profiles WHERE user_id = v_user_a;
  SELECT account_id INTO v_account_b FROM profiles WHERE user_id = v_user_b;

  IF v_account_a IS NULL OR v_account_b IS NULL THEN
    RAISE EXCEPTION
      'handle_new_user() did not create accounts for the verification users';
  END IF;

  INSERT INTO contacts (id, account_id, user_id, name, phone)
  VALUES (gen_random_uuid(), v_account_a, v_user_a, 'Verify Import Contact',
          '+441234567890')
  RETURNING id INTO v_contact;

  INSERT INTO conversations (id, account_id, user_id, contact_id)
  VALUES (gen_random_uuid(), v_account_a, v_user_a, v_contact)
  RETURNING id INTO v_conversation;

  INSERT INTO enquiries (id, account_id, conversation_id, created_by_user_id)
  VALUES (gen_random_uuid(), v_account_a, v_conversation, v_user_a)
  RETURNING id INTO v_enquiry;

  INSERT INTO historical_cases (
    account_id, enquiry_id, conversation_id, contact_id,
    source_kind, created_by_user_id
  )
  VALUES (v_account_a, v_enquiry, v_conversation, v_contact,
          'imported_historical', v_user_a)
  RETURNING id INTO v_case;

  -- ------------------------------------------------------------
  -- 1. A dry run creates nothing. The counters are the claim an
  -- operator reads before approving a real import, so a dry run
  -- that claims to have created cases must be unrepresentable.
  -- ------------------------------------------------------------
  BEGIN
    INSERT INTO historical_import_runs (
      account_id, source_type, status, completed_at, dry_run,
      records_examined, cases_created, importer_version
    ) VALUES (
      v_account_a, 'enquiries', 'completed', NOW(), TRUE, 12, 4,
      'wacrm-historical-import-v1'
    );
    RAISE EXCEPTION 'a dry run was allowed to record created cases';
  EXCEPTION WHEN check_violation THEN
    NULL;  -- the guard fired, which is the assertion
  END;

  -- The honest dry run is accepted, with the counts it may claim.
  INSERT INTO historical_import_runs (
    account_id, source_type, status, completed_at, dry_run,
    records_examined, cases_reused, facts_imported, ambiguous_records,
    summary, importer_version, triggered_by_user_id
  ) VALUES (
    v_account_a, 'enquiries', 'completed', NOW(), TRUE,
    12, 0, 34, 3,
    '{"skip_reasons":{"requires_enquiry_segmentation":3}}',
    'wacrm-historical-import-v1', v_user_a
  )
  RETURNING id INTO v_run;

  -- And so is a real run.
  INSERT INTO historical_import_runs (
    account_id, source_type, status, completed_at, dry_run,
    records_examined, cases_created, importer_version
  ) VALUES (
    v_account_a, 'enquiries', 'completed', NOW(), FALSE, 12, 4,
    'wacrm-historical-import-v1'
  );

  -- An import that failed is still finished, so it must say when.
  BEGIN
    INSERT INTO historical_import_runs (
      account_id, source_type, status, dry_run, importer_version
    ) VALUES (
      v_account_a, 'enquiries', 'failed', FALSE, 'wacrm-historical-import-v1'
    );
    RAISE EXCEPTION 'a finished run without completed_at was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- A run still in progress must not claim a completion time.
  BEGIN
    INSERT INTO historical_import_runs (
      account_id, source_type, status, completed_at, dry_run,
      importer_version
    ) VALUES (
      v_account_a, 'enquiries', 'running', NOW(), FALSE,
      'wacrm-historical-import-v1'
    );
    RAISE EXCEPTION 'a running run with a completion time was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- ------------------------------------------------------------
  -- 2. The summary and error metadata are bounded and shaped.
  --
  -- The bound is what stops an import log becoming a place customer
  -- message bodies quietly accumulate: there is room for ids,
  -- reasons and counts, and no room for a transcript.
  -- ------------------------------------------------------------
  BEGIN
    INSERT INTO historical_import_runs (
      account_id, source_type, status, completed_at, dry_run,
      summary, importer_version
    ) VALUES (
      v_account_a, 'enquiries', 'completed', NOW(), FALSE,
      jsonb_build_object('blob', repeat('x', 9000)),
      'wacrm-historical-import-v1'
    );
    RAISE EXCEPTION 'an oversized import summary was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO historical_import_runs (
      account_id, source_type, status, completed_at, dry_run,
      summary, importer_version
    ) VALUES (
      v_account_a, 'enquiries', 'completed', NOW(), FALSE,
      '[]'::jsonb, 'wacrm-historical-import-v1'
    );
    RAISE EXCEPTION 'a non-object import summary was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO historical_import_runs (
      account_id, source_type, status, completed_at, dry_run,
      error_metadata, importer_version
    ) VALUES (
      v_account_a, 'enquiries', 'completed', NOW(), FALSE,
      '{}'::jsonb, 'wacrm-historical-import-v1'
    );
    RAISE EXCEPTION 'a non-array error_metadata was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- An import-quality value outside the closed vocabulary is not a
  -- quality judgement; it is a typo that would read as data.
  BEGIN
    INSERT INTO historical_case_sources (
      account_id, case_id, source_kind, source_record_id, source_system,
      import_quality, import_run_id
    ) VALUES (
      v_account_a, v_case, 'enquiry', v_enquiry, 'wacrm.enquiries',
      'probably_fine', v_run
    );
    RAISE EXCEPTION 'an unrecognised import_quality was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- ------------------------------------------------------------
  -- 3. Source identity, and the idempotency it buys.
  -- ------------------------------------------------------------
  INSERT INTO historical_case_sources (
    account_id, case_id, source_kind, source_record_id, source_system,
    source_observed_at, import_quality, import_quality_reasons, import_run_id
  ) VALUES (
    v_account_a, v_case, 'enquiry', v_enquiry, 'wacrm.enquiries',
    '2026-01-05T09:00:00Z'::timestamptz, 'exact',
    ARRAY['one enquiry maps to exactly one case'],
    v_run
  )
  RETURNING id INTO v_source;

  -- The same source record cannot be attributed a second time. This
  -- is what makes a repeated import converge rather than duplicate.
  BEGIN
    INSERT INTO historical_case_sources (
      account_id, case_id, source_kind, source_record_id, source_system,
      import_quality, import_run_id
    ) VALUES (
      v_account_a, v_case, 'enquiry', v_enquiry, 'wacrm.enquiries',
      'exact', v_run
    );
    RAISE EXCEPTION 'the same source record was attributed twice';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  -- A second, genuinely different source record is accepted.
  INSERT INTO messages (
    conversation_id, sender_type, content_type, message_id
  ) VALUES (
    v_conversation, 'customer', 'image', 'verify-import-media-1'
  );

  INSERT INTO historical_case_sources (
    account_id, case_id, source_kind, source_record_id, source_system,
    import_quality, import_quality_reasons, import_run_id
  )
  SELECT
    v_account_a, v_case, 'message', m.id, 'wacrm.messages',
    'high_confidence_mapping',
    ARRAY['a canonical message reference, with no observation claimed'],
    v_run
  FROM messages m
  WHERE m.conversation_id = v_conversation AND m.sender_type = 'customer'
  LIMIT 1;

  -- ------------------------------------------------------------
  -- 4. The ledger is append-only, and a finalized case takes no
  -- new imported source.
  -- ------------------------------------------------------------
  BEGIN
    UPDATE historical_case_sources
    SET import_quality = 'partial'
    WHERE id = v_source;
    RAISE EXCEPTION 'a historical case source row was amended';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    DELETE FROM historical_case_sources WHERE id = v_source;
    RAISE EXCEPTION 'a historical case source row was deleted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- A source row cannot be attached to another account's case: the
  -- composite (case_id, account_id) foreign key refuses it even for the
  -- table owner.
  BEGIN
    INSERT INTO contacts (id, account_id, user_id, name, phone)
    VALUES (gen_random_uuid(), v_account_b, v_user_b, 'Foreign Contact',
            '+441234567891')
    RETURNING id INTO v_contact;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'could not build the cross-account fixture: %', SQLERRM;
  END;

  BEGIN
    INSERT INTO historical_case_sources (
      account_id, case_id, source_kind, source_record_id, source_system,
      import_quality
    ) VALUES (
      v_account_b, v_case, 'contact', v_contact, 'wacrm.contacts', 'exact'
    );
    RAISE EXCEPTION 'a source row was attached to another account''s case';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;

  -- Finalize, then prove the case refuses new imported evidence.
  UPDATE historical_cases
  SET case_state = 'finalized', finalized_at = NOW()
  WHERE id = v_case;

  BEGIN
    INSERT INTO historical_case_sources (
      account_id, case_id, source_kind, source_record_id, source_system,
      import_quality, import_run_id
    ) VALUES (
      v_account_a, v_case, 'deal', gen_random_uuid(), 'wacrm.deals',
      'ambiguous', v_run
    );
    RAISE EXCEPTION 'a finalized case accepted a new imported source';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- ------------------------------------------------------------
  -- 5. `imported_historical` is a provenance, not a promotion.
  --
  -- A case cannot be frozen with facts written afterwards, so this
  -- is asserted on a second, open case.
  -- ------------------------------------------------------------
  INSERT INTO contacts (id, account_id, user_id, name, phone)
  VALUES (gen_random_uuid(), v_account_a, v_user_a, 'Verify Import Contact 2',
          '+441234567892')
  RETURNING id INTO v_contact;

  INSERT INTO conversations (id, account_id, user_id, contact_id)
  VALUES (gen_random_uuid(), v_account_a, v_user_a, v_contact)
  RETURNING id INTO v_conversation;

  INSERT INTO enquiries (id, account_id, conversation_id, created_by_user_id)
  VALUES (gen_random_uuid(), v_account_a, v_conversation, v_user_a)
  RETURNING id INTO v_enquiry;

  INSERT INTO historical_cases (
    account_id, enquiry_id, conversation_id, contact_id,
    source_kind, created_by_user_id
  )
  VALUES (v_account_a, v_enquiry, v_conversation, v_contact,
          'imported_historical', v_user_a)
  RETURNING id INTO v_case;

  -- A canonical annotation with imported provenance is accepted: it is
  -- the only honest provenance available for a value WACRM received
  -- without learning who typed it.
  INSERT INTO historical_case_facts (
    account_id, case_id, fact_key, value_source, provenance
  ) VALUES (
    v_account_a, v_case, 'postcode', 'canonical', 'imported_historical'
  );

  -- An imported money figure is accepted as a fact...
  INSERT INTO historical_case_facts (
    account_id, case_id, fact_key, value_source, value_number, provenance
  ) VALUES (
    v_account_a, v_case, 'final_amount_collected', 'captured', 385,
    'imported_historical'
  );

  -- ...and it still does not make the case support tier A, because
  -- tier A requires a CONFIRMED outcome. Import provenance is never a
  -- shortcut around the evidence rules.
  SELECT public.historical_case_evidence_supports_tier(v_case, 'A')
  INTO v_supports_a;

  IF v_supports_a THEN
    RAISE EXCEPTION
      'an imported_historical collected amount was treated as a confirmed outcome';
  END IF;

  BEGIN
    UPDATE historical_cases
    SET completed_at = NOW(), evidence_quality_tier = 'A'
    WHERE id = v_case;
    RAISE EXCEPTION 'an imported case claimed tier A without a confirmed outcome';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- ------------------------------------------------------------
  -- 6. An imported case starts `pending`, and `import_policy` is a
  -- basis the eligibility model already understands.
  -- ------------------------------------------------------------
  SELECT learning_eligibility INTO v_eligibility
  FROM historical_cases WHERE id = v_case;

  IF v_eligibility IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION
      'an imported case started as %, expected pending', v_eligibility;
  END IF;

  UPDATE historical_cases
  SET learning_eligibility = 'excluded',
      learning_exclusion_reason = 'ambiguous',
      learning_eligibility_basis = 'import_policy'
  WHERE id = v_case;

  -- ------------------------------------------------------------
  -- 7. Account isolation, exercised as `authenticated` rather than as
  --    the table owner.
  --
  --    Everything above runs as the migration owner, whose writes bypass
  --    RLS entirely, so "the policies exist" (asserted in
  --    verify-schema.sql) is not the same claim as "the policies work".
  --    This section impersonates a member of a DIFFERENT account and
  --    proves they can neither read this account's import ledger nor
  --    write into it.
  -- ------------------------------------------------------------
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object(
      'sub', v_user_b::TEXT,
      'role', 'authenticated',
      'email', 'verify-import-b@example.invalid'
    )::TEXT,
    true
  );
  SET LOCAL ROLE authenticated;

  SELECT count(*) INTO v_readable
  FROM historical_import_runs WHERE account_id = v_account_a;

  IF v_readable <> 0 THEN
    RAISE EXCEPTION
      'a member of another account read this account''s import runs';
  END IF;

  SELECT count(*) INTO v_readable
  FROM historical_case_sources WHERE account_id = v_account_a;

  IF v_readable <> 0 THEN
    RAISE EXCEPTION
      'a member of another account read this account''s source ledger';
  END IF;

  -- And the write is refused, not merely the read.
  BEGIN
    INSERT INTO historical_import_runs (
      account_id, source_type, status, completed_at, dry_run,
      importer_version
    ) VALUES (
      v_account_a, 'enquiries', 'completed', NOW(), FALSE,
      'wacrm-historical-import-v1'
    );
    RAISE EXCEPTION 'a member of another account inserted an import run';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  RESET ROLE;

  -- ------------------------------------------------------------
  -- Cleanup. Deleting the accounts cascades to everything above.
  -- ------------------------------------------------------------
  DELETE FROM accounts WHERE id IN (v_account_a, v_account_b);
  DELETE FROM auth.users WHERE id IN (v_user_a, v_user_b);

  RAISE NOTICE 'historical import verification passed';
END
$$;