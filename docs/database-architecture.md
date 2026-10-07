# WACRM — Database / Supabase Architecture

Derived from `supabase/migrations/001…054`, `supabase/config.toml`,
`supabase/ci/verify-schema.sql` and the application read/write paths.
Current shape as of commit `80c3f9a`.

Migrations are applied in **filename order** and are individually
idempotent (`IF NOT EXISTS` / `DROP ... IF EXISTS`), so a replay is safe.

## Tables

### Tenancy / identity

| Table | Migration | Purpose |
| --- | --- | --- |
| `profiles` | 001 (+011, 017, 034) | One row per `auth.users`. Carries `full_name`, `email`, `avatar_url`, legacy `role` (unused), plus `account_id` and `account_role` (017). |
| `accounts` | 017 | Tenant root. `id`, `name`, `owner_user_id` (RESTRICT), timestamps. Unique index `idx_accounts_one_per_owner` on `owner_user_id` enforces one account per user. |
| `account_invitations` | 017 | Invite links. Stores `token_hash` (SHA-256), `role` (CHECK `role <> 'owner'`), `expires_at`, `accepted_at`/`accepted_by_user_id`. |

### CRM core

| Table | Migration | Notes |
| --- | --- | --- |
| `contacts` | 001 (+022, 040) | `phone` NOT NULL, generated `phone_normalized`, unique index on `(account_id, phone_normalized) WHERE phone_normalized <> ''` (022). 040 adds `wa_user_id`, `wa_parent_user_id`, `wa_username` with a partial unique index `(account_id, wa_user_id) WHERE wa_user_id IS NOT NULL`. |
| `tags`, `contact_tags` | 001 | Many-to-many, `UNIQUE(contact_id, tag_id)`. |
| `custom_fields`, `contact_custom_values` | 001 | `UNIQUE(contact_id, custom_field_id)`. |
| `contact_notes` | 001 | |
| `conversations` | 001 (+036) | `status` CHECK `open/pending/closed`, `assigned_agent_id`, `unread_count`, `last_message_text/at`. 036 adds the dedupe guarantee one conversation per `(account_id, contact_id)`. |
| `messages` | 001 (+009, 010, 035, 037, 039, 042) | `sender_type` CHECK `customer/agent/bot`; `content_type` CHECK widened by 010 to include `interactive`; `status` CHECK `sending/sent/delivered/read/failed`. 010 adds `interactive_reply_id` + `interactive_payload`; 009 adds `reply_to_message_id`; 039 adds `media_type`; 042 adds `error_code`/`error_title`/`error_details`. 037 adds the unique index `idx_messages_conversation_message_id (conversation_id, message_id)` — the inbound idempotency boundary. |
| `message_reactions` | 009 | Per-`(message, actor_type, actor_id)` upsert target; customer reactions never touch `messages`. |
| `quick_replies` | 035 | Saved canned replies. |

### WhatsApp

| Table | Migration | Notes |
| --- | --- | --- |
| `whatsapp_config` | 001 (+013, 015, 017, 039) | The single most important table for the Meta integration. |
| `message_templates` | 001 (+014, 017) | Stores Meta's status enum verbatim (APPROVED/PENDING/REJECTED/PAUSED/DISABLED/IN_APPEAL/PENDING_DELETION) plus `meta_template_id`, `quality_score`, and parsed components. |

`whatsapp_config` columns and where they come from:

