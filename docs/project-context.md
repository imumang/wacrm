# WACRM — Project Context

Derived from the codebase, migrations, tests and configuration as of
commit `80c3f9a` (2026-09-30). Companion documents:

- [`docs/database-architecture.md`](./database-architecture.md)
- [`docs/whatsapp-architecture.md`](./whatsapp-architecture.md)
- [`docs/development-workflow.md`](./development-workflow.md)
- [`docs/testing-checklist.md`](./testing-checklist.md)
- [`docs/ai-provider-architecture.md`](./ai-provider-architecture.md)
- [`docs/ai-tool-layer.md`](./ai-tool-layer.md)
- [`docs/image-analysis.md`](./image-analysis.md)
- [`docs/historical-cases.md`](./historical-cases.md),
  [`docs/job-outcome-capture.md`](./job-outcome-capture.md),
  [`docs/historical-import.md`](./historical-import.md) — the AI learning
  foundation (roadmap objectives 01–03)

`AGENTS.md` is the governing workflow/safety file. This document records
**verified current behaviour** only; it does not restate `AGENTS.md`.

## Purpose

A self-hostable CRM template built around the **official WhatsApp Business
Cloud API**. It provides a shared inbox, contacts with tags and custom
fields, sales pipelines, template broadcasts, no-code automations and
flows, an optional bring-your-own-key AI reply assistant, and a public
REST API with scoped API keys. Operators fork it and host it themselves;
there is no vendor tenancy beyond the operator's own Supabase project.

## Technology stack

| Layer         | Technology                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------ |
| App framework | Next.js 16.3.5 (App Router), React 19.2.4, TypeScript 6                                    |
| Styling       | Tailwind CSS v4, shadcn/ui on `@base-ui/react`, `tailwind-merge`                           |
| i18n          | `next-intl` 4.x — catalogues in `messages/{en,ko,pt,es}.json`                              |
| Charts        | `recharts` 3.x; flow builder on `@xyflow/react` 12.x                                       |
| Data          | Supabase (Postgres + Auth + Storage + RLS) via `@supabase/ssr` and `@supabase/supabase-js` |
| Messaging     | Meta WhatsApp Cloud API (Graph API `v21.0`)                                                |
| AI (optional) | OpenAI / Anthropic, bring-your-own-key per account                                         |
| Audio capture | `opus-recorder` (inbox voice notes)                                                        |
| Tests         | Vitest 4 (`vitest run`)                                                                    |
| Lint/format   | ESLint 9 (`eslint-config-next` 16.3.5), Prettier 3                                         |
| Node          | `>=20`, package manager `npm@10.9.9`                                                       |

The lockfile is `package-lock.json`; installs are `npm ci`.

## Major directories

```
src/
  app/
    (auth)/            login, signup, forgot-password
    (dashboard)/       inbox, contacts, pipelines, broadcasts, automations,
                       flows, dashboard, agents, notifications, settings
    api/               route handlers (see "API surface")
    join/[token]       account invitation acceptance
  components/          feature-scoped UI (inbox, contacts, settings, flows, …)
  hooks/               use-auth, use-total-unread, use-browser-notifications
  i18n/                request.ts locale resolution + catalogue parity test
  lib/
    account/           member listing
    ai/                providers, config, knowledge, auto-reply, usage
    ai/image-analysis/ Objective 08: limits, controlled media retrieval,
                       provider-neutral analyzer, production vision adapter
                       (OpenAI/Anthropic, reusing the account's own AI key),
                       observation schema — see image-analysis.md
    ai/tools/          provider-neutral business tools (get_customer,
                       get_conversation, analyze_images) —
                       see ai-tool-layer.md
    api/v1/            public-API data access
    api-keys/          keys.ts, scopes.ts, store.ts (service-role read path)
    auth/              account.ts (context), roles.ts, api-context.ts, invitations.ts
    automations/       engine
    contacts/          dedupe
    conversations/     reopen
    flows/             engine, admin-client (service-role), templates
    inbox/             UI data helpers
    media/             filename/MIME helpers
    notifications/     dispatch
    storage/           upload-media
    supabase/          client.ts (browser), server.ts (SSR, cookies)
    webhooks/          deliver.ts (public API fan-out)
    whatsapp/          the Meta integration — see whatsapp-architecture.md
  types/               shared TypeScript domain types
messages/              en, ko, pt, es catalogues
supabase/
  config.toml          project id + db port/major version for the CLI
  migrations/          001 … 042, applied in filename order
  ci/verify-schema.sql post-migration assertions run in CI
mcp-server/            separate npm package: MCP server for Claude/Cursor etc.
docs/                  this file and its companions
```

`mcp-server/` has its own `package.json` and is not part of the root
`npm ci` workspace.

## Frontend / backend architecture

- **Server/client split.** `src/app/**/page.tsx` are server components;
  anything under `src/components/**` is a client component. The
  convention is that data reading happens server-side and interactive
  behaviour lives in client components that call the API routes.
- **API surface.** All mutations go through route handlers under
  `src/app/api/`. There are no server actions in the current tree.
