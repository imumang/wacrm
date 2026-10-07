-- ============================================================
-- verify-outcome-capture.sql - row-level verification of the job
-- outcome capture guards (migration 050).
--
-- `verify-schema.sql` asserts the SHAPE of the schema: the tables
-- exist, the constraints are named, the pure vocabularies accept and
-- reject the right values. That covers a lot, and it covers none of the
-- behaviour that only exists inside a trigger.
--
-- This file asserts the BEHAVIOUR, against a real case built in a real
-- account:
--
--   1. A recorded labour duration must equal the duration derived from
--      the case's own arrival and departure timestamps.
--   2. A model still cannot write an outcome fact, even on a
--      service-role write that bypasses RLS.
--   3. A finalized case is frozen: its facts, its evidence tier and its
--      completion timestamp cannot be changed afterwards.
--   4. The one correction a frozen case does accept - withdrawing it
--      from training, and putting it back - is accepted.
--   5. Finalization is idempotent in the database: a second snapshot of
--      the same kind cannot be appended.
--   6. A case cannot be attached to another account's enquiry.
--
-- Everything it creates, it removes. The assertions run against the
-- same file's own fixtures rather than any pre-existing row, so this is
-- safe to run repeatedly against a database that already has data.
--
-- Like `verify-schema.sql` this file must contain EXACTLY ONE
-- statement: `supabase db query --file` sends the whole file as a
-- prepared statement, and a second top-level statement fails with
-- "cannot insert multiple commands into a prepared statement".
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
  v_facts INTEGER;
  v_tier TEXT;
  v_snapshots INTEGER;
