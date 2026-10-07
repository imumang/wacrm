# WACRM — Development Workflow

Repository-specific, derived from `package.json`, the CI workflows,
`supabase/`, `opencode.jsonc` and the installed tooling.
`AGENTS.md` is the governing workflow/safety file; this document does not
repeat it.

## Prerequisites

| Requirement | Version | Source |
| --- | --- | --- |
| Node.js | `>=20` | `package.json` `engines` |
| npm | `10.9.9` (`packageManager`) | `package.json` |
| Supabase CLI | `2.113.0` (CI-pinned) | `.github/workflows/migrations.yml` |
| Docker | optional, container path only | `docs/docker.md` |

Local Docker is required only for the container workflow. Nothing else
in the repo needs a container.

## Setup

```bash
npm ci                    # lockfile-exact install (matches CI)
cp .env.local.example .env.local
# fill in NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
# SUPABASE_SERVICE_ROLE_KEY, ENCRYPTION_KEY, META_APP_SECRET
npm run dev
```

`ENCRYPTION_KEY` must be a 64-hex-character string (32 bytes for
AES-256-GCM):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

It is read at **module load** by `src/lib/whatsapp/encryption.ts`, so
changing it requires a restart, and rotating it orphans every stored
token.

`NEXT_PUBLIC_*` variables are inlined into the client bundle at build
time. Changing one requires a rebuild, not just a restart.

`.env.local` is gitignored. Never print, commit, or document its
contents.

## Commands

Only these are defined by the repository.