| Column | Origin | Notes |
| --- | --- | --- |
| `id` | 001 | UUID PK |
| `user_id` | 001 | Audit FK to `auth.users`; the member who saved the config. Not the tenancy key. |
| `account_id` | 017 | **Tenancy key.** NOT NULL after the 017 backfill. `UNIQUE (account_id)` — one WhatsApp number per account. |
| `phone_number_id` | 001 | TEXT. Globally unique via `whatsapp_config_phone_number_id_key` (013). |
| `waba_id` | 001 | TEXT, nullable. Legacy rows from before it was required may have NULL. |
| `access_token` | 001 | AES-256-GCM ciphertext (`iv:ct:authTag`). |
| `verify_token` | 001 | AES-256-GCM ciphertext, nullable. Legacy CBC rows auto-upgrade on a successful `GET /webhook` verify. |
| `status` | 001 | CHECK `connected` / `disconnected`. |
| `connected_at` | 001 | |
| `registered_at` | 015 | Non-null ⟺ `POST /{phone_number_id}/register` last succeeded. |
| `subscribed_apps_at` | 015 | Non-null ⟺ `POST /{waba_id}/subscribed_apps` last succeeded. |
| `last_registration_error` | 015 | Human-readable failure text from `/register`. |
| `mirror_inbound_media` | 039 | `NOT NULL DEFAULT TRUE`. Per-account opt-out for copying inbound attachments into Storage. |

There is **no** column for a Meta business id, a system-user id, a token
expiry, a token type, a phone-number status, a coexistence/opt-in flag,
`smb_message_echoes`, or an onboarding state. See "WhatsApp-related
security boundaries" and the risk section of
[`whatsapp-architecture.md`](./whatsapp-architecture.md).

### Broadcasts / pipelines

| Table | Migration | Notes |
| --- | --- | --- |
| `pipelines`, `pipeline_stages`, `deals` | 001 (+002) | Kanban. Deals link to `conversations`. |
| `broadcasts` | 001 (+005) | Aggregate `sent_count`/`delivered_count`/`read_count`/`failed_count`/`replied_count` maintained by trigger, never by the app. |
| `broadcast_recipients` | 001 (+003, 005) | `whatsapp_message_id` (003) is the join key the webhook's status handler matches on. Per-row `sent_at`/`delivered_at`/`read_at`/`replied_at`/`error_message`. |

### Automations / flows

| Table | Migration |
| --- | --- |
| `automations`, `automation_steps`, `automation_logs`, `automation_pending_executions` | 006 |
| `flows`, `flow_nodes`, `flow_runs`, `flow_run_events` | 010 (+016 for flow-media) |

`flow_runs` carries the partial unique index
`idx_one_active_run_per_contact ON flow_runs(account_id, contact_id)
WHERE status = 'active'` (017) — "at most one active run per contact per
account".

### Integrations / platform

| Table | Migration | Notes |
| --- | --- | --- |
| `webhook_endpoints` | 028 | Outbound subscriber endpoints; secrets encrypted with the same `encrypt()`/`decrypt()` as `whatsapp_config.access_token`. |
| `api_keys` | 026 | SHA-256 `key_hash`; `scopes TEXT[]`; `expires_at`, `revoked_at`. Read with the service-role client (`src/lib/api-keys/store.ts`). |
| `member_presence` | 024 | |
| `notifications` | 027 | Populated by `notify_conversation_assigned()`. |
| `ai_configs` | 029 (+031) | Per-account AI provider key, encrypted; reply-slot counters. |
| `ai_knowledge_documents`, `ai_knowledge_chunks` | 030 (+032) | Postgres FTS, optional pgvector semantic search. |
| `ai_usage_log` | 033 | |
| `ai_tool_call_audit` | 047 | Append-only AI business-tool trail. Execution metadata only, never tool input/output or customer content. |

### Learning foundation

