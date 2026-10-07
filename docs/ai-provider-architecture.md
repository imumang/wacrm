# WACRM AI provider, configuration and usage architecture

The authoritative description of how WACRM talks to an LLM today. This
document covers the **existing** AI surface — the reply assistant, the
inbound auto-reply, the knowledge base, embeddings, and now vision for
`analyze_images` — so that new AI work reuses it instead of standing up a
parallel stack. Companion documents: [`ai-tool-layer.md`](./ai-tool-layer.md)
(the business tools), [`image-analysis.md`](./image-analysis.md) (the
Objective 08 vision adapter), [`whatsapp-architecture.md`](./whatsapp-architecture.md),
[`project-context.md`](./project-context.md).

Source of truth: `src/lib/ai/*`.

## One stack, two surfaces

```text
bring-your-own-key, per account, two providers
        │
        ├── config.ts        loadAiConfig / loadEmbeddingsKey   (ai_configs)
        ├── types.ts         AiConfig, AiUsage, AiError
        ├── providers/       openai.ts · anthropic.ts · shared.ts
        ├── generate.ts      generateReply  → draft + auto-reply (text)
        ├── embeddings.ts    embedTexts     → knowledge base + vector memory (OpenAI only)
        ├── auto-reply.ts    dispatchInboundToAiReply  ← WhatsApp webhook
        ├── defaults.ts      prompts, MAX_OUTPUT_TOKENS, aiRequestTimeoutMs
        ├── usage.ts         logAiUsage     → ai_usage_log
        └── image-analysis/
              vision-analyzer.ts   the same two providers, with images
```

There is no provider SDK dependency. Every call is a `fetch` against a
hard-coded, HTTPS provider endpoint using the account's own key.

## Providers

| Provider | Endpoint | Module | Auth header |
| --- | --- | --- | --- |
| `openai` | `POST https://api.openai.com/v1/chat/completions` | `providers/openai.ts` | `Authorization: Bearer …` |
| `openai` (embeddings) | `POST https://api.openai.com/v1/embeddings` | `embeddings.ts` | `Authorization: Bearer …` |
| `anthropic` | `POST https://api.anthropic.com/v1/messages` | `providers/anthropic.ts` | `x-api-key` + `anthropic-version` |

The endpoint and version constants are exported from the provider modules
so a second caller reuses one definition rather than restating the URL.

`AiProvider` is `openai | anthropic` — a closed union in `types.ts` and a
`CHECK` constraint on `ai_configs.provider`. Anthropic has no embeddings
endpoint, so `embeddings.ts` is OpenAI-only and uses a separate, optional
key.