| Command | What it runs |
| --- | --- |
| `npm run dev` | `next dev` |
| `npm run build` | `next build` |
| `npm start` | `next start` |
| `npm run lint` | `eslint` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test` | `vitest run` |
| `npm run test:watch` | `vitest` |
| `npm run format` | `prettier --write .` |
| `npm run format:check` | `prettier --check .` |

Build succeeds without real credentials: CI supplies placeholder values
for the four env vars read at build time, and `next build` only needs
the Supabase URL / anon key to be non-null.

## Database / migrations

### Applying to a real project

```bash
supabase link --project-ref <ref>
supabase db push
```

`supabase/config.toml` exists **only** so the CLI recognises the
directory for CI; it deliberately does not mirror the hosted project's
auth / storage / SMTP settings. The one value that must stay in sync is
`[db] major_version = 17` — a mismatch lets CI green-light SQL that
production would reject.

### Local replay

```bash
supabase db reset --local --no-seed
```

Replays every migration from nothing in filename order. `db start` is not
enough: it is a no-op against an existing volume.

### Verifying a migration actually did something

Every DDL statement is `IF NOT EXISTS`-guarded, so a typo'd object name
applies cleanly and does nothing. Assert the outcome:

```bash
supabase db query --local --file supabase/ci/verify-schema.sql
```

When adding a migration, add a corresponding assertion to
`supabase/ci/verify-schema.sql` if the object is load-bearing. Keep that
file thin — it is a smoke test, not a second copy of the schema.

### Migration conventions observed in this repo

- One file per concern, `NNN_short_snake_case_description.sql`, numbering
  continuing from the current maximum (042).
- Header comment stating **why** the migration exists, with the issue
  number when there is one.
- Explicitly **idempotent**: `IF NOT EXISTS`, `DROP ... IF EXISTS`,
  and for `CREATE POLICY` a preceding `DO` loop that drops the policy by
  name.
- Destructive data migrations re-point child rows to the survivor before
  deleting (022, 036) rather than dropping them.
- New tenant columns are added nullable, backfilled, then `SET NOT NULL`.
- SECURITY DEFINER functions set `search_path` explicitly and are
  `REVOKE`d from `PUBLIC` / `anon` / `authenticated` before the narrow
  `GRANT`.

## Testing workflow

Vitest with `environment: 'node'`, including
`src/**/*.test.ts` and `src/**/*.test.tsx`.

- `vitest.config.ts` injects dummy `ENCRYPTION_KEY` and `META_APP_SECRET`
  values read at module load by `encryption.ts` and
  `webhook-signature.ts`. **Any new module that reads an env var at
  module load needs a matching entry here and in `.github/workflows/ci.yml`,
  or the suite will fail in CI only.**
- No DOM environment is configured, so tests exercise pure logic and
  fetch-mocked transports, not rendered components. React component
  testing would need setup work that does not exist.
- Supabase and Meta are always faked at the client / `fetch` boundary.
  There are **no** integration tests against a live database or the real
  Graph API.
- `clearMocks: true`.

Where to put a test: next to the module as `<module>.test.ts`. The
WhatsApp library follows this strictly — `src/lib/whatsapp/` holds 48
modules, 26 of them paired tests. Route-handler logic is tested through
its extracted library rather than by mounting the handler — e.g.
`src/app/api/whatsapp/webhook/route.test.ts` drives `processWebhook`
internals directly.

## CI

Two workflows, both on `main`:

**`.github/workflows/ci.yml`** — on every PR and push to `main`:
install → `npm run lint` → `npm run typecheck` → `npm test` →
`npm run build`, on Node 20, with four placeholder env vars.

**`.github/workflows/migrations.yml`** — path-filtered on `supabase/**`:
install Supabase CLI 2.113.0 → `supabase db start` →
`supabase db reset --local --no-seed` → `supabase db query --local
--file supabase/ci/verify-schema.sql`.

The migrations workflow is intentionally **not** a required status check,
because GitHub leaves a required check that never ran stuck as
"expected" and blocks every PR that does not touch SQL.

## Safe modification workflow

1. `git status` — know what is already uncommitted before touching
   anything.
2. Read the relevant code and its paired test.
3. For framework behaviour, read the installed docs under
   `node_modules/next/dist/docs/`. The installed version is Next.js
   16.3.5, where `middleware.ts` is deprecated in favour of `proxy.ts`
   and other conventions have moved; do not rely on remembered behaviour.
4. Make the smallest change that fixes the problem.
5. Run the smallest relevant check first (a single test file), then
   `npm run typecheck` and `npm run lint`, then `npm test` if the change
   is broad.
6. For anything touching auth, RLS, tenancy, the WhatsApp webhook,
   tokens or encryption: read the relevant migration and the security
   boundaries section of `docs/database-architecture.md` first.
7. Update the durable doc for the area you changed — `AGENTS.md` §10 asks
   for this and `AGENTS.md` itself should not absorb architecture detail.

## Security-sensitive areas

Treat any change here as fail-closed-preserving and verify the failure
paths explicitly.

| Area | Files / objects | Invariant to preserve |
| --- | --- | --- |
| Webhook signature | `src/lib/whatsapp/webhook-signature.ts` | Rejects when `META_APP_SECRET` is unset; constant-time comparison; accepts a comma-separated secret list |
| Token encryption | `src/lib/whatsapp/encryption.ts` | GCM auth tag verified; CBC read-only; legacy upgrade is idempotent |
| Tenancy | `supabase/migrations/017_account_sharing.sql`, every `account_id` query | Every read/write filtered by `account_id`; `user_id` is audit, not isolation |
| RLS | all `*_select/insert/update/delete` policies | viewer reads, agent writes operational, admin writes settings-class |
| Service-role usage | `src/lib/flows/admin-client.ts`, the two lazy factories in the WhatsApp routes, `src/lib/api-keys/store.ts` | Keep the RLS-bypassing surface small, explicit, and account-scoped in its queries |
| Role gates | `src/lib/auth/account.ts`, `src/lib/auth/roles.ts` | `requireRole()` before any external side effect — RLS cannot unsend a WhatsApp message |
| Cron endpoints | `src/app/api/{automations,flows}/cron/route.ts` | Return 503 until `AUTOMATION_CRON_SECRET` is set; verify `x-cron-secret` |
| Service-role RPCs | `bump_conversation_on_inbound`, `create_broadcast_with_recipients` | Granted to `service_role` only |
| Profile privilege columns | `enforce_profile_privilege_columns()` (034) | A member cannot change their own `account_id` / `account_role` |
| Storage paths | `chat-media`, `flow-media` | First path segment must be `account-<id>` for a member's account |
| Public API auth | `src/lib/api-keys/store.ts`, `scopes.ts` | Key looked up by SHA-256 hash only; revoked / expired rejected |
| Invite links | `src/lib/auth/invitations.ts`, `account_invitations` | Only `token_hash` persisted; plaintext returned once; `ALLOWED_INVITE_HOSTS` honoured |

## Tools

### OpenCode / MCP configuration

`opencode.jsonc` at the repo root defines four servers:

| Server | Transport | Purpose |
| --- | --- | --- |
| `code-review-graph` | local (`uvx code-review-graph serve --repo …`) | Knowledge-graph build, communities, flows, impact analysis, hub/bridge nodes |
| `graphify` | local (`graphify-mcp.exe --graph D:\Development\wacrm\graphify-out\graph.json`) | Query / traverse the persisted graph at that exact path |
| `hindsight` | remote (`http://localhost:8888/mcp/wacrm/`) | Durable project memory |
| `dbx` | local | Database inspection |

`.opencode/` also exists locally and is untracked.

**Graph location:** `graphify-out/graph.json` (root marker
`.graphify_root`, incremental manifest `manifest.json`). Regenerate with
the `graphify` CLI (`/graphify`). The directory is untracked — do not
commit it unless that is intended.

`code-review-graph` maintains its **own** SQLite store separate from
`graphify-out/`. After `uvx code-review-graph serve` it can report 0
nodes until a build is run; build it before relying on its statistics.

### Serena

Use for symbol-aware navigation, caller/reference lookup, and tracing an
implementation before editing.

### vibe-security

The `vibe-security` skill is available to OpenCode (it is listed in the
session's available skills). Use it for design, implementation, or review
of authentication, authorization, Supabase/RLS, tenancy isolation,
Meta/WhatsApp, webhooks, tokens, encryption, secrets, public endpoints
and file/media access. Do not run broad security refactors unless asked,
and never weaken a control to make local development easier.

### Hindsight

The remote bank is scoped per-project at `/mcp/wacrm/`. Store durable,
verified knowledge only: architecture decisions, repository paths,
security boundaries, verified commands, conventions, graph path, known
technical risks. Never store tokens, passwords, secrets, private keys,
`.env` contents, debugging output, or speculative conclusions.