| Table | Migration | Notes |
| --- | --- | --- |
| `enquiries`, `enquiry_state_events` | 045 (+046) | Durable job state inside a conversation. `enquiry_state_events` is trigger-written and append-only. |
| `historical_cases` | 049 | One learning-facing case per enquiry (`UNIQUE (enquiry_id)`). References the enquiry, conversation and contact by composite `(id, account_id)` FKs; carries the evidence tier, the operator-owned learning eligibility, and `finalized_at`. See [historical-cases.md](historical-cases.md). |
| `historical_case_facts` | 049 (+050) | One row per `(case_id, fact_key)` against a closed key vocabulary, each with its own `provenance`. Provenance cannot be `ai_suggested` on an outcome, human-quote or decision key. 050 adds the capture keys and a guard that a recorded `actual_labour_minutes` equals the duration derived from the case's own timestamps. |
| `historical_case_snapshots` | 049 (+050) | Append-only, payload-bounded learning truth. Immutability trigger blocks UPDATE and any DELETE while the owning case exists. 050 adds the `correction` kind and a partial unique index making one frozen snapshot per finalization kind. |
| `historical_case_facts.value_timestamp` | 050 | `TIMESTAMPTZ` value column, so on-site arrival/departure are provenance-carrying facts rather than a duplicated column on the frozen case row. |
| `historical_import_runs` | 051 | One row per import attempt: source type, status, `dry_run`, the written counters, a bounded 8 KB `summary` and a bounded `error_metadata` list. A CHECK constraint makes "a dry run creates nothing" unrepresentable. See [historical-import.md](historical-import.md). |
| `historical_case_sources` | 051 | The durable source-identity ledger: one row per (source record, case), naming `source_kind`, `source_record_id`, `source_system`, an optional `source_version`, the source's own timestamp, the import run, and an `import_quality` verdict. `UNIQUE (account_id, source_kind, source_record_id)` is the database half of import idempotency. Append-only, and a finalized case accepts no new source row. |
| `quotes` | 052 | Canonical immutable commercial-proposal revisions. Fixed/range money uses integer minor units; origin, human approval, presentation, customer decision and recommendation override remain distinct. No final-collected amount exists here. |
| `quote_events` | 052 | Trigger-written, append-only lifecycle audit containing actor/state/decision/idempotency metadata, not customer or message content. |
| `case_embeddings` | 053 | Versioned text/image-derived case vectors with model/dimension validation, content-hash idempotency, one current row per case and embedding kind, and no monetary fields. See [vector-memory.md](vector-memory.md). |
| `image_analysis_runs`, `image_analysis_run_images` | 054 | Immutable, model/schema/prompt-versioned image-analysis executions and their validated source-message media links. |
| `image_analysis_observations`, `image_analysis_observation_sources` | 054 | Canonical structured observations and many-to-many source links. Database guards reject price/weight outputs and prevent observations from becoming independent quote truth. |

## Relationships

```
auth.users ──1:1── profiles ──N:1── accounts ──1:1 (owner_user_id, unique)
                        │
                        └── account_role (enum) — the only membership record

accounts ──1:N── contacts ──1:1 (per account) ── conversations ──1:N── messages
                        │                              │                    │
                        ├── contact_tags → tags        │                    ├── message_reactions
                        ├── contact_custom_values     │                    ├── reply_to_message_id (self)
                        │   → custom_fields            │                    └── media_url → chat-media
                        └── contact_notes              └── interactive_reply_id / interactive_payload

accounts ──1:1── whatsapp_config        (UNIQUE(account_id))
accounts ──1:1── ai_configs             (settings-class, same RLS shape)

broadcasts ──1:N── broadcast_recipients ──N:1── contacts
                                        └── whatsapp_message_id ← webhook status match

accounts ──1:N── automations ──1:N── automation_steps / automation_logs
accounts ──1:N── flows ──1:N── flow_nodes
                  flows ──1:N── flow_runs ──1:N── flow_run_events

enquiries ──1:1── historical_cases ──1:n── historical_case_facts
                        │              └──1:n── historical_case_snapshots
                        │              └──1:n── historical_case_sources
                        └── references conversations / contacts (account-scoped FKs, no copies)

historical_import_runs ──1:n── historical_case_sources
                        (a source row may also predate any run)

enquiries ──1:n── quotes ──1:n── quote_events
                  ├── supersedes / superseded_by (revision chain)
                  └── recommendation_quote_id (AI/hybrid comparison)

historical_cases ──1:n── case_embeddings
                 └──1:n── image_analysis_runs ──1:n── image_analysis_observations
                                      └──1:n── image_analysis_run_images
image_analysis_observations ──1:n── image_analysis_observation_sources
```

