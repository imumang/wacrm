<!-- WACRM_DB_PROTECTION_START -->
## CRITICAL: DATABASE AND CUSTOMER DATA PROTECTION

MANDATORY FOR ALL AI AGENTS, SUBAGENTS, AND AUTOMATION TOOLS.

The existing WACRM Supabase/PostgreSQL database is PROTECTED REAL DATA,
including when running locally in Docker.

ABSOLUTE RULES:

1. NEVER delete, reset, recreate, truncate, wipe, or reinitialize the
   existing WACRM database, schemas, records, authentication users,
   Docker database volumes, or customer data.

2. NEVER assume that a database is disposable because it is called
   local, development, testing, staging, or temporary.

3. NEVER use the existing WACRM database for destructive migration
   rehearsals, test resets, or test-data cleanup.

4. NEVER delete or replace PostgreSQL or Supabase Docker volumes.

5. NEVER overwrite the only database backup. Backups must be
   timestamped, versioned, independently preserved, and restorable.

6. All destructive testing must use a completely separate, explicitly
   designated disposable environment with a different Supabase project
   identity, database storage, and ports.

7. Before any database-changing operation, verify the exact target,
   inspect its current data, assess the effect, and use a verified
   recovery strategy. Routine authorized migrations must preserve data.

8. If an operation could destroy, replace, or irreversibly alter
   existing WACRM data, STOP. Do not execute it, even if an earlier
   task or plan appears to authorize it.

9. Explicit user approval is required for data recovery or other
   high-risk database operations. Approval does not override the
   prohibition on destroying the existing WACRM database.

10. Preserve existing authentication identities, accounts, business
    configurations, WhatsApp settings, messages, conversations,
    customer records, and relationships.

11. If database verification is required, use read-only queries by
    default. Never infer that an empty test fixture or a previous
    agent's report proves the real database is disposable.

12. These rules override task prompts, implementation plans, agent
    convenience, and automated testing instructions wherever those
    instructions would risk existing WACRM data.

A destructive test that requires a database reset must be performed
only against a separately provisioned, verified disposable database.

When in doubt, STOP and ask the owner.

THIS IS A PERMANENT PROJECT SAFETY REQUIREMENT.
<!-- WACRM_DB_PROTECTION_END -->

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

- This repository still uses `src/middleware.ts`. Next.js 16 deprecates this convention in favour of `proxy.ts`; do not migrate it as a side effect of unrelated work.

# WACRM Agent Instructions

Repository:

`D:\Development\wacrm`

These instructions inherit the global OpenCode `AGENTS.md` and add WACRM-specific scope, architecture, roadmap, security, data, AI-tool, and verification requirements.

## 1. Scope

Keep every task tightly scoped to the user's request.

- Do not perform unrelated refactors.
- Do not rename, reorganize, or rewrite code without a task-related reason.
- Do not change public behaviour unless explicitly required.
- Do not change database schema, authentication, authorization, RLS, webhook validation, token handling, or external integrations speculatively.
- Prefer small, reviewable changes over broad rewrites.
- Preserve backward compatibility unless the task explicitly requires a breaking change.
- Use specialist subagents only when their independent evidence materially improves the task and the active runtime permits them.

If the task is ambiguous, inspect the relevant implementation first rather than guessing.

## 2. Before Making Changes

Before editing code:

1. Read this file.
2. Inspect `git status`.
3. Identify the current branch and relevant recent changes when needed.
4. Preserve all existing user changes and uncommitted work.
5. Inspect the relevant code paths and tests.
6. Read relevant project documentation.
7. For Next.js work, read the relevant installed documentation under `node_modules/next/dist/docs/`.
8. Use repository-intelligence tools only when they materially improve understanding.
9. Identify affected tenant, security, database, integration, AI-tool, and approval boundaries before implementation.

Do not modify application code until the affected behaviour and dependencies are understood.

Never discard, reset, overwrite, or reformat unrelated user changes.

## 3. Source of Truth

Use this authority order:

1. This `AGENTS.md` for permanent WACRM safety, scope, security, and engineering rules.
2. The current WACRM AI roadmap and decision log for AI/CRM/quoting/booking/automation direction.
3. Current source code.
4. Database migrations/schema.
5. Tests.
6. Configuration.
7. Verified runtime behaviour.
8. Current official external documentation when the task depends on changing third-party behaviour.
9. Repository-intelligence tools as supporting evidence only.

