# WACRM — Testing & Verification Checklist

Every command and check below is defined by the repository. Nothing here
is invented. Verified locally on 2026-09-30 at commit `80c3f9a`.

## Dependency integrity

```bash
npm ci
```

Exits non-zero on a lockfile that does not satisfy `package.json`. This
is what CI runs.

The `overrides` block in `package.json` pins security floors for
transitive packages (`postcss`, `sharp`, `hono`, `js-yaml`, `nanoid`,
`brace-expansion`, and others). A Dependabot PR that removes or lowers
one of those entries is a security regression, not a routine bump.

## Type checking

```bash
npm run typecheck     # tsc --noEmit
```

Expected: exit 0, no output.

## Linting

```bash
npm run lint          # eslint
```

Expected: exit 0. Warnings do **not** fail the run — `eslint` is invoked
with no `--max-warnings`.

Baseline at `80c3f9a`: **41 warnings, 0 errors**. The working tree now
reports **40 warnings, 0 errors**; the difference comes from other
uncommitted work in the tree, and the historical-import files
themselves contribute zero. The warnings are
pre-existing `@next/next/no-img-element`,
`react-hooks/exhaustive-deps`, unused-variable and
`@next/next/no-location-assign-relative-destination` warnings across
components and `src/middleware.ts`. Treat that count as the baseline; a
rise means the change introduced something.

## Tests

```bash
npm test              # vitest run
npm run test:watch    # vitest
```

Scope: `src/**/*.test.ts`, `src/**/*.test.tsx`, `environment: "node"`.

Baseline at `80c3f9a`: **86 test files, 1001 tests — 999 pass, 2 fail**.

After the historical import work: **108 test files, 1452 tests — 1450
pass, 2 fail** (the same two i18n cases).

### Known pre-existing failure

`src/i18n/messages.test.ts` → *message catalogue parity* fails for two
cases:

- `pt.json covers every en.json key`
- `es.json covers every en.json key`

Both report the same six missing keys under `Contacts.importModal.*`:

```
Contacts.importModal.failedRowsHeading
Contacts.importModal.resultInvalidPhone
Contacts.importModal.resultInvalidPhone_plural
Contacts.importModal.toastInvalidPhone
Contacts.importModal.toastInvalidPhone_plural
Contacts.importModal.unknownReason
```