Every child table cascades from its tenant parent
(`ON DELETE CASCADE`), so deleting an account removes its whole subtree
(migration 019 asserts this in a guard).

## Migrations

54 files, `001_initial_schema.sql` … `054_image_analysis_observations.sql`,
applied in filename order. Notable groups:

- **001** — the whole original schema: every table, its 001-era
  `auth.uid() = user_id` RLS policies, `update_updated_at_column()`,
  `handle_new_user()`, and the `set_updated_at` triggers.
- **002–016** — feature work (pipelines, broadcast wamids and aggregate
  triggers, automations, flows, avatars bucket, message actions, template
  Meta integration, **015** registration timestamps).
- **017** — the tenancy pivot: `account_role_enum`, `accounts`,
  `account_invitations`, `is_account_member()`, `account_id` on all 15
  parent tables, a load-bearing backfill in a `DO` block, `SET NOT NULL`,
  `account_id` indexes, `UNIQUE(account_id)` on `whatsapp_config`, the
  `flow_runs` index swap, and the full RLS rewrite.
- **018–021** — member/invitation RPCs, sharing follow-ups, default
  currency.
- **022–026** — contact phone dedupe, `chat-media` bucket, presence,
  tag filtering RPC, API keys.
- **027–035** — notifications, webhook endpoints, AI reply + knowledge,
  interactive messages.
- **036–044** — the reliability/identity tail: conversation dedupe (036),
  inbound idempotency + atomic counters (037), broadcast resume (038),
  inbound media mirror (039), BSUID identity (040), broadcast RPC fix
  (041), message failure reasons (042), and the forward removal (044) of
  the retired schema introduced by 043.
- **045–051** — the AI learning foundation: enquiries and their
  append-only state history (045, 046), AI tool-call audit (047),
  image-analysis usage mode (048), the historical case model (049), the
  job outcome capture vocabulary and guards (050), and the historical
  import identity spine — import runs and the source ledger (051).
- **052** — canonical quote revisions, lifecycle/customer-decision separation,
  append-only audit events, atomic revision RPC, minor-unit money, RLS and
  historical-case compatibility.
- **053** — versioned vector-memory persistence, model/dimension validation,
  content-hash idempotency, current-row selection, exclusion propagation and RLS.
- **054** — canonical per-image analysis runs, source-message media identity,
  immutable structured observations, price/weight rejection and RLS.

### Migration workflow

- The `supabase/` CLI project exists **only** so CI can boot a throwaway
  Postgres (`supabase/config.toml` says so explicitly). It is not a
  mirror of the hosted project's settings.
- `supabase/ci/verify-schema.sql` asserts the *outcome* of a replay
  (tables exist, buckets created, `idx_contacts_account_wa_user_id`
  present, the 041 `RETURNING` form installed) because every DDL is
  `IF NOT EXISTS`-guarded and a typo would otherwise be a silent no-op.
- `supabase/ci/verify-outcome-capture.sql` asserts the *behaviour* of the
  050 guards against a real case it builds and then deletes: a labour
  duration contradicting its own timestamps is refused, an AI suggestion
  cannot be written as a collected amount, a finalized case is frozen, the
  eligibility correction and its reversal are allowed, a second snapshot of
  a finalization kind is refused, and a case cannot be attached to another
  account's enquiry.
- `supabase/ci/verify-historical-import.sql` asserts the *behaviour* of
  the 051 guards the same way: a dry run cannot record a created case,
  a run is finished exactly when it is not `running`, the summary and
  error metadata are bounded and correctly shaped, one source record
  cannot be attributed twice, the source ledger is append-only, a
  finalized case accepts no new imported source, an
  `imported_historical` collected amount still does not support tier A,
  and — impersonating a member of another account as `authenticated`
  rather than as the table owner — neither table can be read or written
  across the tenant boundary.