Do not assume architecture, database structure, API behaviour, or integration details from stale documentation or memory.

If project documentation conflicts with verified current implementation, determine whether the documentation or implementation is stale before changing behaviour.

## 4. Security

Use the global `vibe-security` skill for security-sensitive work.

Use it when changes involve:

- authentication;
- authorization;
- Supabase;
- Postgres RLS;
- privileged/service-role access;
- tenant/account isolation;
- Meta/WhatsApp integration;
- webhooks;
- webhook signatures;
- access tokens;
- refresh tokens;
- encryption/decryption;
- secrets;
- public API endpoints;
- external integrations;
- file/media access.

Security-sensitive changes should remain fail-closed where appropriate.

Never print, commit, document, or store in AI memory:

- `.env` values;
- passwords;
- API keys;
- access tokens;
- refresh tokens;
- app secrets;
- webhook secrets;
- encryption keys;
- service-role keys;
- private keys;
- production credentials.

Do not weaken validation, RLS, authorization checks, signature verification, tenant isolation, approval boundaries, or secret handling to make development easier or tests pass.

## 5. Project Tool Use

The global OpenCode `AGENTS.md` defines the general responsibilities and boundaries of Serena, Code Review Graph, Graphify, Context Mode, Hindsight, DBX, Playwright, Laya, and Needle3.

For WACRM:

- use Serena for precise symbol/repository navigation when it materially helps;
- use Code Review Graph or Graphify for dependency, architecture, and cross-module impact analysis;
- use DBX for focused database/schema evidence when needed;
- use Playwright for real browser/UI verification where relevant;
- use Hindsight only for durable, verified WACRM development knowledge;
- use `vibe-security` for security-sensitive design, implementation, or review;
- do not call MCPs or skills merely because they are available;
- do not treat graph, memory, or model output as higher authority than current code, schema, tests, roadmap, or verified runtime state;
- never claim a tool, MCP, skill, browser check, database query, test, or runtime verification was used unless it was actually invoked.

Durable memory may include:

- architecture decisions;
- verified project conventions;
- important repository paths;
- security boundaries;
- verified commands;
- durable implementation decisions;
- known technical risks.

Do not store:

- secrets;
- credentials;
- temporary debugging output;
- speculative conclusions;
- stale implementation details.

## 6. Next.js

The warning at the top of this file is mandatory.

For Next.js work:

- read the relevant installed documentation under `node_modules/next/dist/docs/`;
- follow the conventions of the installed version;
- do not rely on remembered framework behaviour when local documentation differs;
- heed deprecation notices;
- preserve server/client boundaries;
- inspect caching, routing, and runtime implications where relevant;
- do not migrate `src/middleware.ts` to `proxy.ts` as a side effect of unrelated work.

## 7. Database and Migrations

Before database-related changes:

- inspect relevant migrations/schema;
- identify affected tables, indexes, functions, triggers, and policies;
- trace application reads/writes that depend on the schema;
- verify tenant/account isolation;
- consider existing data, rollback, compatibility, and migration-order implications.

Do not bypass RLS or privileged-access boundaries as a shortcut.

Avoid destructive migrations unless explicitly approved.

The following require explicit user authorization for the specific task, and must not be run as routine verification:

- database resets (including `supabase db reset`, even with `--local`), drops, truncates, or bulk deletes;
- applying migrations to any remote, linked, shared, staging, or production database;
- deployments and production or hosted-environment configuration changes (including env vars, secrets, webhooks, and Meta/WhatsApp settings);
- any other destructive or hard-to-reverse operation.

A local reset replaces the local database contents; confirm the target is the intended throwaway local instance first. Do not infer that authorization for one operation extends to another.

Do not infer production state from local/dev database state.

Schema and security changes require verification against the actual affected access paths.

## 8. External Integrations

WACRM uses the official Meta Cloud API path. Do not reintroduce unofficial WhatsApp transports or Baileys-based runtime paths unless the roadmap and user explicitly change that decision.

For Meta/WhatsApp or other external APIs:

- trace the existing integration end-to-end before modifying it;
- verify current external behaviour against official documentation when required;
- preserve supported flows unless the task explicitly changes them;
- inspect webhook, token, retry, idempotency, and error-handling implications;
- preserve signature verification and tenant/account boundaries;
- avoid speculative compatibility changes.

## 9. AI and Business-Logic Boundaries

Deterministic application code owns deterministic business rules.

AI must not replace deterministic logic for:

- tenant/account isolation;
- authorization;
- approval requirements;
- state transitions;
- idempotency;
- booking availability rules;
- database integrity;
- security controls;
- deterministic pricing rules where such rules exist;
- write authorization.

AI output is prediction or advice, not truth.

Do not silently convert model output into:

- completed-job truth;
- customer/business facts;
- training truth;
- quote truth;
- booking truth;
- approval;
- authorized writes.

Schema-validate structured AI output before persistence or execution.

The quote system may learn from historical business evidence, but completed outcomes outrank AI suggestions.

Image analysis may contribute evidence but must not independently determine final price.

Do not create a self-training loop where AI-generated quotes become learning truth merely because they were generated or sent.

## 10. WACRM AI Tool Layer

The AI Tool Layer must use explicit declared tools rather than unrestricted database access.

Read tools remain read-only.

Write tools must be:

- explicit;
- narrowly scoped;
- validated;
- authorization-aware;
- approval-gated where required;
- auditable.

Do not grant the model general SQL/database access as a substitute for defined tools.

Tool selection does not authorize tool execution.

Tool arguments must still pass normal validation, authorization, tenant isolation, and business-policy checks.

Core business tools should exist and be validated before adding a broader orchestrator.

## 11. Laya / Needle3 — WACRM

The global OpenCode `AGENTS.md` defines the general capabilities and restrictions of Laya and Needle3. The following stricter project rules apply.

### Needle3

Needle3 is especially relevant to the explicit WACRM AI Tool Layer.

Use it to benchmark or shadow-test:

- routing representative customer utterances to explicit declared tools;
- whether tool descriptions are sufficiently distinguishable;
- bounded argument extraction;
- refusal/no-tool behaviour;
- read-tool versus write-tool routing;
- future orchestrator routing quality.

Evaluate Needle against labelled examples before considering runtime integration.

For every evaluated example, compare:

- expected tool or no-tool result;
- selected tool;
- expected arguments;
- extracted arguments;
- confidence;
- unsafe or ambiguous routing cases.

Needle must not:

- directly execute application tools;
- authorize writes;
- bypass approval;
- bypass tenant isolation;
- determine final quote price;
- create completed-outcome truth;
- turn predictions into learning truth.

A low-confidence or empty result is valid and should remain fail-safe.

### Laya

Laya may be evaluated for bounded WACRM classifications such as:

- customer intent;
- urgency;
- enquiry category;
- evidence quality;
- ambiguity;
- needs-human-review;
- escalation/handoff category.

When Laya is evaluated for runtime use, begin with labelled offline/shadow evaluation against representative WACRM cases.

Laya must not:

- determine final quote price;
- authorize writes;
- approve bookings;
- create customer/business facts;
- decide security policy;
- override deterministic business logic;
- convert model predictions into completed outcomes or learning truth.

If a Laya result is persisted for evaluation, retain enough provenance to reproduce the result, including model/task/version and confidence where available.

### Shared rule

Neither Laya nor Needle may weaken:

- explicit tool contracts;
- approval gates;
- deterministic validation;
- tenant/account isolation;
- security controls;
- evidence requirements;
- outcome-capture rules.

Neither tool may silently become business truth, training truth, quote truth, or execution authority.

## 12. Testing and Verification

Use repository-defined commands only.

Inspect project scripts and existing tooling before selecting commands.

Run the smallest relevant verification first, then broader checks where appropriate.

Possible verification categories include:

- type checking;
- linting;
- unit tests;
- integration tests;
- build;
- migration/database validation (requires the authorization described in section 7 when it resets or alters a database);
- AI tool-routing evaluation;
- browser verification;
- webhook/integration contract tests.

Do not invent commands.

Do not modify application behaviour merely to make an unrelated pre-existing failure pass.

Clearly distinguish:

- pre-existing failures;
- failures introduced by the current change;
- environment/tooling failures.

