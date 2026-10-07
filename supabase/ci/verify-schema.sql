-- Post-migration assertions for the CI job in
-- `.github/workflows/migrations.yml`.
--
-- `supabase db reset` already fails on any statement Postgres rejects,
-- so this is not about syntax. It's about the quieter failure: a
-- migration that applies cleanly and does nothing. Every DDL statement
-- in this repo is guarded with IF NOT EXISTS / ON CONFLICT so the files
-- can be re-run safely, and that same guard turns a typo'd object name
-- into a silent no-op with a green checkmark.
--
-- Keep this thin. It is a smoke test for "did the migrations actually
-- build the schema", not a spec of it — asserting every column here
-- would just be the migrations restated in a second place, drifting.
DO $$
BEGIN
  -- The core tables, from 001.
  IF to_regclass('public.messages') IS NULL THEN
    RAISE EXCEPTION 'public.messages is missing — migrations did not apply';
  END IF;
  IF to_regclass('public.whatsapp_config') IS NULL THEN
    RAISE EXCEPTION 'public.whatsapp_config is missing — migrations did not apply';
  END IF;

  -- Supabase provides the storage schema; migrations 016/020/023 write
  -- to it. If it is absent the bucket migrations silently accomplish
  -- nothing, which is precisely the case a plain "no errors" run hides.
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE EXCEPTION
      'storage.buckets is missing — the storage schema was not available when the bucket migrations ran';
  END IF;

  -- Buckets are UPSERTed, so their absence means the INSERT never ran.
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'chat-media') THEN
    RAISE EXCEPTION 'the chat-media bucket row was not created (migration 023)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'flow-media') THEN
    RAISE EXCEPTION 'the flow-media bucket row was not created (migration 016)';
  END IF;

  -- Account scoping (017) is load-bearing for every RLS policy.
  IF to_regclass('public.accounts') IS NULL THEN
    RAISE EXCEPTION 'public.accounts is missing — migration 017 did not apply';
  END IF;

  -- The BSUID index (040) is the only thing stopping a username-only
  -- WhatsApp sender from forking a new contact per inbound message. A
  -- typo in its name would apply cleanly and guarantee nothing.
  IF to_regclass('public.idx_contacts_account_wa_user_id') IS NULL THEN
    RAISE EXCEPTION
      'idx_contacts_account_wa_user_id is missing — migration 040 did not apply';
  END IF;

  -- 041 repairs create_broadcast_with_recipients, which 037/038 shipped
  -- with an ambiguous bare `RETURNING id, contact_id` (SQLSTATE 42702 on
  -- first call — plpgsql resolves names at execution, not CREATE, so a
  -- plain replay can't catch it). Assert the qualified form is what's
  -- actually installed.
  IF pg_get_functiondef(
       'public.create_broadcast_with_recipients(uuid,uuid,text,text,text,integer,uuid[],jsonb[])'::regprocedure
     ) NOT LIKE '%RETURNING id, broadcast_recipients.contact_id%' THEN
    RAISE EXCEPTION
      'create_broadcast_with_recipients still has the ambiguous RETURNING — migration 041 did not apply';
  END IF;

  -- The failure-reason columns (042) are only ever written by the
  -- status webhook, which uses an untyped update — a missing column
  -- there is a runtime PostgREST error on every failed send, not a
  -- compile error.
  IF (
    SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'messages'
      AND column_name IN ('error_code', 'error_title', 'error_details')
  ) <> 3 THEN
    RAISE EXCEPTION
      'messages.error_code/error_title/error_details are missing — migration 042 did not apply';
  END IF;

  -- Migration 044 removes every schema object that belonged only to the
  -- retired linked-device transport. Assert the final state so a guarded
  -- DROP typo cannot silently leave credential storage or dead columns.
  IF to_regclass('public.whatsapp_linked_devices') IS NOT NULL THEN
    RAISE EXCEPTION
      'public.whatsapp_linked_devices still exists - migration 044 did not apply';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND (
         (table_name = 'contacts' AND column_name = 'wa_jid') OR
         (table_name = 'messages' AND column_name = 'transport') OR
         (table_name = 'whatsapp_config' AND column_name = 'transport')
       )
  ) THEN
    RAISE EXCEPTION
      'linked-device-only columns still exist - migration 044 did not apply';
  END IF;

  -- Objective 01: the enquiry table, one-active-enquiry backstop, and
  -- database transition guard are load-bearing. Historical conversations
  -- intentionally remain valid without an enquiry row.
  IF to_regclass('public.enquiries') IS NULL
     OR to_regclass('public.enquiry_state_events') IS NULL THEN
    RAISE EXCEPTION
      'enquiry state tables are missing - migration 045 did not apply';
  END IF;

  IF to_regclass('public.idx_enquiries_one_active_per_conversation') IS NULL THEN
    RAISE EXCEPTION
      'active-enquiry uniqueness index is missing - migration 045 did not apply';
  END IF;

  IF NOT (
    SELECT c.relrowsecurity
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'enquiries'
  ) THEN
    RAISE EXCEPTION 'RLS is not enabled on public.enquiries';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'enquiries_conversation_account_fk'
      AND conrelid = 'public.enquiries'::regclass
  ) THEN
    RAISE EXCEPTION 'enquiry account/conversation composite FK is missing';
  END IF;

  IF (
    SELECT COUNT(*) FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'enquiries'
      AND policyname IN ('enquiries_select', 'enquiries_insert', 'enquiries_update')
  ) <> 3 THEN
    RAISE EXCEPTION 'enquiry RLS policies are incomplete';
  END IF;

  IF NOT public.is_valid_enquiry_state_transition('new_enquiry', 'gathering_information')
     OR public.is_valid_enquiry_state_transition('completed', 'new_enquiry') THEN
    RAISE EXCEPTION 'enquiry state transition guard is incorrect';
  END IF;

  IF to_regclass('public.idx_enquiries_repeat_action_idempotency') IS NULL THEN
    RAISE EXCEPTION
      'repeat-enquiry idempotency index is missing - migration 046 did not apply';
  END IF;

  IF (
    SELECT COUNT(*)
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'enquiries'
      AND column_name IN (
        'repeat_action_idempotency_key',
        'repeat_action_approval_id',
        'repeat_action_correlation_id'
      )
  ) <> 3 THEN
    RAISE EXCEPTION 'repeat-enquiry audit metadata columns are incomplete';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'enquiries_repeat_action_metadata_check'
      AND conrelid = 'public.enquiries'::regclass
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'guard_enquiry_repeat_action_metadata'
      AND tgrelid = 'public.enquiries'::regclass
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'repeat-enquiry action metadata guards are incomplete';
  END IF;

  -- Objective 02: the durable AI tool-call audit trail. Every guard in this
  -- migration fails silently when it does not apply, so assert the objects
  -- rather than trusting a green migration run.
  IF to_regclass('public.ai_tool_call_audit') IS NULL THEN
    RAISE EXCEPTION
      'ai tool call audit table is missing - migration 047 did not apply';
  END IF;

  IF to_regclass('public.idx_ai_tool_call_audit_account_started') IS NULL
     OR to_regclass('public.idx_ai_tool_call_audit_account_correlation') IS NULL THEN
    RAISE EXCEPTION
      'ai tool call audit indexes are missing - migration 047 did not apply';
  END IF;

  IF NOT (
    SELECT c.relrowsecurity
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'ai_tool_call_audit'
  ) THEN
    RAISE EXCEPTION 'RLS is not enabled on public.ai_tool_call_audit';
  END IF;

  -- Account scoping is load-bearing: the trail must never be readable or
  -- writable across tenants.
  IF (
    SELECT COUNT(*)
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'ai_tool_call_audit'
      AND policyname IN ('ai_tool_call_audit_select', 'ai_tool_call_audit_insert')
  ) <> 2 THEN
    RAISE EXCEPTION 'ai tool call audit RLS policies are incomplete';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'ai_tool_call_audit'
      AND policyname IN ('ai_tool_call_audit_update', 'ai_tool_call_audit_delete')
  ) THEN
    RAISE EXCEPTION
      'ai tool call audit rows must not be updatable or deletable by authenticated callers';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'guard_ai_tool_call_audit_update'
      AND tgrelid = 'public.ai_tool_call_audit'::regclass
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'ai tool call audit immutability trigger is missing';
  END IF;

  -- The audit row stays account-scoped even on a write path that bypasses
  -- RLS, through the accounts foreign key.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_tool_call_audit_account_id_fkey'
      AND conrelid = 'public.ai_tool_call_audit'::regclass
  ) THEN
    RAISE EXCEPTION 'ai tool call audit account foreign key is missing';
  END IF;

  -- `analyze_images` records its vision-model spend in the same usage
  -- trail (migration 048). Verify the widened enum rather than assuming
  -- the migration applied: an unapplied DROP/ADD pair would reject every
  -- image-analysis usage row at INSERT time, silently losing cost
  -- visibility, because `logAiUsage` swallows write errors by design.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_usage_log_mode_check'
      AND conrelid = 'public.ai_usage_log'::regclass
      AND pg_get_constraintdef(oid) LIKE '%image_analysis%'
  ) THEN
    RAISE EXCEPTION
      'ai_usage_log.mode does not accept image_analysis - migration 048 did not apply';
  END IF;

  -- Objective 01: the historical case model (migration 049). The
  -- tables, the one-case-per-enquiry identity, and the account-scoped
  -- foreign keys are load-bearing; a typo in any of their names applies
  -- cleanly and guarantees nothing.
  IF to_regclass('public.historical_cases') IS NULL
     OR to_regclass('public.historical_case_facts') IS NULL
     OR to_regclass('public.historical_case_snapshots') IS NULL THEN
    RAISE EXCEPTION
      'historical case tables are missing - migration 049 did not apply';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'historical_cases_one_per_enquiry'
      AND conrelid = 'public.historical_cases'::regclass
      AND contype = 'u'
  ) THEN
    RAISE EXCEPTION
      'the one-case-per-enquiry constraint is missing - migration 049 did not apply';
  END IF;

  -- Every reference a case holds must be proven account-scoped inside the
  -- database, not only by an RLS policy that a service-role write bypasses.
  IF (
    SELECT COUNT(*) FROM pg_constraint
    WHERE conname IN (
      'historical_cases_enquiry_account_fk',
      'historical_cases_conversation_account_fk',
      'historical_cases_contact_account_fk'
    )
      AND conrelid = 'public.historical_cases'::regclass
  ) <> 3 THEN
    RAISE EXCEPTION
      'historical case account-scoped foreign keys are incomplete - migration 049 did not apply';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'historical_case_facts_case_account_fk'
      AND conrelid = 'public.historical_case_facts'::regclass
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'historical_case_snapshots_case_account_fk'
      AND conrelid = 'public.historical_case_snapshots'::regclass
  ) THEN
    RAISE EXCEPTION
      'historical case child account-scoped foreign keys are missing - migration 049 did not apply';
  END IF;

  IF (
    SELECT COUNT(*) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN (
        'historical_cases', 'historical_case_facts', 'historical_case_snapshots'
      )
      AND c.relrowsecurity
  ) <> 3 THEN
    RAISE EXCEPTION
      'RLS is not enabled on every historical case table - migration 049 did not apply';
  END IF;

  -- Learning data is customer content: member-only reads, and no
  -- authenticated write policy that could amend a finalized case.
  IF (
    SELECT COUNT(*) FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'historical_cases'
      AND policyname IN (
        'historical_cases_select', 'historical_cases_insert', 'historical_cases_update'
      )
  ) <> 3 THEN
    RAISE EXCEPTION
      'historical case RLS policies are incomplete - migration 049 did not apply';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('historical_cases', 'historical_case_facts', 'historical_case_snapshots')
      AND policyname IN (
        'historical_cases_delete', 'historical_case_facts_delete',
        'historical_case_snapshots_delete'
      )
  ) THEN
    RAISE EXCEPTION
      'historical case tables must have no authenticated DELETE policy - migration 049 did not apply';
  END IF;

  -- Identity immutability, frozen facts, and append-only snapshots are the
  -- guards that keep a case a record of a past event rather than a mutable
  -- document.
  IF (
    SELECT COUNT(*) FROM pg_trigger
    WHERE tgname IN (
      'guard_historical_case_write', 'guard_historical_case_fact_write',
      'guard_historical_case_snapshot_write'
    )
      AND NOT tgisinternal
  ) <> 3 THEN
    RAISE EXCEPTION
      'historical case immutability triggers are incomplete - migration 049 did not apply';
  END IF;

  IF to_regclass('public.idx_historical_cases_account_training') IS NULL
     OR to_regclass('public.idx_historical_cases_account_tier') IS NULL THEN
    RAISE EXCEPTION
      'historical case training/retrieval indexes are missing - migration 049 did not apply';
  END IF;

  -- The AI feedback-loop protection is a pure function, so it can be
  -- asserted without seeding data: a model must not be able to write its
  -- own price into the training truth, on any write path.
  IF public.historical_case_fact_kind('ai_suggested_amount') <> 'number'
     OR public.historical_case_fact_kind('crew_count') <> 'integer'
     OR public.historical_case_fact_kind('not_a_fact') IS NOT NULL THEN
    RAISE EXCEPTION
      'the historical case fact vocabulary is incorrect - migration 049 did not apply';
  END IF;

  IF public.historical_case_fact_shape_valid(
       'final_amount_collected', 'captured', NULL, 380, NULL, NULL, NULL, 'ai_suggested'
     )
     OR public.historical_case_fact_shape_valid(
       'customer_facing_quote_amount', 'captured', NULL, 380, NULL, NULL, NULL, 'ai_suggested'
     )
     OR public.historical_case_fact_shape_valid(
       'ai_suggested_amount', 'captured', NULL, 380, NULL, NULL, NULL, 'operator_entered'
     )
     OR public.historical_case_fact_shape_valid(
       'crew_count', 'captured', NULL, NULL, NULL, NULL, NULL, 'confirmed_outcome'
     )
     OR public.historical_case_fact_shape_valid(
       'postcode', 'captured', '01310-100', NULL, NULL, NULL, NULL, 'customer_stated'
     ) THEN
    RAISE EXCEPTION
      'the historical case fact shape validator is too permissive - migration 049 did not apply';
  END IF;

  -- And the accepted shapes stay accepted, so the validator is not simply
  -- rejecting everything.
  IF NOT public.historical_case_fact_shape_valid(
       'ai_suggested_amount', 'captured', NULL, 380, NULL, NULL, NULL, 'ai_suggested'
     )
     OR NOT public.historical_case_fact_shape_valid(
       'final_amount_collected', 'captured', NULL, 380, NULL, NULL, NULL, 'confirmed_outcome'
     )
     OR NOT public.historical_case_fact_shape_valid(
       'postcode', 'canonical', NULL, NULL, NULL, NULL, NULL, 'customer_stated'
     ) THEN
    RAISE EXCEPTION
      'the historical case fact shape validator rejects a legitimate fact - migration 049 did not apply';
  END IF;

  -- The evidence-tier check must never pass unconditionally. A case that
  -- does not exist cannot support any tier, and 'A' additionally requires
  -- a completed job with a confirmed final amount.
  IF public.historical_case_evidence_supports_tier(
       gen_random_uuid(), 'A'
     )
     OR public.historical_case_evidence_supports_tier(
       gen_random_uuid(), 'E'
     ) THEN
    RAISE EXCEPTION
      'the historical case evidence-tier check passes without evidence - migration 049 did not apply';
  END IF;

  -- Objective 02: the job outcome capture vocabulary (migration 050).
  -- The keys the completed-job and lost-business workflows write must
  -- exist, and the two new value kinds must be real rather than
  -- approximated by text.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'historical_case_facts'
      AND column_name = 'value_timestamp'
      AND data_type = 'timestamp with time zone'
  ) THEN
    RAISE EXCEPTION
      'historical_case_facts.value_timestamp is missing - migration 050 did not apply';
  END IF;

  IF public.historical_case_fact_kind('arrival_at') <> 'timestamp'
     OR public.historical_case_fact_kind('departed_at') <> 'timestamp'
     OR public.historical_case_fact_kind('scope_change_type') <> 'text'
     OR public.historical_case_fact_kind('final_operational_outcome') <> 'text'
     OR public.historical_case_fact_kind('actual_dismantling_required') <> 'boolean'
     OR public.historical_case_fact_kind('not_a_fact') IS NOT NULL THEN
    RAISE EXCEPTION
      'the outcome capture fact vocabulary is incorrect - migration 050 did not apply';
  END IF;

  -- The recorded timestamps are post-job facts, so they may carry
  -- confirmed_outcome; an operator judgement about the day may not.
  IF NOT public.historical_case_fact_shape_valid(
       'arrival_at', 'captured', NULL, NULL, NULL, NULL,
       '2026-03-01T09:00:00Z'::timestamptz, 'confirmed_outcome'
     )
     OR NOT public.historical_case_fact_shape_valid(
       'departed_at', 'captured', NULL, NULL, NULL, NULL,
       '2026-03-01T11:30:00Z'::timestamptz, 'confirmed_outcome'
     )
     OR public.historical_case_fact_shape_valid(
       'scope_change_type', 'captured', NULL, NULL, NULL, NULL, NULL,
       'confirmed_outcome'
     )
     OR public.historical_case_fact_shape_valid(
       'final_operational_outcome', 'captured', NULL, NULL, NULL, NULL, NULL,
       'confirmed_outcome'
     )
     OR public.historical_case_fact_shape_valid(
       'crew_count', 'captured', NULL, NULL, 2, NULL, NULL, 'confirmed_outcome'
     ) THEN
    RAISE EXCEPTION
      'the outcome capture provenance rules are wrong - migration 050 did not apply';
  END IF;

  -- The commercial-outcome vocabulary must keep an explicit price
  -- rejection, "found a better price", a no-response and a customer
  -- cancellation as four distinguishable facts, and must not accept a
  -- free-text decision. Silently dropping a value here is exactly the
  -- loss-of-distinction this migration exists to prevent.
  IF NOT public.historical_case_fact_shape_valid(
       'quote_decision', 'captured', 'no_response', NULL, NULL, NULL, NULL,
       'operator_entered'
     )
     OR NOT public.historical_case_fact_shape_valid(
       'quote_decision', 'captured', 'found_better_price', NULL, NULL, NULL,
       NULL, 'operator_entered'
     )
     OR public.historical_case_fact_shape_valid(
       'quote_decision', 'captured', 'perhaps too dear', NULL, NULL, NULL,
       NULL, 'operator_entered'
     )
     OR NOT public.historical_case_fact_shape_valid(
       'quote_decision', 'captured', 'rejected_price', NULL, NULL, NULL, NULL,
       'operator_entered'
     )
     OR NOT public.historical_case_fact_shape_valid(
       'quote_decision', 'captured', 'cancelled_by_customer', NULL, NULL,
       NULL, NULL, 'operator_entered'
     ) THEN
    RAISE EXCEPTION
      'the commercial outcome vocabulary is wrong - migration 050 did not apply';
  END IF;

  IF public.historical_case_fact_shape_valid(
       'final_operational_outcome', 'captured', 'sort_of_done', NULL, NULL,
       NULL, NULL, 'operator_entered'
     )
     OR public.historical_case_fact_shape_valid(
       'scope_change_type', 'captured', 'a bit harder', NULL, NULL, NULL,
       NULL, 'operator_entered'
     )
     OR NOT public.historical_case_fact_shape_valid(
       'scope_change_type', 'captured', 'access_harder_than_expected', NULL,
       NULL, NULL, NULL, 'operator_entered'
     ) THEN
    RAISE EXCEPTION
      'the outcome and scope-change vocabularies are wrong - migration 050 did not apply';
  END IF;

  -- A model still cannot describe what happened on the job, on any
  -- write path, including the keys added by this migration.
  IF public.historical_case_fact_shape_valid(
       'actual_load_units', 'captured', NULL, 1.5, NULL, NULL, NULL, 'ai_suggested'
     )
     OR public.historical_case_fact_shape_valid(
       'actual_disposal_weight_kg', 'captured', NULL, 420, NULL, NULL, NULL,
       'ai_suggested'
     )
     OR public.historical_case_fact_shape_valid(
       'arrival_at', 'captured', NULL, NULL, NULL, NULL,
       '2026-03-01T09:00:00Z'::timestamptz, 'ai_suggested'
     )
     OR public.historical_case_fact_shape_valid(
       'final_operational_outcome', 'captured', 'completed', NULL, NULL, NULL,
       NULL, 'ai_suggested'
     ) THEN
    RAISE EXCEPTION
      'the outcome capture AI feedback-loop guard is too permissive - migration 050 did not apply';
  END IF;

  -- A fractional load quantity and a measured weight are both
  -- legitimate, and neither may be smuggled in as a string.
  IF NOT public.historical_case_fact_shape_valid(
       'actual_load_units', 'captured', NULL, 0.5, NULL, NULL, NULL,
       'confirmed_outcome'
     )
     OR NOT public.historical_case_fact_shape_valid(
       'actual_disposal_weight_kg', 'captured', NULL, 187.5, NULL, NULL, NULL,
       'confirmed_outcome'
     )
     OR public.historical_case_fact_shape_valid(
       'actual_disposal_weight_kg', 'captured', NULL, NULL, NULL, NULL, NULL,
       'confirmed_outcome'
     ) THEN
    RAISE EXCEPTION
      'fractional load/weight capture is wrong - migration 050 did not apply';
  END IF;

  -- Derived labour duration. Deterministic, unknown-preserving, and
  -- never a number for an inverted or zero-length pair.
  IF public.historical_case_derive_labour_minutes(NULL, NULL) IS NOT NULL
     OR public.historical_case_derive_labour_minutes(
          '2026-03-01T09:00:00Z'::timestamptz, NULL
        ) IS NOT NULL
     OR public.historical_case_derive_labour_minutes(
          NULL, '2026-03-01T09:00:00Z'::timestamptz
        ) IS NOT NULL
     OR public.historical_case_derive_labour_minutes(
          '2026-03-01T10:00:00Z'::timestamptz, '2026-03-01T09:00:00Z'::timestamptz
        ) IS NOT NULL
     OR public.historical_case_derive_labour_minutes(
          '2026-03-01T09:00:00Z'::timestamptz, '2026-03-01T09:00:00Z'::timestamptz
        ) IS NOT NULL
     OR public.historical_case_derive_labour_minutes(
          '2026-03-01T09:00:00Z'::timestamptz, '2026-03-01T10:30:00Z'::timestamptz
        ) <> 90
     OR public.historical_case_derive_labour_minutes(
          '2026-03-01T08:15:00Z'::timestamptz, '2026-03-01T11:05:00Z'::timestamptz
        ) <> 170 THEN
    RAISE EXCEPTION
      'derived labour duration is wrong - migration 050 did not apply';
  END IF;

  -- Finalization needs a `correction` snapshot kind and exactly one
  -- frozen snapshot per kind, so a replayed finalize cannot leave two
  -- competing answers about what a training example was built from.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'historical_case_snapshots_kind_check'
      AND conrelid = 'public.historical_case_snapshots'::regclass
      AND pg_get_constraintdef(oid) LIKE '%correction%'
  ) THEN
    RAISE EXCEPTION
      'the correction snapshot kind is missing - migration 050 did not apply';
  END IF;

  IF to_regclass('public.idx_historical_case_snapshots_one_finalization') IS NULL
     OR to_regclass('public.idx_historical_case_facts_account_decision') IS NULL THEN
    RAISE EXCEPTION
      'outcome capture indexes are missing - migration 050 did not apply';
  END IF;

  -- The eight-argument shape validator is what the fact table's CHECK
  -- constraint actually calls. Assert the arity so a future migration
  -- cannot silently leave the constraint bound to a dropped overload.
  IF (
    SELECT COUNT(*) FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'historical_case_fact_shape_valid'
      AND p.pronargs = 8
  ) <> 1 THEN
    RAISE EXCEPTION
      'the historical case fact shape validator does not accept a timestamp - migration 050 did not apply';
  END IF;