- CI (`.github/workflows/migrations.yml`) runs `supabase db reset --local
  --no-seed`, then `supabase db query --local --file` against both
  verification files, pinned to Supabase CLI 2.113.0.
  `config.toml` pins `major_version = 17` to match the hosted project so
  CI cannot green-light SQL production would reject.

## RLS

RLS is enabled on every domain table. Two generations:

**001-era policies** — `USING (auth.uid() = user_id)` on
profiles/contacts/tags/custom_fields/contact_notes/conversations/
message_templates/pipelines/…, plus a `Service role can insert messages`
policy on `messages`. These were **dropped** by 017.

**017 rewrite** — every policy replaced with an `is_account_member()`
membership check in three tiers:

- `viewer` → `SELECT`
- `agent+` → `INSERT` / `UPDATE` / `DELETE` on operational tables
  (`contacts`, `conversations`, `contact_notes`, and the operational
  settings tables)
- `admin+` → `INSERT` / `UPDATE` / `DELETE` on **settings-class** tables

Settings-class tables (admin+ to write):
`whatsapp_config`, `message_templates`, `pipelines`, `tags`,
`custom_fields`, `webhook_endpoints`, `ai_configs`, `ai_knowledge_documents`.

```sql
-- supabase/migrations/017_account_sharing.sql
CREATE POLICY whatsapp_config_select ON whatsapp_config FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY whatsapp_config_insert ON whatsapp_config FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY whatsapp_config_update ON whatsapp_config FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
CREATE POLICY whatsapp_config_delete ON whatsapp_config FOR DELETE
  USING (is_account_member(account_id, 'admin'));
```

`is_account_member(target_account_id UUID, min_role account_role_enum
DEFAULT 'viewer')` is `LANGUAGE sql`, `STABLE`, **`SECURITY DEFINER`**,
`SET search_path = public`, owned by `postgres`, granted to
`authenticated` and `service_role`. `SECURITY DEFINER` is what lets a
policy body read `profiles` without recursive RLS evaluation. Its internal
`CASE` ordinals are the SQL twin of `roleRank()` in
`src/lib/auth/roles.ts`.

The rewrite is re-runnable: 017 first drops every policy on the 26 tables
it owns (via a `DO` loop over `pg_policies`) so a second run does not hit
42710 "policy already exists". No later migration adds policies to those
tables.

Post-017 policy hardenings:

- **034** — `public.enforce_profile_privilege_columns()`, a trigger that
  blocks a member from changing their own `account_id` / `account_role`,
  closing the privilege-escalation path through `profiles_update`.
- **020** — account-scoped Storage policies for the `flow-media` and
  `chat-media` buckets; writes are allowed only when the object path's
  **first segment** is `account-<account_id>` for an account the caller
  belongs to. Reads are public so Meta can fetch outbound media URLs.
  (039 relies on the same first-segment rule for the
  `chat-media/inbound/...` mirror path.)
- **051** — `historical_import_runs` and `historical_case_sources` write
  policies are **admin+**, not the `agent+` the rest of the learning
  tables use. A bulk import decides what an account's training set will
  contain, so the role that can do that is deliberately the narrowest
  one that can still do the job. Neither table has an authenticated
  UPDATE policy on the source ledger (rows are immutable) and neither
  has an authenticated DELETE policy: an import run and its ledger are
  an audit trail, removed only by the account cascade.

## Database functions

