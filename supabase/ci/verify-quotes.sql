-- Row-level verification for migration 052. Exactly one top-level statement.
DO $$
DECLARE
  v_user_a UUID := gen_random_uuid();
  v_user_b UUID := gen_random_uuid();
  v_account_a UUID;
  v_account_b UUID;
  v_contact_a UUID;
  v_contact_ai UUID;
  v_contact_import UUID;
  v_conversation_a UUID;
  v_conversation_ai UUID;
  v_conversation_import UUID;
  v_enquiry_a UUID;
  v_enquiry_ai UUID;
  v_enquiry_import UUID;
  v_quote_1 UUID;
  v_quote_2 UUID;
  v_quote_ai UUID;
  v_quote_override UUID;
  v_quote_followup UUID;
  v_quote_import UUID;
  v_case_import UUID;
  v_replay UUID;
  v_count INTEGER;
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    (v_user_a, 'verify-quotes-a@example.invalid'),
    (v_user_b, 'verify-quotes-b@example.invalid');
  SELECT account_id INTO v_account_a FROM profiles WHERE user_id = v_user_a;
  SELECT account_id INTO v_account_b FROM profiles WHERE user_id = v_user_b;

  INSERT INTO contacts (id, account_id, user_id, name, phone) VALUES
    (gen_random_uuid(), v_account_a, v_user_a, 'Quote A', '+441110000001')
    RETURNING id INTO v_contact_a;
  INSERT INTO contacts (id, account_id, user_id, name, phone) VALUES
    (gen_random_uuid(), v_account_a, v_user_a, 'Quote AI', '+441110000002')
    RETURNING id INTO v_contact_ai;
  INSERT INTO contacts (id, account_id, user_id, name, phone) VALUES
    (gen_random_uuid(), v_account_a, v_user_a, 'Quote Import', '+441110000003')
    RETURNING id INTO v_contact_import;

  INSERT INTO conversations (id, account_id, user_id, contact_id) VALUES
    (gen_random_uuid(), v_account_a, v_user_a, v_contact_a)
    RETURNING id INTO v_conversation_a;
  INSERT INTO conversations (id, account_id, user_id, contact_id) VALUES
    (gen_random_uuid(), v_account_a, v_user_a, v_contact_ai)
    RETURNING id INTO v_conversation_ai;
  INSERT INTO conversations (id, account_id, user_id, contact_id) VALUES
    (gen_random_uuid(), v_account_a, v_user_a, v_contact_import)
    RETURNING id INTO v_conversation_import;

  INSERT INTO enquiries (account_id, conversation_id, created_by_user_id) VALUES
    (v_account_a, v_conversation_a, v_user_a) RETURNING id INTO v_enquiry_a;
  INSERT INTO enquiries (account_id, conversation_id, created_by_user_id) VALUES
    (v_account_a, v_conversation_ai, v_user_a) RETURNING id INTO v_enquiry_ai;
  INSERT INTO enquiries (account_id, conversation_id, created_by_user_id) VALUES
    (v_account_a, v_conversation_import, v_user_a) RETURNING id INTO v_enquiry_import;

  -- Fixed quote; approval and presentation remain separate transitions.
  INSERT INTO quotes (
    account_id, enquiry_id, revision_number, status, origin, currency,
    amount_type, fixed_amount_minor, created_by_user_id,
    creation_idempotency_key
  ) VALUES (
    v_account_a, v_enquiry_a, 1, 'draft', 'manual', 'GBP', 'fixed', 28000,
    v_user_a, 'verify-manual-v1'
  ) RETURNING id INTO v_quote_1;

  UPDATE quotes SET
    status = 'approved', approved_at = NOW(), approved_by_user_id = v_user_a,
    last_action_idempotency_key = 'verify-approve-v1',
    last_action_by_user_id = v_user_a
  WHERE id = v_quote_1;
  UPDATE quotes SET
    status = 'presented', presented_at = NOW(), presented_by_user_id = v_user_a,
    last_action_idempotency_key = 'verify-present-v1',
    last_action_by_user_id = v_user_a
  WHERE id = v_quote_1;

  -- Revision is atomic: v1 is retained and v2 is the one current quote.
  SELECT (public.quote_create_revision(
    v_account_a, v_quote_1, v_user_a, 'verify-revise-v2', 'manual', NULL,
    'GBP', 'range', NULL, 34000, 37000,
    ARRAY['scope as described'], ARRAY['hazardous waste'], NULL, NULL, NULL,
    NULL, NULL
  )).id INTO v_quote_2;

  IF (SELECT status FROM quotes WHERE id = v_quote_1) <> 'superseded'
     OR (SELECT fixed_amount_minor FROM quotes WHERE id = v_quote_1) <> 28000
     OR (SELECT revision_number FROM quotes WHERE id = v_quote_2) <> 2
     OR (SELECT amount_type FROM quotes WHERE id = v_quote_2) <> 'range' THEN
    RAISE EXCEPTION 'quote revision overwrote history or lost its range';
  END IF;
  SELECT count(*) INTO v_count FROM quotes
  WHERE account_id = v_account_a AND enquiry_id = v_enquiry_a
    AND status IN ('draft', 'awaiting_approval', 'approved', 'presented');
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly one current quote, found %', v_count;
  END IF;

  -- Same idempotency key returns the same revision and creates nothing.
  SELECT (public.quote_create_revision(
    v_account_a, v_quote_1, v_user_a, 'verify-revise-v2', 'manual', NULL,
    'GBP', 'range', NULL, 34000, 37000,
    ARRAY['scope as described'], ARRAY['hazardous waste'], NULL, NULL, NULL,
    NULL, NULL
  )).id INTO v_replay;
  IF v_replay <> v_quote_2 THEN
    RAISE EXCEPTION 'revision idempotency did not return the winner';
  END IF;
  SELECT count(*) INTO v_count FROM quotes WHERE enquiry_id = v_enquiry_a;
  IF v_count <> 2 THEN RAISE EXCEPTION 'duplicate revision was created'; END IF;

  -- A different concurrent/stale command loses once its parent is superseded.
  BEGIN
    PERFORM public.quote_create_revision(
      v_account_a, v_quote_1, v_user_a, 'verify-stale-revision', 'manual', NULL,
      'GBP', 'fixed', 39000, NULL, NULL, ARRAY[]::TEXT[], ARRAY[]::TEXT[],
      NULL, NULL, NULL, NULL, NULL
    );
    RAISE EXCEPTION USING
      ERRCODE = 'ZX001', MESSAGE = 'a stale concurrent revision was accepted';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;

  -- AI suggestion remains only a prediction. A human override references it.
  INSERT INTO quotes (
    account_id, enquiry_id, revision_number, status, origin, currency,
    amount_type, fixed_amount_minor, created_by_user_id,
    creation_idempotency_key
  ) VALUES (
    v_account_a, v_enquiry_ai, 1, 'awaiting_approval', 'ai_suggested',
    'GBP', 'fixed', 30000, v_user_a, 'verify-ai-v1'
  ) RETURNING id INTO v_quote_ai;

  IF (SELECT approved_at FROM quotes WHERE id = v_quote_ai) IS NOT NULL
     OR (SELECT customer_decision FROM quotes WHERE id = v_quote_ai) <> 'unknown' THEN
    RAISE EXCEPTION 'AI suggestion became approval or customer truth';
  END IF;

  SELECT (public.quote_create_revision(
    v_account_a, v_quote_ai, v_user_a, 'verify-override-v2', 'manual', v_quote_ai,
    'GBP', 'fixed', 34000, NULL, NULL, ARRAY[]::TEXT[], ARRAY[]::TEXT[],
    NULL, NULL, NULL, 'manual_judgement', NULL
  )).id INTO v_quote_override;
  IF (SELECT recommendation_quote_id FROM quotes WHERE id = v_quote_override)
       <> v_quote_ai THEN
    RAISE EXCEPTION 'operator override lost its AI recommendation reference';
  END IF;

  UPDATE quotes SET
    status = 'approved', approved_at = NOW(), approved_by_user_id = v_user_a,
    last_action_idempotency_key = 'verify-override-approve',
    last_action_by_user_id = v_user_a
  WHERE id = v_quote_override;
  UPDATE quotes SET
    status = 'presented', presented_at = NOW(), presented_by_user_id = v_user_a,
    last_action_idempotency_key = 'verify-override-present',
    last_action_by_user_id = v_user_a
  WHERE id = v_quote_override;
  UPDATE quotes SET
    customer_decision = 'found_better_price', decision_recorded_at = NOW(),
    decision_recorded_by_user_id = v_user_a,
    last_action_idempotency_key = 'verify-override-decision',
    last_action_by_user_id = v_user_a
  WHERE id = v_quote_override;

  IF (SELECT customer_decision FROM quotes WHERE id = v_quote_override)
       <> 'found_better_price' THEN
    RAISE EXCEPTION 'customer decision was not preserved distinctly';
  END IF;

  SELECT (public.quote_create_revision(
    v_account_a, v_quote_override, v_user_a, 'verify-followup-v3', 'manual',
    v_quote_ai, 'GBP', 'fixed', 32000, NULL, NULL, ARRAY[]::TEXT[],
    ARRAY[]::TEXT[], NULL, NULL, NULL, 'market_commercial_adjustment', NULL
  )).id INTO v_quote_followup;
  IF (SELECT customer_decision FROM quotes WHERE id = v_quote_override)
       <> 'found_better_price'
     OR (SELECT status FROM quotes WHERE id = v_quote_override) <> 'superseded'
     OR (SELECT customer_decision FROM quotes WHERE id = v_quote_followup)
       <> 'unknown' THEN
    RAISE EXCEPTION 'follow-up revision erased or inherited a customer decision';
  END IF;

  -- Imported quote is explicit and missing decision remains unknown.
  INSERT INTO quotes (
    account_id, enquiry_id, revision_number, status, origin, currency,
    amount_type, fixed_amount_minor, source_reference, source_observed_at,
    created_by_user_id, creation_idempotency_key
  ) VALUES (
    v_account_a, v_enquiry_import, 1, 'draft', 'imported_historical',
    'GBP', 'fixed', 25000, 'invoice-17', '2024-06-01T10:00:00Z',
    v_user_a, 'verify-import-v1'
  ) RETURNING id INTO v_quote_import;
  IF (SELECT customer_decision FROM quotes WHERE id = v_quote_import) <> 'unknown' THEN
    RAISE EXCEPTION 'missing historical decision was fabricated';
  END IF;

  INSERT INTO historical_cases (
    account_id, enquiry_id, conversation_id, contact_id, source_kind,
    created_by_user_id
  ) VALUES (
    v_account_a, v_enquiry_import, v_conversation_import, v_contact_import,
    'imported_historical', v_user_a
  ) RETURNING id INTO v_case_import;
  UPDATE historical_cases
  SET case_state = 'finalized', finalized_at = NOW()
  WHERE id = v_case_import;
  BEGIN
    UPDATE quotes SET
      status = 'approved', approved_at = NOW(), approved_by_user_id = v_user_a,
      last_action_idempotency_key = 'verify-after-finalization',
      last_action_by_user_id = v_user_a
    WHERE id = v_quote_import;
    RAISE EXCEPTION 'a quote changed after historical finalization';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- Invalid range and old-term mutation are both refused.
  BEGIN
    INSERT INTO quotes (
      account_id, enquiry_id, revision_number, status, origin, currency,
      amount_type, range_min_minor, range_max_minor, created_by_user_id,
      creation_idempotency_key
    ) VALUES (
      v_account_a, v_enquiry_import, 2, 'draft', 'manual', 'GBP', 'range',
      40000, 30000, v_user_a, 'verify-bad-range'
    );
    RAISE EXCEPTION 'invalid monetary range was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    UPDATE quotes SET fixed_amount_minor = 29000,
      last_action_idempotency_key = 'verify-mutate-old',
      last_action_by_user_id = v_user_a
    WHERE id = v_quote_1;
    RAISE EXCEPTION 'superseded quote terms were mutable';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  SELECT count(*) INTO v_count FROM quote_events
  WHERE quote_id = v_quote_override AND actor_user_id = v_user_a;
  IF v_count < 4 THEN
    RAISE EXCEPTION 'quote transition audit/actor attribution is incomplete';
  END IF;
  BEGIN
    INSERT INTO quote_events (
      account_id, quote_id, event_type, from_status, to_status,
      actor_user_id, idempotency_key
    ) VALUES (
      v_account_a, v_quote_followup, 'created', NULL, 'draft',
      v_user_a, 'verify-forged-event'
    );
    RAISE EXCEPTION 'a quote event was inserted outside the audit trigger';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    DELETE FROM quote_events WHERE quote_id = v_quote_override;
    RAISE EXCEPTION 'quote events were deletable';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- Composite tenancy FK blocks a privileged cross-account attachment.
  BEGIN
    INSERT INTO quotes (
      account_id, enquiry_id, revision_number, status, origin, currency,
      amount_type, fixed_amount_minor, created_by_user_id,
      creation_idempotency_key
    ) VALUES (
      v_account_b, v_enquiry_a, 1, 'draft', 'manual', 'GBP', 'fixed', 1,
      v_user_b, 'verify-cross-account'
    );
    RAISE EXCEPTION 'cross-account quote attachment was accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  -- Exercise RLS as a member of the other account, not as table owner.
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object(
      'sub', v_user_b::TEXT, 'role', 'authenticated',
      'email', 'verify-quotes-b@example.invalid'
    )::TEXT,
    true
  );
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_count FROM quotes WHERE account_id = v_account_a;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'a member of another account read quotes';
  END IF;
  SELECT count(*) INTO v_count FROM quote_events WHERE account_id = v_account_a;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'a member of another account read quote events';
  END IF;
  BEGIN
    INSERT INTO quotes (
      account_id, enquiry_id, revision_number, status, origin, currency,
      amount_type, fixed_amount_minor, created_by_user_id,
      creation_idempotency_key
    ) VALUES (
      v_account_a, v_enquiry_a, 1, 'draft', 'manual', 'GBP', 'fixed', 1,
      v_user_b, 'verify-rls-write'
    );
    RAISE EXCEPTION 'a member of another account wrote a quote';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RESET ROLE;

  -- A same-account viewer may read the audit but cannot mutate quotes.
  UPDATE profiles
  SET account_id = v_account_a, account_role = 'viewer'
  WHERE user_id = v_user_b;
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object(
      'sub', v_user_b::TEXT, 'role', 'authenticated',
      'email', 'verify-quotes-b@example.invalid'
    )::TEXT,
    true
  );
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_count FROM quotes WHERE account_id = v_account_a;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'a same-account viewer could not read quotes';
  END IF;
  UPDATE quotes SET status = 'withdrawn',
    last_action_idempotency_key = 'verify-viewer-update',
    last_action_by_user_id = v_user_b
  WHERE id = v_quote_followup;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'a same-account viewer updated a quote';
  END IF;
  RESET ROLE;

  DELETE FROM accounts WHERE id IN (v_account_a, v_account_b);
  DELETE FROM auth.users WHERE id IN (v_user_a, v_user_b);
  RAISE NOTICE 'quote lifecycle verification passed';
END
$$;