-- Objective 03: the historical import identity spine (migration 051).
  IF to_regclass('public.historical_import_runs') IS NULL
     OR to_regclass('public.historical_case_sources') IS NULL THEN
    RAISE EXCEPTION
      'historical import tables are missing - migration 051 did not apply';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'historical_case_sources_one_record_one_case'
      AND conrelid = 'public.historical_case_sources'::regclass
  ) THEN
    RAISE EXCEPTION
      'the one-source-record-one-case uniqueness guard is missing - migration 051 did not apply';
  END IF;

  -- The dry-run promise is a CHECK, not a convention: if this
  -- constraint is absent, a dry run could record created cases and
  -- an operator reviewing it would be reviewing a lie.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'historical_import_runs_dry_run_no_writes'
      AND conrelid = 'public.historical_import_runs'::regclass
  ) THEN
    RAISE EXCEPTION
      'the dry-run no-writes constraint is missing - migration 051 did not apply';
  END IF;

  IF to_regclass('public.idx_historical_import_runs_account_started') IS NULL
     OR to_regclass('public.idx_historical_import_runs_account_dry_source') IS NULL
     OR to_regclass('public.idx_historical_case_sources_account_kind') IS NULL
     OR to_regclass('public.idx_historical_case_sources_account_run') IS NULL THEN
    RAISE EXCEPTION
      'historical import indexes are missing - migration 051 did not apply';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'guard_historical_case_source_write'
      AND tgrelid = 'public.historical_case_sources'::regclass
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'guard_historical_case_source_insert'
      AND tgrelid = 'public.historical_case_sources'::regclass
  ) THEN
    RAISE EXCEPTION
      'historical case source guards are incomplete - migration 051 did not apply';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'historical_import_runs'
      AND policyname IN (
        'historical_import_runs_select',
        'historical_import_runs_insert',
        'historical_import_runs_update'
      )
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'historical_case_sources'
      AND policyname IN (
        'historical_case_sources_select',
        'historical_case_sources_insert'
      )
  ) THEN
    RAISE EXCEPTION
      'historical import RLS policies are incomplete - migration 051 did not apply';
  END IF;

  -- Append-only: neither table may have an authenticated DELETE
  -- policy, and the source ledger may not have an UPDATE policy
  -- either, because its rows are immutable.
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename IN ('historical_import_runs', 'historical_case_sources')
      AND cmd = 'DELETE'
  ) THEN
    RAISE EXCEPTION
      'historical import tables must have no authenticated DELETE policy - migration 051 did not apply';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'historical_case_sources'
      AND cmd = 'UPDATE'
  ) THEN
    RAISE EXCEPTION
      'historical case sources must have no authenticated UPDATE policy - migration 051 did not apply';
  END IF;
  -- Migration 052: canonical quote revisions and append-only lifecycle audit.
  IF to_regclass('public.quotes') IS NULL
     OR to_regclass('public.quote_events') IS NULL THEN
    RAISE EXCEPTION 'quote lifecycle tables are missing - migration 052 did not apply';
  END IF;

  IF to_regclass('public.idx_quotes_one_current_per_enquiry') IS NULL
     OR to_regclass('public.idx_quotes_account_enquiry_revision') IS NULL
     OR to_regclass('public.idx_quotes_creation_idempotency') IS NULL
     OR to_regclass('public.idx_quotes_action_idempotency') IS NULL THEN
    RAISE EXCEPTION 'quote lifecycle uniqueness indexes are incomplete';
  END IF;

  IF (
    SELECT COUNT(*) FROM pg_constraint
    WHERE conrelid = 'public.quotes'::regclass
      AND conname IN (
        'quotes_enquiry_account_fk', 'quotes_supersedes_account_fk',
        'quotes_superseded_by_account_fk', 'quotes_recommendation_account_fk'
      )
  ) <> 4 THEN
    RAISE EXCEPTION 'quote account-scoped relationships are incomplete';
  END IF;

  IF (
    SELECT COUNT(*) FROM pg_constraint
    WHERE conrelid = 'public.quotes'::regclass
      AND conname IN (
        'quotes_amount_shape_check', 'quotes_decision_metadata_check',
        'quotes_imported_provenance_check', 'quotes_revision_parent_check'
      )
  ) <> 4 THEN
    RAISE EXCEPTION 'quote money, decision, provenance, or revision guards are incomplete';
  END IF;

  IF (
    SELECT COUNT(*) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN ('quotes', 'quote_events')
      AND c.relrowsecurity
  ) <> 2 THEN
    RAISE EXCEPTION 'RLS is not enabled on every quote table';
  END IF;

  IF (
    SELECT COUNT(*) FROM pg_policies
    WHERE schemaname = 'public'
      AND policyname IN (
        'quotes_select', 'quotes_insert', 'quotes_update', 'quote_events_select'
      )
  ) <> 4 THEN
    RAISE EXCEPTION 'quote RLS policies are incomplete';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('quotes', 'quote_events')
      AND cmd = 'DELETE'
  ) OR EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'quote_events'
      AND cmd IN ('INSERT', 'UPDATE')
  ) THEN
    RAISE EXCEPTION 'quote audit tables expose an unsafe write policy';
  END IF;

  IF (
    SELECT COUNT(*) FROM pg_trigger
    WHERE tgname IN (
      'guard_quote_write', 'audit_quote_transition', 'guard_quote_event_write'
    ) AND NOT tgisinternal
  ) <> 3 THEN
    RAISE EXCEPTION 'quote lifecycle/audit triggers are incomplete';
  END IF;

  IF NOT public.is_valid_quote_status_transition('draft', 'approved')
     OR NOT public.is_valid_quote_status_transition('approved', 'presented')
     OR public.is_valid_quote_status_transition('presented', 'approved')
     OR public.is_valid_quote_status_transition('superseded', 'draft') THEN
    RAISE EXCEPTION 'quote lifecycle transition vocabulary is incorrect';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'quotes'
      AND column_name = 'final_amount_collected'
  ) THEN
    RAISE EXCEPTION 'quotes must not duplicate final amount collected';
  END IF;

  -- ==========================================================
  -- Migration 053 - vector memory.
  --
  -- SHAPE only. `verify-vector-memory.sql` asserts the behaviour:
  -- the model registry rejecting an unregistered model, content-hash
  -- dedup, one current vector per case and kind, vector immutability,
  -- privacy propagation on exclusion, deletion cascade, and RLS.
  -- ==========================================================

  IF NOT EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'vector'
  ) THEN
    RAISE EXCEPTION 'the pgvector extension is not enabled';
  END IF;

  IF public.case_embedding_registered_model(
       'openai', 'text-embedding-3-small', 'text-embedding-3-small-1536-v1'
     ) IS DISTINCT FROM 1536 THEN
    RAISE EXCEPTION 'the registered vector model does not resolve to 1536 dimensions';
  END IF;

  IF public.case_embedding_registered_model(
       'openai', 'text-embedding-3-large', 'unregistered-v1'
     ) IS NOT NULL THEN
    RAISE EXCEPTION
      'an unregistered embedding model must not resolve to a dimension count';
  END IF;

  IF (
    SELECT COUNT(*) FROM pg_constraint
    WHERE conrelid = 'public.case_embeddings'::regclass
      AND conname IN (
        'case_embeddings_case_account_fk',
        'case_embeddings_superseded_by_account_fk',
        'case_embeddings_model_registered_check',
        'case_embeddings_content_hash_check',
        'case_embeddings_state_supersede_check',
        'case_embeddings_source_reference_check'
      )
  ) <> 6 THEN
    RAISE EXCEPTION 'vector memory integrity constraints are incomplete';
  END IF;

  -- The vector column must be the fixed 1536-dimension type the
  -- registered model produces, not an unbounded `vector`.
  IF (
    SELECT format_type(atttypid, atttypmod)
    FROM pg_attribute
    WHERE attrelid = 'public.case_embeddings'::regclass
      AND attname = 'vector'
      AND NOT attisdropped
  ) IS DISTINCT FROM 'vector(1536)' THEN
    RAISE EXCEPTION 'the vector column must be a fixed vector(1536)';
  END IF;

  -- Both idempotency indexes, and the cosine ANN index.
  IF (
    SELECT COUNT(*) FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname IN (
        'idx_case_embeddings_one_current',
        'idx_case_embeddings_identity_unique',
        'idx_case_embeddings_vector_hnsw'
      )
  ) <> 3 THEN
    RAISE EXCEPTION
      'vector memory idempotency or ANN indexes are missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname IN (
             'guard_case_embedding_write',
             'sync_case_embedding_eligibility'
           )
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'vector memory write or privacy-propagation triggers are missing';
  END IF;

  IF (
    SELECT COUNT(*) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'case_embeddings'
      AND c.relrowsecurity
  ) <> 1 THEN
    RAISE EXCEPTION 'RLS is not enabled on case_embeddings';
  END IF;

  IF (
    SELECT COUNT(*) FROM pg_policies
    WHERE schemaname = 'public'
      AND policyname IN (
             'case_embeddings_select', 'case_embeddings_insert',
             'case_embeddings_update'
           )
  ) <> 3 THEN
    RAISE EXCEPTION 'vector memory RLS policies are incomplete';
  END IF;

  -- Vectors are superseded, never deleted: a DELETE policy here would
  -- let a member destroy the reproducibility record of a past retrieval.
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'case_embeddings'
      AND cmd = 'DELETE'
  ) THEN
    RAISE EXCEPTION 'case_embeddings must not expose a DELETE policy';
  END IF;

  -- Embedding spend is recorded on the existing usage trail.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.ai_usage_log'::regclass
      AND conname = 'ai_usage_log_mode_check'
  ) THEN
    RAISE EXCEPTION 'the ai_usage_log mode constraint is missing';
  END IF;

  -- ==========================================================
  -- Migration 054 - canonical per-image observation persistence.
  --
  -- SHAPE only. `verify-image-observations.sql` asserts the BEHAVIOUR:
  -- request-identity idempotency, one current run per media set, the
  -- source-traceability guard re-deriving the object path, observation
  -- immutability, orphan pruning, privacy propagation on exclusion,
  -- deletion cascade, and tenant RLS.
  --
  -- The shape assertions here are nevertheless load-bearing: every DDL
  -- statement in the migration is IF NOT EXISTS-guarded, so a typo in an
  -- object name applies cleanly and guarantees nothing.
  -- ==========================================================

  IF to_regclass('public.image_analysis_runs') IS NULL
     OR to_regclass('public.image_analysis_run_images') IS NULL
     OR to_regclass('public.image_analysis_observations') IS NULL
     OR to_regclass('public.image_analysis_observation_sources') IS NULL THEN
    RAISE EXCEPTION
      'image observation tables are missing - migration 054 did not apply';
  END IF;

  -- Account-scoped composite foreign keys. These are what stop a
  -- service-role write - which bypasses RLS entirely - from attaching an
  -- analysis to another account's conversation or case.
  IF (
    SELECT COUNT(*) FROM pg_constraint
    WHERE conrelid = 'public.image_analysis_runs'::regclass
      AND conname IN (
        'image_analysis_runs_conversation_account_fk',
        'image_analysis_runs_enquiry_account_fk',
        'image_analysis_runs_case_account_fk',
        'image_analysis_runs_superseded_by_account_fk'
      )
  ) <> 4 THEN
    RAISE EXCEPTION
      'image analysis run account-scoped foreign keys are incomplete - migration 054 did not apply';
  END IF;

  IF (
    SELECT COUNT(*) FROM pg_constraint
    WHERE conname IN (
      'image_analysis_run_images_run_account_fk',
      'image_analysis_observations_run_account_fk',
      'image_analysis_observation_sources_observation_account_fk',
      'image_analysis_observation_sources_image_account_fk'
    )
  ) <> 4 THEN
    RAISE EXCEPTION
      'image observation child account-scoped foreign keys are incomplete - migration 054 did not apply';
  END IF;

  -- The uniqueness and identity constraints. Without these, the same
  -- immutable request could produce two canonical runs and a case could
  -- hold two live answers about the same photographs.
  IF (
    SELECT COUNT(*) FROM pg_constraint
    WHERE conrelid = 'public.image_analysis_runs'::regclass
      AND conname IN (
        'image_analysis_runs_success_shape_check',
        'image_analysis_runs_state_supersede_check',
        'image_analysis_runs_source_fingerprint_check',
        'image_analysis_runs_result_content_hash_check',
        'image_analysis_runs_analysis_schema_version_check',
        'image_analysis_runs_prompt_version_check'
      )
  ) <> 6 THEN
    RAISE EXCEPTION
      'image analysis run integrity constraints are incomplete - migration 054 did not apply';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.image_analysis_run_images'::regclass
      AND conname = 'image_analysis_run_images_source_media_is_object_path'
  ) THEN
    RAISE EXCEPTION
      'the media reference must be refused a URL, query or fragment - migration 054 did not apply';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.image_analysis_observations'::regclass
      AND conname = 'image_analysis_observations_projection_check'
  ) THEN
    RAISE EXCEPTION
      'the observation projection check is missing - migration 054 did not apply';
  END IF;

  -- Both idempotency indexes, plus the per-image and per-message reads.
  IF (
    SELECT COUNT(*) FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname IN (
        'idx_image_analysis_runs_request_identity',
        'idx_image_analysis_runs_one_current',
        'idx_image_analysis_run_images_source',
        'idx_image_analysis_observation_sources_image'
      )
  ) <> 4 THEN
    RAISE EXCEPTION
      'image observation idempotency or per-image indexes are missing';
  END IF;

  -- The write guards and the privacy-propagation trigger. Without these
  -- a privileged write could attribute an observation to a photograph it
  -- did not analyse, amend a validated observation in place, or leave an
  -- observation behind after its source photograph was deleted.
  IF (
    SELECT COUNT(*) FROM pg_trigger
    WHERE tgname IN (
             'guard_image_analysis_run_write',
             'guard_image_analysis_run_image_write',
             'guard_image_analysis_observation_write',
             'guard_image_analysis_observation_source_write',
             'prune_image_analysis_orphans',
             'sync_image_analysis_run_eligibility'
           )
      AND NOT tgisinternal
  ) <> 6 THEN
    RAISE EXCEPTION 'image observation write or privacy triggers are incomplete';
  END IF;

  IF (
    SELECT COUNT(*) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN (
        'image_analysis_runs',
        'image_analysis_run_images',
        'image_analysis_observations',
        'image_analysis_observation_sources'
      )
      AND c.relrowsecurity
  ) <> 4 THEN
    RAISE EXCEPTION
      'RLS is not enabled on every image observation table - migration 054 did not apply';
  END IF;

  IF (
    SELECT COUNT(*) FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename LIKE 'image_analysis%'
      AND policyname LIKE '%_select'
  ) <> 4 THEN
    RAISE EXCEPTION 'image observation SELECT policies are incomplete';
  END IF;

  -- Derived observations are removed only through a source/case/
  -- conversation/account cascade, never by an ordinary caller.
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename LIKE 'image_analysis%'
      AND cmd = 'DELETE'
  ) THEN
    RAISE EXCEPTION
      'image observation tables must not expose a DELETE policy';
  END IF;

  -- Price-leakage, structurally. The canonical record must never gain a
  -- monetary column; the observation payload is the validated contract,
  -- which has no price field and no exact weight field.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name LIKE 'image_analysis%'
      AND (
        column_name LIKE '%amount%'
        OR column_name LIKE '%price%'
        OR column_name LIKE '%cost%'
        OR column_name LIKE '%quote%'
        OR column_name LIKE '%revenue%'
        OR column_name LIKE '%paid%'
        OR column_name = 'weight'
        OR column_name LIKE '%weight%'
      )
  ) THEN
    RAISE EXCEPTION
      'image observation tables must not store any monetary or weight column';
  END IF;

  -- And there must be nowhere for RAW provider output to be written, even
  -- by accident. A column named for the provider response would be the
  -- obvious place for unvalidated model text to accumulate.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name LIKE 'image_analysis%'
      AND (
        column_name LIKE '%raw%'
        OR column_name LIKE '%response%'
        OR column_name LIKE '%provider_output%'
        OR column_name = 'choices'
      )
  ) THEN
    RAISE EXCEPTION
      'image observation tables must not store raw provider output';
  END IF;

  RAISE NOTICE 'schema verification passed';
END
$$;

-- Two things this file has already been burned by, both verified in CI
-- rather than assumed:
--
-- 1. It must contain EXACTLY ONE statement. `supabase db query --file`
--    sends the whole file as a prepared statement, and a second
--    top-level statement fails with the distinctly unhelpful "cannot
--    insert multiple commands into a prepared statement" (commit
--    f91a6c8). Add assertions INSIDE the DO block above; do not append
--    a second one.
--
-- 2. A RAISE in here really does fail the job. A deliberately false
--    assertion (commit 42c7db0, run 31579334056) surfaced as
--    `failed to execute query: error: ...` and exited 1. This is not a
--    decorative green tick.