| Function | Migration | Notes |
| --- | --- | --- |
| `update_updated_at_column()` | 001 | Trigger fn for `set_updated_at`. |
| `handle_new_user()` | 001, **replaced by 017** | Post-017 it creates a personal account **and** stamps `owner` atomically on `auth.users` insert. |
| `is_account_member(uuid, account_role_enum)` | 017 | `SECURITY DEFINER` membership predicate (above). |
| `set_member_role`, `remove_account_member`, `transfer_account_ownership` | 018 | Member management RPCs. |
| `peek_invitation`, `redeem_invitation` | 019 | Invite acceptance; `redeem_invitation` guards against an account that already owns a `whatsapp_config`. |
| `merge_duplicate_contacts()` | 022 | One-time, re-runnable merge that re-points every child row at the survivor before deleting the duplicate. `SECURITY DEFINER`. |
| `merge_duplicate_conversations()` | 036 | Same pattern for conversations. |
| `filter_contacts_by_tags(...)` | 025 | Tag-filtered contact search. |
| `touch_presence(...)` | 024 | |
| `broadcast_recipient_aggregate_trigger()`, `_bcast_bump`, `_bcast_cols_for_status`, `recompute_broadcast_counts` | 003, 005 | Own every `broadcasts.*_count`. |
| `create_broadcast_with_recipients(...)` | 037 → 038 → **041** | Atomic parent + recipients in one transaction. 041 fixes an ambiguous bare `RETURNING id, contact_id` (SQLSTATE 42702) that a plain replay cannot catch, because plpgsql resolves names at execution time. |
| `bump_conversation_on_inbound(uuid, text)` | 037 | Atomic unread increment + last-message refresh in one UPDATE. **`REVOKE`d from `PUBLIC`, `anon`, `authenticated`; granted only to `service_role`.** |
| `increment_automation_execution_count` / `increment_flow_execution_count` | 007, 012 | Same anti-lost-update pattern. |
| `record_webhook_failure(...)` | 028 | |
| `claim_ai_reply_slot(...)` | 029 | |
| `match_ai_knowledge_fts` / `match_ai_knowledge_semantic` | 030, 032 | |
| `notify_conversation_assigned()` | 027 | |
| `enforce_profile_privilege_columns()` | 034 | |
| `historical_case_fact_kind(text)`, `historical_case_confirmed_outcome_key(text)`, `historical_case_human_quote_key(text)` | 049, widened 050 | The closed fact vocabulary. Pure, `IMMUTABLE`, `REVOKE`d from `PUBLIC`. |
| `historical_case_fact_shape_valid(...)` | 049, **8-arg** in 050 | Value-shape + provenance compatibility, called from the fact table's CHECK constraint. The 7-arg overload was dropped when the timestamp parameter was added. |
| `historical_case_derive_labour_minutes(timestamptz, timestamptz)` | 050 | Pure truncation-towards-zero derivation. `NULL` for an incomplete or non-positive pair. Mirrored by `deriveLabourMinutes` in TypeScript. |
| `historical_case_evidence_supports_tier(uuid, text)` | 049, **replaced by 050** | `SECURITY DEFINER`, re-reads the case's own facts so a service-role write cannot claim an unearned tier. |
| `historical_case_evidence_reasons_valid(text[])` | 049 | Bounded, null-free reason list. |

## Triggers

- `set_updated_at` — `BEFORE UPDATE` on every table with an
  `updated_at` (installed in 001, re-installed for `accounts` in 017).
- `guard_historical_case_write`, `guard_historical_case_fact_write`,
  `guard_historical_case_snapshot_write` — `BEFORE` write guards from 049,
  re-installed by 050. The fact guard additionally re-derives
  `actual_labour_minutes` from the case's own timestamps on every write; the
  case guard leaves a finalized case's three learning-eligibility columns
  writable, which is the one correction a frozen case accepts.
- `guard_historical_case_source_write`,
  `guard_historical_case_source_insert` — from 051. The first makes the
  source ledger append-only while its case exists; the second refuses a
  source row on a finalized case, so new imported evidence can never
  attach itself to frozen learning truth.