These arrived with the contacts-import-error-visibility work merged in
`80c3f9a` (PR #529) and were never translated. **This failure predates
any current work.** It is an i18n gap, not a regression from a code
change, and must not be worked around by weakening the parity test.
Fixing it means adding the six keys to `messages/pt.json` and
`messages/es.json`.

### Test harness notes

- `vitest.config.ts` injects `ENCRYPTION_KEY` and `META_APP_SECRET`.
  Both are read at **module load** by
  `src/lib/whatsapp/encryption.ts` and
  `src/lib/whatsapp/webhook-signature.ts`. A new module-level env read
  needs an entry in **both** `vitest.config.ts` and
  `.github/workflows/ci.yml`, or it will fail in CI only.
- Tests never reach a live Supabase or the real Graph API. Supabase is
  faked at the client boundary, Meta at `fetch`.
- `clearMocks: true` between tests.
- There is no jsdom environment and no component-rendering setup, so
  React component tests are out of scope with the current config.

## Build

```bash
npm run build         # next build
```

Expected: exit 0. Succeeds without real credentials — `next build` only
needs `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` to
be non-null.

At `80c3f9a` the build succeeds and emits the full App Router route
table plus the `ƒ Proxy (Middleware)` entry, with no errors. Source-tree
counts for reference after the historical import work: 59 `route.ts`
files under `src/app/api/` and 22 `page.tsx` files under `src/app/`.

`npm start` serves the production build afterwards.

## Formatting

```bash
npm run format:check   # prettier --check .
npm run format         # prettier --write .
```

Not part of CI. `prettier-plugin-tailwindcss` sorts utility classes, so
`format` can produce a large diff on a component that was hand-edited;
run it on the files you touched, or not at all.

## Database / migrations

Requires the Supabase CLI (CI pins `2.113.0`). Both commands are
destructive **to the local database only**.

```bash
supabase db reset --local --no-seed
supabase db query --local --file supabase/ci/verify-schema.sql
supabase db query --local --file supabase/ci/verify-outcome-capture.sql
supabase db query --local --file supabase/ci/verify-historical-import.sql
supabase db query --local --file supabase/ci/verify-quotes.sql
supabase db query --local --file supabase/ci/verify-vector-memory.sql
```

- `db reset` replays every migration in filename order against a fresh
  database. It fails on the first statement Postgres rejects.
- `verify-schema.sql` asserts the *shape* — that the migrations built the
  schema rather than silently no-opped, and that the pure vocabularies
  accept and reject the right values. Keep it thin.
- `verify-outcome-capture.sql` asserts the *behaviour* of the
  historical-case write guards: it builds a real case and a real
  completed job, proves a labour duration that contradicts its own
  timestamps is refused, that an AI suggestion cannot be written as a
  collected amount, that a finalized case is frozen, that the learning
  eligibility correction and its reversal are allowed, that a second
  snapshot of a finalization kind is refused, and that a case cannot be
  attached to another account's enquiry. It creates and then deletes
  everything it builds.
- `verify-historical-import.sql` asserts the *behaviour* of the import
  guards (migration 051): a dry run cannot record a created case, a run
  is finished exactly when it is not `running`, the summary and error
  metadata are bounded and correctly shaped, one source record cannot be
  attributed twice, the source ledger is append-only, a finalized case
  accepts no new imported source, an `imported_historical` collected
  amount still does not support tier A, and a member of another account
  can neither read nor write the import tables — that last one is
  checked by impersonating `authenticated`, because everything else in
  the file runs as the table owner whose writes bypass RLS. See
  [historical-import.md](historical-import.md).
- `verify-quotes.sql` asserts the *behaviour* of the canonical quote
  lifecycle (migration 052): the money shape, explicit status
  transitions, immutable revisions and events, idempotency, concurrency
  backstops, and tenant RLS. See [quote-domain.md](quote-domain.md).
- `verify-vector-memory.sql` asserts the *behaviour* of the vector store
  (migration 053): an unregistered embedding model is refused, a
  registered model with the wrong dimension count is refused,
  content-hash dedup makes generation idempotent, a case can hold only
  one current vector per kind, a stored content hash and vector value
  are immutable, a content change produces a new row and retires the
  old one rather than overwriting it, excluding a case withholds its
  vectors and a privileged write cannot reactivate them, re-including
  the case releases them again, deleting a case cascades them away,
  there is no monetary column, and there is no `DELETE` policy. Tenant
  isolation is checked by impersonating `authenticated`. See
  [vector-memory.md](vector-memory.md).
- `verify-image-observations.sql` asserts the *behaviour* of canonical
  image-analysis persistence (migration 054): source media must derive from
  the named message, incomplete runs cannot carry observations, model/schema/
  prompt revisions remain representable, observations are immutable, priced
  or weighed output is refused, exclusion withholds derived evidence, source
  deletion prunes orphaned observations, and tenant RLS holds.

All these files must contain **exactly one statement**: `supabase db query
--file` sends the whole file as a prepared statement. Add assertions
*inside* the `DO` block.

Run these after **any** change under `supabase/`. They are what
`.github/workflows/migrations.yml` runs on a `supabase/**` path change.

`supabase/config.toml` pins `[db] major_version = 17`. Do not change it
without matching the hosted project's Postgres version — a mismatch lets
CI green-light SQL production would reject.

## Integration checks

There are **no** automated integration tests against a live Supabase
project or the real Meta Graph API. Manual verification requires a
configured operator account and is out of scope for CI.

The MCP `dbx` server can inspect a configured database interactively;
the `hindsight` remote bank provides durable project memory. Neither is
part of the automated check set.

## Pre-flight checklist for a pull request

- [ ] `npm run typecheck` — exit 0
- [ ] `npm run lint` — exit 0, warning count not above the 41 baseline
- [ ] `npm test` — no failure beyond the two known i18n parity cases
- [ ] `npm run build` — exit 0
- [ ] If `supabase/**` changed:
      `supabase db reset --local --no-seed`, then
      `supabase db query --local --file supabase/ci/verify-schema.sql`,
      **and** `--file supabase/ci/verify-outcome-capture.sql`,
      **and** `--file supabase/ci/verify-historical-import.sql`,
      **and** `--file supabase/ci/verify-quotes.sql`,
      **and** `--file supabase/ci/verify-vector-memory.sql`,
      **and** `--file supabase/ci/verify-image-observations.sql`
- [ ] No `.env` value, token, key or `fbtrace_id`-bearing payload added
      to any file, log line, or commit message
- [ ] No application behaviour changed to make an unrelated pre-existing
      failure pass
- [ ] `AGENTS.md` §11 reporting items satisfied: files changed, files
      created, migrations added, checks run, verification result,
      unresolved issues

## Security review triggers

Use the `vibe-security` skill, and treat the change as fail-closed
preserving, when work touches any of:

authentication · authorization · Supabase · Postgres RLS ·
service-role access · tenant/account isolation · Meta/WhatsApp ·
webhooks · webhook signatures · access tokens · encryption/decryption ·
secrets · public API endpoints · external integrations · file/media access

The invariants to preserve are tabulated in
[`development-workflow.md`](./development-workflow.md#security-sensitive-areas).