BEGIN
  -- ------------------------------------------------------------
  -- Fixtures. Two accounts, because the isolation assertions are only
  -- meaningful with something to be isolated FROM.
  --
  -- The accounts come from `handle_new_user()`, which migration 017
  -- installs as an AFTER INSERT trigger on auth.users and which creates
  -- a personal account per user. Inserting accounts by hand as well
  -- would collide with `idx_accounts_one_per_owner`, so the accounts
  -- are read back from the profiles the trigger wrote.
  -- ------------------------------------------------------------
  v_user_a := gen_random_uuid();
  v_user_b := gen_random_uuid();
  INSERT INTO auth.users (id, email) VALUES
    (v_user_a, 'verify-outcome-a@example.invalid'),
    (v_user_b, 'verify-outcome-b@example.invalid');

  SELECT account_id INTO v_account_a FROM profiles WHERE user_id = v_user_a;
  SELECT account_id INTO v_account_b FROM profiles WHERE user_id = v_user_b;

  IF v_account_a IS NULL OR v_account_b IS NULL THEN
    RAISE EXCEPTION
      'handle_new_user() did not create accounts for the verification users';
  END IF;
  IF v_account_a = v_account_b THEN
    RAISE EXCEPTION
      'the two verification users must land in different accounts';
  END IF;

  INSERT INTO contacts (id, account_id, user_id, name, phone)
  VALUES (gen_random_uuid(), v_account_a, v_user_a, 'Verify Contact', '+441234567890')
  RETURNING id INTO v_contact;

  INSERT INTO conversations (id, account_id, user_id, contact_id)
  VALUES (gen_random_uuid(), v_account_a, v_user_a, v_contact)
  RETURNING id INTO v_conversation;

  INSERT INTO enquiries (id, account_id, conversation_id, created_by_user_id)
  VALUES (gen_random_uuid(), v_account_a, v_conversation, v_user_a)
  RETURNING id INTO v_enquiry;

  INSERT INTO historical_cases (
    account_id, enquiry_id, conversation_id, contact_id, created_by_user_id
  )
  VALUES (v_account_a, v_enquiry, v_conversation, v_contact, v_user_a)
  RETURNING id INTO v_case;

  -- ------------------------------------------------------------
  -- 1. Derived labour duration.
  -- ------------------------------------------------------------
  INSERT INTO historical_case_facts (
    account_id, case_id, fact_key, value_source, value_timestamp, provenance
  ) VALUES
    (v_account_a, v_case, 'arrival_at', 'captured',
     '2026-03-01T09:00:00Z'::timestamptz, 'confirmed_outcome'),
    (v_account_a, v_case, 'departed_at', 'captured',
     '2026-03-01T10:45:00Z'::timestamptz, 'confirmed_outcome');

  -- The correct duration is accepted.
  BEGIN
    INSERT INTO historical_case_facts (
      account_id, case_id, fact_key, value_source, value_integer, provenance
    ) VALUES (
      v_account_a, v_case, 'actual_labour_minutes', 'captured', 105,
      'system_derived'
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION
      'a correctly derived labour duration was rejected: %', SQLERRM;
  END;

  -- A hand-typed duration that disagrees with the timestamps is not.
  BEGIN
    INSERT INTO historical_case_facts (
      account_id, case_id, fact_key, value_source, value_integer, provenance
    ) VALUES (
      v_account_a, v_case, 'actual_labour_minutes', 'captured', 90,
      'operator_entered'
    );
    RAISE EXCEPTION
      'a labour duration contradicting arrival_at and departed_at was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;  -- the guard fired, which is the assertion
  END;

  -- And a correction of the timestamps is NOT blocked by the stored
  -- duration, because an operator who mistyped a departure time has to
  -- be able to fix it. The capture service rewrites the derived value
  -- in the same call.
  BEGIN
    UPDATE historical_case_facts
    SET value_timestamp = '2026-03-01T10:30:00Z'::timestamptz
    WHERE case_id = v_case AND fact_key = 'departed_at';
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION
      'a timestamp correction was blocked by the stored duration: %', SQLERRM;
  END;

  -- Put it back, so the later assertions see a coherent case.
  UPDATE historical_case_facts
  SET value_timestamp = '2026-03-01T10:45:00Z'::timestamptz
  WHERE case_id = v_case AND fact_key = 'departed_at';

  -- ------------------------------------------------------------
  -- 2. An AI suggestion is never an outcome, on any write path.
  -- ------------------------------------------------------------
  BEGIN
    INSERT INTO historical_case_facts (
      account_id, case_id, fact_key, value_source, value_number, provenance
    ) VALUES (
      v_account_a, v_case, 'final_amount_collected', 'captured', 380,
      'ai_suggested'
    );
    RAISE EXCEPTION 'an AI suggestion was accepted as a collected amount';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO historical_case_facts (
      account_id, case_id, fact_key, value_source, value_number, provenance
    ) VALUES (
      v_account_a, v_case, 'actual_disposal_weight_kg', 'captured', 420,
      'ai_suggested'
    );
    RAISE EXCEPTION 'an AI suggestion was accepted as a disposal weight';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- And the real, measured outcome is accepted.
  INSERT INTO historical_case_facts (
    account_id, case_id, fact_key, value_source, value_number, provenance
  ) VALUES (
    v_account_a, v_case, 'final_amount_collected', 'captured', 385,
    'confirmed_outcome'
  );

  -- ------------------------------------------------------------
  -- 6. Cross-account attachment is impossible.
  -- ------------------------------------------------------------
  BEGIN
    INSERT INTO historical_cases (
      account_id, enquiry_id, conversation_id, contact_id
    )
    SELECT v_account_b, v_enquiry, v_conversation, v_contact;
    RAISE EXCEPTION 'a case was attached to another account''s enquiry';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO historical_cases (
      account_id, enquiry_id, conversation_id, contact_id
    )
    SELECT v_account_a, v_enquiry, v_conversation, gen_random_uuid();
    RAISE EXCEPTION 'unreachable';
  EXCEPTION WHEN foreign_key_violation OR check_violation THEN
    NULL;
  END;

  -- A case claiming a contact that is not its conversation's contact.
  INSERT INTO contacts (id, account_id, user_id, name, phone)
  VALUES (gen_random_uuid(), v_account_a, v_user_a, 'Other Contact', '+441234567891')
  RETURNING id INTO v_contact;
  BEGIN
    INSERT INTO historical_cases (
      account_id, enquiry_id, conversation_id, contact_id
    ) VALUES (
      v_account_a, v_enquiry, v_conversation, v_contact
    );
    RAISE EXCEPTION 'a case was attached to the wrong contact';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- ------------------------------------------------------------
  -- Tier A is earned, and only then claimed.
  -- ------------------------------------------------------------
  UPDATE historical_cases SET completed_at = '2026-03-01T11:30:00Z'
  WHERE id = v_case;

  IF NOT public.historical_case_evidence_supports_tier(v_case, 'A') THEN
    RAISE EXCEPTION
      'a completed job with a confirmed final amount does not support tier A';
  END IF;

  BEGIN
    UPDATE historical_cases SET evidence_quality_tier = 'E'
    WHERE id = v_case;
    RAISE EXCEPTION 'an unsupported evidence tier was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  UPDATE historical_cases SET evidence_quality_tier = 'A'
  WHERE id = v_case;

  -- ------------------------------------------------------------
  -- 5. One frozen snapshot per finalization kind.
  -- ------------------------------------------------------------
  INSERT INTO historical_case_snapshots (
    account_id, case_id, snapshot_kind, payload, source_version
  ) VALUES (
    v_account_a, v_case, 'outcome', '{"final_amount_collected":385}',
    'outcome-capture-v1'
  );

  BEGIN
    INSERT INTO historical_case_snapshots (
      account_id, case_id, snapshot_kind, payload, source_version
    ) VALUES (
      v_account_a, v_case, 'outcome', '{"final_amount_collected":999}',
      'outcome-capture-v1'
    );
    RAISE EXCEPTION 'a second outcome snapshot was accepted for one case';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  -- A classification snapshot may repeat; a correction may repeat.
  INSERT INTO historical_case_snapshots (
    account_id, case_id, snapshot_kind, payload, source_version
  ) VALUES
    (v_account_a, v_case, 'evidence_classification',
     '{"evidence_quality_tier":"A"}', 'evidence-tier-v2'),
    (v_account_a, v_case, 'evidence_classification',
     '{"evidence_quality_tier":"A"}', 'evidence-tier-v2'),
    (v_account_a, v_case, 'correction', '{"note":"first"}',
     'outcome-capture-v1'),
    (v_account_a, v_case, 'correction', '{"note":"second"}',
     'outcome-capture-v1');

  -- ------------------------------------------------------------
  -- 3. A finalized case is frozen.
  -- ------------------------------------------------------------
  UPDATE historical_cases
  SET case_state = 'finalized', finalized_at = '2026-03-02T09:00:00Z'
  WHERE id = v_case;

  BEGIN
    INSERT INTO historical_case_facts (
      account_id, case_id, fact_key, value_source, value_number, provenance
    ) VALUES (
      v_account_a, v_case, 'final_amount_collected', 'captured', 999,
      'confirmed_outcome'
    );
    RAISE EXCEPTION 'a fact of a finalized case was written';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    UPDATE historical_cases SET completed_at = '2026-03-03T09:00:00Z'
    WHERE id = v_case;
    RAISE EXCEPTION 'the completion timestamp of a finalized case was changed';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    UPDATE historical_cases SET evidence_quality_tier = 'B'
    WHERE id = v_case;
    RAISE EXCEPTION 'the evidence tier of a finalized case was changed';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    UPDATE historical_case_snapshots
    SET payload = '{"tampered":true}'
    WHERE case_id = v_case AND snapshot_kind = 'outcome';
    RAISE EXCEPTION 'a frozen snapshot was amended';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    DELETE FROM historical_case_snapshots
    WHERE case_id = v_case AND snapshot_kind = 'outcome';
    RAISE EXCEPTION 'a frozen snapshot was deleted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- ------------------------------------------------------------
  -- 4. The one correction a frozen case accepts, and its reversal.
  -- ------------------------------------------------------------
  BEGIN
    UPDATE historical_cases
    SET learning_eligibility = 'excluded',
        learning_exclusion_reason = 'bad_data',
        learning_eligibility_basis = 'operator'
    WHERE id = v_case;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION
      'withdrawing a finalized case from training was rejected: %', SQLERRM;
  END;

  -- Re-inclusion, because a decision nobody can undo is not one.
  BEGIN
    UPDATE historical_cases
    SET learning_eligibility = 'included',
        learning_exclusion_reason = NULL,
        learning_eligibility_basis = 'operator'
    WHERE id = v_case;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION
      're-including a finalized case was rejected: %', SQLERRM;
  END;

  -- Anything else is still refused, including a silent re-freeze attempt.
  BEGIN
    UPDATE historical_cases
    SET finalized_at = NULL, case_state = 'open'
    WHERE id = v_case;
    RAISE EXCEPTION 'a finalized case was unfrozen';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    UPDATE historical_cases
    SET learning_eligibility = 'pending'
    WHERE id = v_case;
    RAISE EXCEPTION
      'a finalized case was reset to pending without a decision';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- ------------------------------------------------------------
  -- The frozen case is exactly what it said it was.
  -- ------------------------------------------------------------
  SELECT value_number INTO v_facts
  FROM historical_case_facts
  WHERE case_id = v_case AND fact_key = 'final_amount_collected';

  IF v_facts IS DISTINCT FROM 385 THEN
    RAISE EXCEPTION
      'the frozen collected amount is %, expected 385', v_facts;
  END IF;

  SELECT evidence_quality_tier INTO v_tier
  FROM historical_cases WHERE id = v_case;

  IF v_tier IS DISTINCT FROM 'A' THEN
    RAISE EXCEPTION 'the frozen evidence tier is %, expected A', v_tier;
  END IF;

  SELECT COUNT(*) INTO v_snapshots
  FROM historical_case_snapshots
  WHERE case_id = v_case AND snapshot_kind = 'outcome';

  IF v_snapshots <> 1 THEN
    RAISE EXCEPTION
      'expected exactly one frozen outcome snapshot, found %', v_snapshots;
  END IF;

  -- ------------------------------------------------------------
  -- Cleanup. Deleting the accounts cascades to everything above.
  -- ------------------------------------------------------------
  DELETE FROM accounts WHERE id IN (v_account_a, v_account_b);
  DELETE FROM auth.users WHERE id IN (v_user_a, v_user_b);

  RAISE NOTICE 'outcome capture verification passed';
END
$$;