- `guard_quote_write`, `audit_quote_transition`,
  `guard_quote_event_write` — immutable terms, explicit lifecycle/decision
  transitions, actor attribution and append-only quote history (052).
- `broadcast_recipient_aggregate_trigger` — `AFTER INSERT/UPDATE/DELETE`
  on `broadcast_recipients` (005). The application **must not** write
  `broadcasts.sent_count` etc.
- `enforce_profile_privilege_columns` — `BEFORE UPDATE` on `profiles`
  (034).
- `handle_new_user` — `AFTER INSERT` on `auth.users`.

## Storage

| Bucket | Migration | Public | Size cap | Notes |
| --- | --- | --- | --- | --- |
| `flow-media` | 016 (+020 for account-scoped RLS) | yes | 16 MB | Flow-builder assets, path `account-<id>/…`. |
| `chat-media` | 023 (+039 widens the MIME list) | yes | 16 MB | Composer attachments (`account-<id>/…`) **and** the inbound mirror (`account-<id>/inbound/…`). |
| avatars | 008 | — | — | Profile avatars. |

`chat-media`'s allow-list was widened by 039 with inbound-only types
(animated GIF, bare Opus, QuickTime video, `video/3gp`) — the bucket's
allow-list is enforced by Storage even for the service role, so without
it an inbound GIF would be rejected and fall back to the expiring proxy
URL.

## WhatsApp-related security boundaries

1. **Encryption key scope.** `ENCRYPTION_KEY` is a single deployment-wide
   64-hex-char (32-byte) AES-256-GCM key. Rotating it orphans every
   stored token (`whatsapp_config.access_token`, `verify_token`,
   `webhook_endpoints.*`, `ai_configs.*`) — users must re-save.
2. **Fail-closed decrypt.** `decrypt()` throws on an unrecognised format
   or a wrong IV/auth-tag length. Callers surface `token_corrupted` and
   ask the operator to re-save rather than silently sending nothing.
3. **Service-role is the webhook's only path.** `bump_conversation_on_inbound`
   and `create_broadcast_with_recipients` are `service_role`-only; the
   webhook holds no user session, so every contact/conversation/message
   row it writes is stamped with `config.account_id` and
   `config.user_id` explicitly.
4. **`UNIQUE (account_id)` on `whatsapp_config`.** One number per
   account, and `UNIQUE (phone_number_id)` globally (013). `POST
   /api/whatsapp/config` additionally refuses (409) a `phone_number_id`
   already claimed by a *different* account, checked with the service
   role because the caller's own session cannot see other accounts' rows.
5. **Webhook HMAC.** `verifyMetaWebhookSignature()` rejects when
   `META_APP_SECRET` is unset — fail-closed, and it accepts a
   comma-separated list of secrets (500) so one deployment can serve
   WABAs under several Meta Apps. Comparisons are `timingSafeEqual`.
6. **Config update is admin+ only.** A `viewer` or `agent` cannot write
   `whatsapp_config`, so the media-mirror toggle (which writes straight
   to the row) is gated on `canEditSettings`.
7. **Media proxy is authenticated.** `GET /api/whatsapp/media/[mediaId]`
   requires a session, resolves the caller's `account_id`, and uses that
   account's token — it does not accept an arbitrary token.

## Known schema-level risks

- `profiles.role TEXT` is legacy and unused (017 explicitly leaves it
  for a later cleanup).
- The 001 "Service role can insert messages" policy on `messages` is
  `WITH CHECK (true)`, i.e. any role that can reach the insert path may
  insert. In practice PostgREST applies it alongside the
  conversation-membership select policy; it was written before 017 and is
  worth re-examining deliberately.
- `whatsapp_config` is one-row-per-account **and** globally unique on
  `phone_number_id`. Any design that needs more than one number per
  account, or a shared number across accounts, requires changing both
  constraints — this is the single schema constraint most relevant to
  future WhatsApp coexistence work.