- **Supabase clients.**
  - `src/lib/supabase/client.ts` — browser client (anon key).
  - `src/lib/supabase/server.ts` — SSR client reading/writing cookies
    (anon key, RLS-scoped to the session).
  - Service-role clients are created ad hoc where needed. Three distinct
    constructions exist:
    `src/lib/flows/admin-client.ts` (`supabaseAdmin()`),
    and lazy module-level factories inside
    `src/app/api/whatsapp/webhook/route.ts` and
    `src/app/api/whatsapp/config/route.ts`.
- **Public API.** `/api/v1/*` authenticates with a hashed API key
  (`src/lib/api-keys/store.ts`, service-role read) instead of a Supabase
  session, because `auth.uid()` is absent. See `docs/public-api.md`.

## Auth model

- **Supabase Auth** (email/password) supplies the session.
- `src/middleware.ts` runs before every matched request. It calls
  `supabase.auth.getUser()`, which also refreshes an expired access token
  and **rotates the refresh token**. Because `setAll()` writes onto a
  fresh `NextResponse`, every redirect/JSON branch must copy those
  refreshed cookies onto the response it returns — the file does this via
  `withRefreshedCookies()` (issue #288).
- The middleware gates: redirect signed-in users away from
  `/login`, `/signup`, `/forgot-password`; redirect anonymous users off
  `/dashboard`, `/inbox`, `/contacts`, `/pipelines`, `/broadcasts`,
  `/automations`, `/settings`; and return 401 for unauthenticated
  `/api/whatsapp/*` **except** `/api/whatsapp/webhook` (Meta has no
  session — it is authenticated by HMAC signature instead).
- **Middleware is not authorization.** RLS and `requireRole()` are the
  real gates. The middleware list is a UX redirect layer.
- Server-side context: `src/lib/auth/account.ts`
  - `getCurrentAccount()` → `{ supabase, userId, accountId, role, account }`
  - `requireRole(min)` → same, or throws `ForbiddenError`
  - `toErrorResponse(err)` maps `UnauthorizedError`→401,
    `ForbiddenError`→403, anything else→a generic 500 that never leaks
    `err.message`.

### Next.js 16 note

The installed Next.js 16.3.5 has **deprecated** `middleware.ts` and
renamed the convention to `proxy.ts`; the build output labels the entry
`ƒ Proxy (Middleware)` and it still works, but
`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/middleware.md`
states the convention is deprecated and that
`npx @next/codemod@canary middleware-to-proxy .` migrates it. Only one
file is supported per project. This is a known, non-blocking migration
item — see "Existing issues and risks".

## Tenancy / account model

- Every domain table carries `account_id` (migration `017`). `account_id`
  is the tenancy key; `user_id` is retained as an audit/assignment FK to
  `auth.users` and is **not** consulted for isolation.
- One account per user is enforced by the unique index
  `idx_accounts_one_per_owner ON accounts(owner_user_id)` — a user belongs
  to exactly one account.
- `profiles.account_role` holds the membership role (no separate
  membership table), matching the one-account-per-user design.
- Roles, `src/lib/auth/roles.ts` (mirrors the `account_role_enum`
  Postgres type):

  | Role     | Rank | Capability predicates                                 |
  | -------- | ---- | ----------------------------------------------------- |
  | `owner`  | 4    | all, incl. `canDeleteAccount`, `canTransferOwnership` |
  | `admin`  | 3    | `canManageMembers`, `canEditSettings`                 |
  | `agent`  | 2    | `canSendMessages`                                     |
  | `viewer` | 1    | `canViewOnly` (read-only)                             |

  The TS `roleRank` ordinals deliberately mirror the `CASE` expression
  inside the SQL `is_account_member()` helper so both layers speak the
  same language.

- Invitations: `POST /api/account/invitations` creates a link; only a
  SHA-256 `token_hash` is persisted, and the plaintext is returned once.
  `peek_invitation` / `redeem_invitation` RPCs (migration 019) run the
  acceptance transaction.

## Major subsystems

| Subsystem        | Entry points                                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Shared inbox     | `src/app/(dashboard)/inbox`, `src/components/inbox/*`, `src/lib/inbox/*`                                                |
| Contacts         | `src/app/(dashboard)/contacts`, `src/lib/contacts/dedupe.ts`                                                            |
| Conversations    | `src/lib/conversations/reopen.ts`                                                                                       |
| WhatsApp         | `src/app/api/whatsapp/*`, `src/lib/whatsapp/*` (largest subsystem)                                                      |
| Broadcasts       | `src/app/api/whatsapp/broadcast`, `src/lib/whatsapp/broadcast-core.ts`, `broadcast-resume.ts`, `src/lib/broadcast-*.ts` |
| Automations      | `src/lib/automations/engine.ts`, `src/app/api/automations/{engine,cron}`                                                |
| Flows            | `src/lib/flows/engine.ts`, `src/app/api/flows/{cron,[id]/activate,[id]/runs}`                                           |
| Pipelines        | `src/app/(dashboard)/pipelines`, `src/components/pipelines/*`                                                           |
| Agents / members | `src/app/(dashboard)/agents`, `src/lib/account/members.ts`, `src/lib/presence.ts`, `src/lib/auth/invitations.ts`        |
| AI assistant     | `src/lib/ai/{config,providers,knowledge,auto-reply,draft,usage}`, `src/app/api/ai/*`, `docs/ai-provider-architecture.md`  |
| AI tool layer    | `src/lib/ai/tools/{contract,get-customer,get-conversation,analyze-images,index}`, `docs/ai-tool-layer.md`               |
| Image analysis   | `src/lib/ai/image-analysis/*`, `docs/image-analysis.md`                                                                 |
| Learning cases   | `src/lib/historical-cases/*`, `src/lib/enquiries/*`, `src/app/api/historical-cases/*`, migrations 045–050                 |
| Historical import | `src/lib/historical-import/*`, `src/app/api/historical-import`, migration 051, `docs/historical-import.md`               |
| Knowledge base   | `src/lib/ai/knowledge.ts`, `src/app/api/ai/knowledge/*`                                                                 |
| Notifications    | `src/lib/notifications`, `src/app/(dashboard)/notifications`, migration 027                                             |
| Public webhooks  | `src/lib/webhooks/deliver.ts`, `src/app/api/v1/webhooks`                                                                |
| Public REST API  | `src/app/api/v1/*`, `src/lib/api/v1/*`                                                                                  |
| Quick replies    | `src/app/api/quick-replies`, migration 035                                                                              |
| i18n             | `src/i18n/request.ts`, `messages/*.json`                                                                                |

### Fan-out ordering inside the inbound webhook

`src/app/api/whatsapp/webhook/route.ts` → `processMessage()` runs, in
order: contact/conversation find-or-create → reaction short-circuit →
content parse → **idempotent message insert** → unread bump + reopen →
broadcast-reply flag → flow dispatch → automation triggers → AI
auto-reply → public `message.received` webhook. Everything after the
insert is skipped on a replayed delivery (issue #367).

## External integrations

- **Meta WhatsApp Cloud API** — the only first-party external service.
  Webhooks inbound; sends, templates, media upload and registration
  outbound. Documented in
  [`docs/whatsapp-architecture.md`](./whatsapp-architecture.md).
- **OpenAI / Anthropic** — optional per-account AI keys, AES-256-GCM
  encrypted at rest like the WhatsApp token. No global provider key env
  var.
- **Supabase** — Auth, Postgres, Storage (`chat-media`, `flow-media`,
  avatars). Storage is used so Meta can fetch outbound media URLs without
  credentials.

## Local runtime

1. `npm install`
2. `cp .env.local.example .env.local`, fill Supabase + Meta credentials
   (`ENCRYPTION_KEY` must be 64 hex chars).
3. Apply migrations with the Supabase CLI (`supabase db push` against the
   linked project, or `supabase db reset --local` for a throwaway local
   Postgres — see `docs/development-workflow.md`).
4. `npm run dev` → <http://localhost:3000>, redirected to `/login`.

`docker compose --env-file .env.local up --build -d` is the container
path (`docs/docker.md`); the container runs **no** migrations and **no**
scheduler. Automation `Wait` steps and flow timers need an external
scheduler hitting `GET /api/automations/cron` and `GET /api/flows/cron`
with `x-cron-secret`.

## Important entry points

| Purpose                              | File                                            |
| ------------------------------------ | ----------------------------------------------- |
| Request interception / auth redirect | `src/middleware.ts`                             |
| Account + role context               | `src/lib/auth/account.ts`                       |
| Role predicates                      | `src/lib/auth/roles.ts`                         |
| Rate limiting                        | `src/lib/rate-limit.ts`                         |
| Meta webhook (GET verify + POST)     | `src/app/api/whatsapp/webhook/route.ts`         |
| Meta Graph API helpers               | `src/lib/whatsapp/meta-api.ts`                  |
| Token encryption                     | `src/lib/whatsapp/encryption.ts`                |
| Webhook HMAC verification            | `src/lib/whatsapp/webhook-signature.ts`         |
| Outbound send core                   | `src/lib/whatsapp/send-message.ts`              |
| WhatsApp settings UI                 | `src/components/settings/whatsapp-config.tsx`   |
| Inbound sender identity              | `src/lib/whatsapp/wa-identity.ts`               |
| Error mapping for API routes         | `src/lib/auth/account.ts` → `toErrorResponse()` |

## Code graph

- Path: `graphify-out/graph.json` (root marker `graphify-out/.graphify_root`
  = `D:\Development\wacrm`; manifest `graphify-out/manifest.json`;
  analysis `graphify-out/.graphify_analysis.json`).
- MCP servers configured in `opencode.jsonc`: `graphify` (points at that
  exact file) and `code-review-graph` (`uvx code-review-graph serve --repo
D:\Development\wacrm`, which keeps its own SQLite store and currently
  reports 0 nodes until built).
- Refresh with the `graphify` CLI (`/graphify`) or the `graphify-out/`
  incremental update flow. The directory is untracked in git — do not
  commit it unless that is explicitly intended.