For AI/tool-layer work, verify labelled examples and failure/refusal cases rather than relying only on happy-path examples.

## 13. Documentation and Memory

Do not hard-code detailed implementation architecture into this file when it belongs in the roadmap or dedicated project documentation.

After meaningful analysis or architectural changes, update the appropriate durable project documentation or project memory only when materially affected.

Documentation should describe verified current behaviour.

Avoid duplication. Prefer one authoritative document per topic.

## 14. Git Safety

Before editing, inspect `git status`.

After work, report:

- files changed;
- files created;
- migrations added;
- tests/checks run;
- verification result;
- unresolved issues.

Do not:

- force-reset;
- discard user changes;
- rewrite unrelated history;
- amend commits;
- force-push;
- commit generated artifacts unless intentionally tracked;
- commit secrets.

Only create commits when explicitly requested.

## 15. Working Method

For each development task:

1. understand the requested outcome;
2. inspect the current implementation;
3. identify affected dependencies, security boundaries, data flows, and business rules;
4. read the relevant roadmap objective when the task falls under the AI roadmap;
5. make the smallest correct change;
6. verify the affected behaviour;
7. run appropriate regression checks;
8. update durable documentation or memory only if the change materially affects architecture, policy, or workflow.

Prefer evidence over assumptions.

## 16. WACRM AI Roadmap / Obsidian Planning Vault

The canonical long-term WACRM AI roadmap and development checklists are maintained at:

`D:\AI-Skills-Vault\Projects\WACRM_AI_Learning_System_Roadmap_Obsidian`

The master planning document is:

`D:\AI-Skills-Vault\Projects\WACRM_AI_Learning_System_Roadmap_Obsidian\00 - MASTER ROADMAP.md`

Before starting any substantial AI, CRM, quoting, booking, automation, learning, retrieval, or customer-workflow development task:

1. Read `00 - MASTER ROADMAP.md`.
2. Read the specific objective `.md` file for the task.
3. Check dependencies and prerequisite objectives before implementation.
4. Keep implementation within the current objective unless a dependency requires otherwise.
5. Apply the current decision log and drift-control rules.
6. Report which roadmap checklist items are satisfied after verification.

Treat this roadmap as the planning source of truth for:

- architecture direction;
- implementation order;
- dependencies;
- scope;
- business-input requirements;
- checklist progress;
- learning-system design;
- automation rollout;
- drift control.

Important roadmap files include:

- `01 - Historical Job Learning Model.md`
- `02 - Job Outcome Capture.md`
- `03 - Historical Data Import and Normalization.md`
- `04 - Text Embeddings.md`
- `05 - Image Embeddings.md`
- `06 - Similar Job Retrieval.md`
- `07 - Similar Image Retrieval.md`
- `08 - Case Memory Service.md`
- `09 - Hybrid Quote Engine.md`
- `10 - Quote Feature Model.md`
- `11 - Quote Confidence Engine.md`
- `12 - Quote Explanation and Comparables.md`
- `13 - Availability Engine.md`
- `14 - Booking Engine.md`
- `15 - Draft Reply System.md`
- `16 - AI Orchestrator.md`
- `17 - Policy and Approval Layer.md`
- `18 - Operator UI and Human Approval.md`
- `19 - Learning and Evaluation Pipeline.md`
- `20 - Monitoring and Observability.md`
- `21 - Rollout and Automation Levels.md`
- `22 - Security and Privacy.md`
- `23 - Business Inputs Needed.md`
- `24 - Task Execution Template.md`
- `25 - Decision Log and Drift Control.md`

### Locked roadmap decisions

Preserve the current locked decisions unless the decision log is explicitly changed:

- Official Meta Cloud API only.
- No Baileys/unofficial WhatsApp transport.
- A conversation may contain multiple historical enquiries.
- AI uses explicit tools, not unrestricted database access.
- Write tools are explicit and approval-gated.
- Image analysis cannot decide final price.
- Quote learning uses historical business evidence.
- Completed outcomes outrank AI suggestions.
- Confidence is evidence-derived.
- AI quotes must not become training truth through self-feedback.
- Core business tools come before the orchestrator.

### Drift check

Before roadmap implementation, verify:

- Is this the current roadmap objective?
- Are required business inputs known?
- Are we duplicating an existing abstraction?
- Are we inventing a policy or fact?
- Are we treating prediction as truth?
- Are we weakening tenant/security boundaries?
- Are we asking the LLM to perform deterministic business logic?
- Are we skipping outcome/evidence capture needed for learning?
- Are we enabling automation before validation?

If implementation direction changes materially:

1. update the decision log;
2. update the master roadmap;
3. update affected objective files;
4. then change implementation direction.

## 17. Legacy Roadmap

The earlier roadmap remains available at:

`D:\AI-Skills-Vault\Projects\WACRM_AI_Roadmap_Obsidian`

It contains historical implementation checklists for previously completed work, including:

- Conversation and Enquiry State;
- AI Tool Layer;
- `get_customer`;
- `get_conversation`;
- Image Analysis;
- initial Policy/Approval work.

Use the legacy roadmap only as historical/reference material when checking previously implemented work.

If the legacy roadmap conflicts with the Learning System roadmap, the Learning System roadmap takes precedence.

## 18. Roadmap Modification Rules

Do not modify either Obsidian roadmap unless the task explicitly requires roadmap/checklist maintenance or an implementation-direction change requires the canonical decision-log process.

When updating roadmap progress:

- update only checklist/status items supported by completed and verified work;
- do not mark future acceptance criteria complete prematurely;
- do not rewrite unresolved business decisions as settled;
- record significant architecture/direction changes in `25 - Decision Log and Drift Control.md`;
- keep the master roadmap and affected objective files synchronized when direction changes.

Do not duplicate the entire roadmap inside this repository.

## 19. Completion Standard

A task is complete only when the relevant implementation, security, data, verification, and documentation obligations are satisfied.

Final reports should distinguish:

- what changed;
- what was verified and how;
- which MCPs/skills were materially used;
- any database/schema changes;
- any external-integration effects;
- any AI/tool-routing evaluation performed;
- roadmap/checklist items satisfied where applicable;
- remaining gaps or blockers;
- any durable documentation or memory updated.

Do not claim completion for unverified behaviour, unresolved required security boundaries, or uncertain external/write outcomes.

## 20. Customization Registry and Upstream Updates

The durable customization and update-safety registry is maintained at:

`D:\AI-Skills-Vault\Projects\WACRM_Customizations`

Git is authoritative for exact changes; the registry records intent, dependencies, risks, preservation requirements, and upgrade procedures. See `docs/customization-registry.md` and `docs/upstream-baseline.md` for repository-side discovery metadata.

Any task that changes an upstream-owned file, integration seam, database migration, or documented architecture decision must update the affected registry note before the task is complete. After a commit exists, record its SHA, update verification references and upgrade risk where needed, and refresh the Customization Index. Trivial generated files and formatting-only changes are exempt.

Upstream updates must occur on dedicated reviewed upgrade branches. Never blindly replace customized files with upstream versions, and do not move the baseline marker until all overlaps are reviewed, the full verification matrix passes, an Upgrade Report exists, and the result is accepted.

## WhatsApp Business Tools MCP

The project may use Meta's official WhatsApp Business Tools MCP:

`whatsapp_business_tools`

Endpoint:

`https://mcp.facebook.com/whatsapp_business_tools`

This MCP is a development and operational administration tool only.

WACRM production messaging continues to use the official Meta Cloud API directly. Do not introduce an MCP runtime dependency into the application.

Use the MCP when it materially helps with:

- discovering WhatsApp Business assets
- inspecting WABA and phone-number configuration
- validating Cloud API setup
- managing or inspecting templates
- inspecting/configuring webhooks
- troubleshooting WhatsApp Business configuration
- controlled test messaging

Safety rules:

- Prefer read-only discovery first.
- Treat phone registration, template modification, webhook modification and message sending as state-changing operations.
- Do not perform state-changing WhatsApp Business MCP actions unless the current task explicitly requires them.
- Confirm the target business, WABA, app and phone number before any write action.
- Never use MCP actions to bypass WACRM's own policy/approval architecture.
- Never expose OAuth tokens or Meta credentials in prompts, logs, source files or repository configuration.
- Production customer messaging must remain controlled by WACRM through the Meta Cloud API.