That one client now serves **two** consumers: the knowledge base
(`embedTexts`) and the historical-case vector memory added by roadmap
objective 03 (`embedTextsWithUsage`, which additionally returns the
provider's usage block and accepts a caller cancellation signal). It is
one endpoint, one key, and one request shape — objective 03 is a second
consumer of the existing path, not a second path. An account with no
usable embeddings key gets `unavailable` from both, which is a supported
state rather than an error. See
[`vector-memory.md`](./vector-memory.md).

Shared plumbing lives in `providers/shared.ts` and is reused by the vision
adapter rather than reimplemented:

- `normalizeUsage` — coerces `prompt`/`completion`/`total` into `AiUsage`,
  returns `null` when the provider reported nothing usable.
- `toNetworkError` — maps a fetch rejection to `AiError('timeout' | 'network_error')`.
- `providerHttpError` — maps a non-2xx to `AiError('invalid_key' | 'rate_limited' | 'provider_error')`.
- `mergeConsecutive` — collapses same-role turns for Anthropic's strict alternation.

## Per-account configuration

One row per workspace: `ai_configs`, `UNIQUE (account_id)`, created by
migration `029_ai_reply.sql` and extended by `033_ai_reply_polish.sql`.

| Column | Meaning |
| --- | --- |
| `provider` | `openai` \| `anthropic` (CHECK constrained) |
| `model` | free text, **not** an allowlist — the starting point is `AI_PROVIDER_DEFAULT_MODEL`, the operator's final choice |
| `api_key` | the account's BYO key, AES‑256‑GCM encrypted at rest via `src/lib/whatsapp/encryption.ts` |
| `embeddings_api_key` | optional second key; null falls back to lexical full-text search |
| `system_prompt` | business context / persona / tone, appended to a fixed scaffold |
| `is_active` | master switch for draft **and** auto-reply |
| `auto_reply_enabled`, `auto_reply_max_per_conversation`, `handoff_agent_id` | inbound bot controls |

`config.ts:loadAiConfig(db, accountId, { requireActive })` is the single
loader. It returns `null` for "no row" and for "`is_active` is off" — the
two mean the same thing to callers — and throws only when the stored key
cannot be decrypted, so a rotated `ENCRYPTION_KEY` surfaces distinctly
rather than looking like "not configured". It works with any client: the
RLS-scoped SSR client from a dashboard route, or the service-role admin
client from the webhook.

**Secrets never move.** No key is ever returned to the browser
(`/api/ai/config` returns `has_key` / `has_embeddings_key` booleans and
strips the ciphertext), no key is written to a log, and no AI module
constructs a Supabase client. Vision analysis reads the same row through
the same loader.

## Model selection

Model choice is deliberately **not** enumerated: `defaults.ts` documents
why (model ids churn, and a forker may want a cheaper or newer one), so
the UI offers free text pre-filled with a per-provider default and the
`POST /api/ai/config` route verifies the credentials against the provider
before persisting.

The shipped defaults are `gpt-5.4-mini` (OpenAI) and
`claude-haiku-4-5-20251001` (Anthropic). Both accept image input, which is
why the vision adapter can use the account's configured model rather than
introducing a second model setting — see
[`image-analysis.md`](./image-analysis.md#vision-model-selection).

A model that does not support image input is a safe failure, not a
fallback: the provider rejects the request and the caller gets an ordinary
provider error. WACRM never silently substitutes a different model.

## Structured output

There is **no** generic structured-output helper in this layer. `generate.ts`
parses exactly one thing — the `[[HANDOFF]]` sentinel in `defaults.ts` —
and returns the rest as text. Nothing today requests JSON from a provider.

Structured output therefore exists only where a validator demands it:
`analyze_images`. The vision adapter asks for a JSON object and hands the
parsed value to `parseImageAnalysisResult`, which is the authority; see
[`image-analysis.md`](./image-analysis.md#structured-output).

## Timeouts and retries

- `aiRequestTimeoutMs()` — `AI_REQUEST_TIMEOUT_MS`, default 30 s, applied
  by each provider module via `AbortSignal.timeout`.
- `IMAGE_ANALYZER_TIMEOUT_MS` (20 s) — the Objective 08 budget for one
  vision call, separate from the chat budget because a multi-photo vision
  request is a different shape of work. The tool also honours caller
  cancellation via `ToolExecutionContext.signal`, and the two abort causes
  are reported with different messages.
- There are **no retries** anywhere in the AI layer. A provider failure is
  surfaced to the caller, which decides whether to try again. Adding one
  would change spend and duplicate-request behaviour, so it stays an
  explicit decision.

## Usage and cost tracking

`usage.ts:logAiUsage(db, args)` appends one row to `ai_usage_log` per
provider call: `account_id`, `conversation_id`, `mode`, `provider`,
`model`, and the three token counts. It **never throws** — a spend
accounting failure must not fail a customer-facing reply — and it is a
no-op when the provider reported no usage.

`mode` is constrained to `('auto_reply', 'draft', 'image_analysis')`
(migration `033`, widened by `048_ai_usage_image_analysis_mode.sql` for the
vision path). RLS is admin+-read; the table is written only by the service
role and never mutated from the client.

Callers fire it and forget, e.g. `void logAiUsage(...)` in
`auto-reply.ts`, so accounting never adds latency to a customer.

The separate `ai_tool_call_audit` table (migration `047`) records AI
*business-tool* invocations — tool, account, actor, correlation id,
duration, outcome, safe error code — metadata only, via
`src/lib/ai/tools/audit.ts`.

## Auto-reply

`auto-reply.ts:dispatchInboundToAiReply` runs from the WhatsApp webhook's
`after()` block. It gates on: AI active, auto-reply enabled, no assigned
agent, not previously handed off, per-conversation cap not reached, no
per-message auto-responder configured, and an account-wide rate limit. It
claims a reply slot atomically through `claim_ai_reply_slot` before
sending through `engineSendText`.

Nothing in Objective 08 or in the vision path touches this. Image analysis
is a read tool with `side_effects: 'none'`; it cannot send.

## What does not exist yet

- No AI orchestrator; tools are called directly by application code or tests.
- No policy/risk engine beyond the explicit `ToolApproval` object.
- No generic structured-output helper, no schema enforcement, no retry.
- No per-feature model configuration (draft, auto-reply, and vision share
  the account's one configured model).