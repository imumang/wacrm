# WACRM — Image Analysis (Objective 08)

**Current behaviour only.** This document describes what the code does
today: a provider-neutral, read-only image-analysis layer with a
production vision adapter behind it, reusing WACRM's existing
bring-your-own-key AI configuration. There is no pricing, no weight
estimate, no quote calculation, and no automatic reply anywhere in this
layer. Companion documents:
[`ai-provider-architecture.md`](./ai-provider-architecture.md) (the shared
provider/config stack this layer reuses),
[`ai-tool-layer.md`](./ai-tool-layer.md),
[`whatsapp-architecture.md`](./whatsapp-architecture.md),
[`enquiry-state.md`](./enquiry-state.md),
[`project-context.md`](./project-context.md).

Source of truth: `src/lib/ai/image-analysis/*` and
`src/lib/ai/tools/analyze-images.ts`.

## Objective

Turn customer-uploaded WhatsApp images into **structured observations** that a
future quote engine can consume — without deciding anything about price.

The separation is deliberate and load-bearing. A photograph can support "a
three-seat sofa, probably dismantled, medium confidence". It cannot support
"£120". Volume in yards, weight in kilograms, and price in pounds are all
_business rules_ (Objective 05 quote engine) or unresolved business inputs
(Objective 16 load-size definitions), so this layer produces none of them.

## Architecture

```text
analyze_images  (read tool, src/lib/ai/tools/analyze-images.ts)
        │
        ├── conversations ── account-scoped existence check
        ├── messages ─────── conversation-scoped image rows
        ├── enquiries ─────── optional customer-stated context
        │
        ├── media boundary (image-analysis/media.ts)
        │     ├── resolveMediaObjectPath  — canonical record → object path
        │     └── AnalysisMediaLoader     — pluggable byte source
        │           └── Supabase Storage `chat-media` (production)
        │
        ├── ImageAnalyzer (image-analysis/analyzer.ts)   ← provider-neutral
        │     └── resolved per account by getConfiguredImageAnalyzer()
        │           └── vision-analyzer.ts → OpenAI | Anthropic vision
        │
        └── parseImageAnalysisResult (image-analysis/result.ts)
              strict validation → AnalyzeImagesOutput
```

Module map:

| File                                         | Responsibility                                                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/ai/tools/analyze-images.ts`         | The `analyze_images` read tool: input parsing, conversation/message/enquiry reads, analyzer resolution + deadline, output assembly. |
| `src/lib/ai/image-analysis/limits.ts`        | Limits, supported MIME types, MIME normalisation, magic-byte sniffing.                                                                |
| `src/lib/ai/image-analysis/media.ts`         | Controlled media retrieval: object-path resolution, account check, dedupe, size/count budgets, content verification.                  |
| `src/lib/ai/image-analysis/analyzer.ts`      | The `ImageAnalyzer` interface, request/response types, customer-stated context type, and the per-account resolver.                     |
| `src/lib/ai/image-analysis/vision-analyzer.ts` | The production adapter: provider wire formats, credential, timeout, JSON decode.                                                    |
| `src/lib/ai/image-analysis/vision-prompt.ts` | The vision instructions and the per-call user text (ordinals + untrusted context).                                                   |
| `src/lib/ai/image-analysis/result.ts`        | The structured observation schema and its strict validator.                                                                           |
| `src/lib/ai/image-analysis/fake-analyzer.ts` | Deterministic test analyzer.                                                                                                          |
| `src/lib/ai/image-analysis/index.ts`         | Single module surface for the tool layer.                                                                                             |

## `analyze_images` contract

Registered in `AI_TOOL_REGISTRY` alongside the other business tools. It is
produced by `defineReadTool`, so `access: 'read'`, `side_effects: 'none'`,
no approval gate, and no idempotency key — the same guarantees
`get_customer` and `get_conversation` have. Auditing comes from the existing
read-tool path in `contract.ts` / `audit.ts`: one metadata-only row per
invocation, no input, no output, no media reference, no image content.

### Input

```ts
interface AnalyzeImagesInput {
  conversation_id: string; // required
  message_ids?: string[]; // 1..6 explicit WACRM message ids
  image_limit?: number; // 1..6, default 3; newest images
  include_context?: boolean; // default true
}
```

Rules:

- The account is **not** an input. `account_id` comes from
  `ToolExecutionContext`, and supplying `account_id`/`account` as an argument
  is an explicit `invalid_input` error.
- Media is referenced **only** by WACRM message id. Any other key — a URL, a
  storage path, a Meta media id — is rejected by the key allowlist with a
  message that names the rule.
- `message_ids` and `image_limit` are mutually exclusive. `message_ids` is
  deduplicated and length-checked against `max_images` before any read.
- With no `message_ids`, the tool reads the newest `image_limit` image
  messages in the conversation (`created_at DESC, id DESC`, `limit + 1` to
  report `has_earlier_images`) and presents them chronologically.

### Output

`AnalyzeImagesOutput` (see `analyze-images.ts` for the full interface):

| Field                                                  | Meaning                                                                                                                                |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `conversation_id`, `enquiry_id`                        | Scope the analysis was performed in.                                                                                                   |
| `analyzer_id`                                          | Provider-neutral id of the analyzer used. Never a model version, endpoint, or credential.                                              |
| `images[]`                                             | Every image actually analysed: ordinal, `source_message_id`, `source_media_id`, MIME, byte length, direction, content type, timestamp. |
| `duplicate_media_references[]`                         | Messages collapsed as references to an already-analysed object.                                                                        |
| `observations[]`                                       | Structured observations (below).                                                                                                       |
| `ambiguous_items[]`                                    | Things that could not be identified, with the same source traceability.                                                                |
| `image_quality[]`                                      | Blur, darkness, resolution, obstruction, partial view.                                                                                 |
| `estimated_volume_range`                               | `relative_volume_units` span, or `null`.                                                                                               |
| `need_more_photos`, `follow_up_questions[]`, `notes[]` | The provider's own assessment.                                                                                                         |
| `supplied_context`                                     | Customer-stated enquiry facts, or `null`.                                                                                              |
| `uncertainty`                                          | Aggregate honesty signals (below).                                                                                                     |
| `guarantees`                                           | `price_calculated: false`, `weight_estimated: false`, `hidden_details_inferred: false`.                                                |
| `limits`                                               | The effective limits for this call, so a consumer can see the boundary it operated within.                                             |
| `context_window`, `freshness`                          | Selection and retrieval metadata, matching the other read tools.                                                                       |

## Media retrieval and security boundary

`src/lib/ai/image-analysis/media.ts` is the only path by which bytes reach an
analyzer. It is the smallest boundary that satisfies the requirement, and each
of its properties is enforced in code and asserted in tests.

**Canonical records only.** Candidates come from `messages` rows the caller has
already been authorised for. The object path is _derived_ from that row's own
`media_url`; nothing accepts a caller- or model-supplied location.

**Account scoped, twice.** The conversation is read with
`.eq('account_id', account_id)`, and every message read is filtered by that
verified `conversation_id` (`messages` has no `account_id` column — migration
017 reaches it through the parent conversation's policy). The derived object
path must then begin with `account-<account_id>/`, the exact convention the
`chat-media` write policies match on (migrations 020/023). A path in another
account's folder is `forbidden`.

**No remote fetch, therefore no SSRF.** The stored reference is parsed for its
path and that path is read through the Supabase Storage client the trusted
caller already holds. No URL is ever requested, no host is resolved, and no
signed or temporary URL is produced. The module constructs no Supabase client
and holds no credential, consistent with `docs/ai-tool-layer.md`.

**No credentials in or out.** Nothing returned names a token, a signature, or a
query string. `resolveMediaObjectPath` refuses any reference carrying
credentials, a query, or a fragment. Storage errors become a generic
retryable `unavailable`; the underlying storage message goes to the operator
log only, because it can contain object names and connection detail.

**Rejections are explicit and closed.** Non-`https`, non-Supabase, wrong
bucket, traversal (`..`), empty segments, and non-`[A-Za-z0-9._-]` segments
are all `invalid_reference`. A site-relative path is `not_durable_media`.

**Content is verified, not trusted.** The stored MIME label is a label; the
bytes are the fact. `sniffImageMimeType` identifies JPEG/PNG/GIF/WebP from the
leading bytes, and the declared type (from the message row and from storage)
must agree with it. A mislabelled object is rejected rather than passed to a
provider as an image.

**Deterministic ordering and deterministic dedupe.** Candidates are read in
chronological order and passed to the analyzer in that order. Two messages that
point at the _same_ storage object are byte-identical by construction, so the
first is kept and the later one is reported in `duplicate_media_references`
with `reason: 'identical_media_object'`.

**Uses existing infrastructure.** The production loader is
`createSupabaseStorageMediaLoader()`, reading the same `chat-media` bucket the
composer writes to and `mirror-inbound-media.ts` copies inbound attachments
into. No WhatsApp download logic is duplicated.

### What this boundary does not reach

Media Meta still holds but WACRM never mirrored is stored as the legacy
`/api/whatsapp/media/<metaMediaId>` proxy pointer. That is **not** retrievable
here and returns `unavailable` ("Media is not stored in WACRM media storage").
Chasing it would mean decrypting the account's WhatsApp token inside an
analysis call — a separate capability with its own failure modes. Supporting it
is a future `AnalysisMediaLoader` implementation, not a change to this
boundary.

## Provider abstraction

```ts
interface ImageAnalyzer {
  readonly id: string;
  analyze(request: ImageAnalysisRequest): Promise<unknown>;
}
```

`ImageAnalysisRequest` carries image bytes, canonical source refs, an optional
`AbortSignal`, and the customer-stated context. The analyzer is given **bytes**,
never a URL, a storage client, or a credential — which removes the SSRF surface
from the provider side entirely. It cannot fetch anything itself.

The return type is `unknown`. A provider is not trusted to have produced a valid
observation set; validation is a separate, tested step.

`createAnalyzeImagesTool({ analyzer, mediaLoader, analyzerTimeoutMs })` is the
injection point; `createAnalyzeImagesTool({ resolveAnalyzer, mediaLoader })` is
the production one.

### The production adapter

`vision-analyzer.ts` is the only module in WACRM that puts image bytes in front
of a model. It owns the provider wire format, the credential, and the timeout,
and deliberately does almost no thinking.

- **Provider: reused, not added.** OpenAI and Anthropic — the two providers
  WACRM already supports for chat — selected by the account's existing
  `ai_configs.provider`. No new provider, no new dependency, no new SDK, no new
  settings screen. The endpoint constants are imported from
  `providers/openai.ts` and `providers/anthropic.ts` rather than restated, and
  the error/usage helpers (`providerHttpError`, `toNetworkError`,
  `normalizeUsage`) are the same ones the chat path uses.
- **Images are inlined, never referenced.** One base64 block per photograph:
  an `image_url` data URI on OpenAI, an `image` source block on Anthropic. The
  adapter never receives a URL to fetch and never constructs one.
- **It validates nothing.** The provider's JSON is parsed and returned as-is.
- **Cancellation and timeout.** The request's `signal` and a local deadline are
  combined into the signal handed to `fetch`; the timer and listener are
  disposed deterministically. An already-aborted caller signal short-circuits
  before any request is made.
- **Errors stay safe.** Everything is rethrown as `AiError`, which the tool
  converts into a generic `unavailable`. The provider's own message never
  surfaces to the caller and is not logged.
- **`id` is a constant**, `configured_vision_model`, because `analyzer_id` is
  copied into tool output.

#### Vision model selection

The account's configured `model` is used. WACRM already treats model choice as
operator configuration (`defaults.ts` deliberately keeps it free text rather
than an allowlist), so a second, vision-specific model setting would have been
a new configuration concept for no gain — and both shipped defaults
(`gpt-5.4-mini`, `claude-haiku-4-5-20251001`) accept image input.

If an operator configures a model that cannot read images, the provider rejects
the request and the caller gets a safe provider error. WACRM does **not** fall
back to a different model.

`IMAGE_ANALYSIS_MAX_OUTPUT_TOKENS` is 4,096, not the chat path's 1,024: a
six-photo analysis can carry up to 30 observations, and a truncated JSON
document is an invalid document, not a shorter answer. Both adapters also check
the provider's stop reason and refuse a length-truncated reply outright rather
than parsing the fragment.

### Configuration and secret handling

`getConfiguredImageAnalyzer()` resolves the analyzer **per account**, because
provider, model, and credential all live on that account's own `ai_configs`
row. It calls the existing `loadAiConfig(db, account_id)` — the same loader the
draft button and the inbound auto-reply use — and constructs the adapter from
the decrypted `AiConfig`.

- No duplicate API-key storage. `ai_configs.api_key` remains the only chat/vision
  key, still AES‑256‑GCM encrypted, still never returned to the client.
- No client-visible configuration. `/api/ai/config` is unchanged.
- No service-role client is constructed here; the tool passes the caller's own
  client through.
- `is_active` is honoured: an account whose AI master switch is off gets
  `unavailable`.

`getConfiguredImageAnalyzer` returns:

| Situation | Result |
| --- | --- |
| Active config with a supported provider, model, and key | the production adapter |
| No `ai_configs` row, `is_active` off, or no stored key | `null` → non-retryable `unavailable` |
| Stored key cannot be decrypted | logged, then a retryable `unavailable` (a distinguishable failure, not a silent absence) |
| Configuration read failed transiently | retryable `unavailable` |
| Provider outside the supported union | `null` — the adapter refuses to guess an endpoint |

No fake or test analyzer is reachable from the production path.

Resolution order inside the tool is deliberate: parse input → verify the
account-scoped conversation → resolve the analyzer → read media → analyse. An
unconfigured account therefore never causes a customer photograph to be
downloaded, and `conversation_id` is only forwarded once it is known to belong
to the calling account.

## Prompt and instruction design

`vision-prompt.ts` holds the instructions. They are instructions, not
enforcement — `result.ts` is the authority — but they exist so that a
rejection is rare and the failure mode is a clean error instead of a quietly
wrong observation.

The system prompt requires the model to:

- report only visible evidence, and keep observed separate from ambiguous;
- estimate counts (`approximate_count` with its own confidence) rather than
  claim exact counts;
- express volume only in `relative_volume_units`;
- never state or imply a price, cost, charge, fee, quote, or rate;
- never state or imply a weight in kilograms, pounds, tonnes, or any absolute
  mass;
- never infer property, address, floor, lift, stair, parking, or access detail
  — those may only be raised as questions;
- report blur, darkness, low resolution, obstruction, partial view, and
  unreadable images in `image_quality` instead of analysing around the problem;
- set `need_more_photos` and name the missing shot in `follow_up_questions` when
  evidence is insufficient, rather than guessing to fill the schema;
- reference images **only** by the 1-based ordinal it was given, via
  `source_indexes`, and never invent a filename, path, link, or message id.

It also states the exact accepted key names (including `source_indexes`, which
a model would not otherwise guess) and the result bounds.

What the model never receives: storage object paths, signed URLs, credentials,
the account id, message ids, the `enquiry_id`, or any database detail. The
per-call user text contains only the ordinal map and, when the caller included
them, the customer-stated facts — labelled untrusted, bounded to 200 characters
per value and 20 values per list, and explicitly marked as disambiguation only
that must not become an observation. This mirrors the discipline
`buildSystemPrompt` already applies to conversation turns and knowledge-base
excerpts.

## Structured output

The provider's JSON text is decoded by `parseProviderJson`, which makes exactly
two lexical accommodations — surrounding whitespace and a single wrapping
```` ``` ```` / ```` ```json ```` fence. It coerces nothing, renames nothing,
defaults nothing, and drops nothing. An unknown key, an out-of-range number, a
pricing field, or an ordinal outside the analysed set still reaches
`parseImageAnalysisResult` and is rejected there.

The rules the validator enforces, in summary:

- unknown keys are rejected, not ignored;
- keys containing a pricing or weight word (`price`, `cost`, `charge`, `fee`,
  `amount`, `quote`, `weight`, `kg`, `tonne`, `pounds`, `gbp`, `currency`, …)
  are rejected with a `forbidden_field` reason, so a provider cannot smuggle a
  price in even under an unexpected key name;
- confidences and volume bounds must be in range, `max <= min` is rejected,
  `need_more_photos` must be a boolean, and an `ImageAnalysisValidationError`
  carries a safe `reason` (`invalid_shape`, `forbidden_field`, `out_of_range`);
- `observation_id` is assigned by this layer, so a provider cannot create
  identity.

## Limits

`IMAGE_ANALYSIS_LIMITS` in `limits.ts`. These are module constants, not
configuration: they are a safety boundary (memory, payload size, and future
cost control), so changing one is a code-review event.

| Limit                  | Value                | Basis                                                                                                                    |
| ---------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `max_images`           | 6                    | Enough for a room; bounded so one call cannot become an unbounded transfer.                                              |
| `max_bytes_per_image`  | 5 MiB                | `MEDIA_MAX_BYTES_BY_KIND.image` — Meta's WhatsApp image ceiling, which is also WACRM's composer/mirror limit for images. |
| `max_total_bytes`      | 15 MiB               | Three times the per-image cap, so six images cannot reach the 16 MB the bucket accepts per object.                       |
| `supported_mime_types` | jpeg, png, webp, gif | Exactly the image types the `chat-media` bucket accepts (migrations 023, 039). Nothing added.                            |

Worst-case bytes actually transferred by one call is bounded at
`max_total_bytes + max_bytes_per_image` (20 MiB): the running total is checked
after each image, so the call stops before it can exceed the per-image
allowance again.

Result-shape bounds (`max_observations` 30, `max_follow_up_questions` 6,
`max_notes` 5, `max_hazards_per_observation` 5,
`max_sources_per_observation` 6, `max_label_chars` 120, `max_note_chars` 400,
`max_question_chars` 300) exist so a provider cannot inflate a single result.
Bounded free text is truncated; anything else out of range is rejected.

`ANALYZE_IMAGES_DEFAULT_IMAGE_COUNT` is 3 and `IMAGE_ANALYZER_TIMEOUT_MS` is
20 s. The timeout is a bound on one provider call and is distinct from caller
cancellation, so the two are distinguishable in a result.

## Structured observation schema

```ts
interface ImageObservation {
  observation_id: string; // assigned here, never by the provider
  kind: ImageObservationKind;
  label: string;
  confidence: number; // 0..1
  basis: 'observed' | 'ambiguous';
  approximate_count: { value: number; confidence: number } | null;
  volume_range: RelativeVolumeRange | null;
  dismantling: 'indicated' | 'not_indicated' | 'unknown';
  heavy_handling: 'indicated' | 'not_indicated' | 'unknown';
  hazards: readonly string[];
  sources: readonly ImageSourceRef[];
  notes: string | null;
}
```

`ImageObservationKind` covers the observable categories: `furniture`,
`appliance`, `bags_or_boxes`, `loose_mixed_waste`, `garden_waste`,
`construction_waste`, `bulky_or_heavy`, `ambiguous_item`.

`ImageQualityIssueKind` covers `blurred`, `too_dark`, `low_resolution`,
`obstructed`, `partial_view`, `unreadable`.

Every count is `approximate_count` and carries its own confidence. No field is
named "weight" and none is. `RelativeVolumeRange` is
`{ unit: 'relative_volume_units', min, max, confidence }` — an abstract scale,
because load-size definitions are an unresolved business input and the quote
engine does not exist. A provider that tries to return an absolute unit is
rejected.

`basis: 'observed'` is only valid for something actually visible in a source
image. Anything uncertain is `ambiguous` or appears under `ambiguous_items`.

### Validation

The provider's own error message is dropped when the tool surfaces a
rejection; it can echo provider text. A rejected answer becomes `internal`
with a message naming only the safe `reason`.

## Source traceability

Every observation, ambiguity, and quality issue carries resolved
`ImageSourceRef[]`:

```ts
interface ImageSourceRef {
  ordinal: number; // 1-based position in the analysed set
  source_message_id: string; // the WACRM message row
  source_media_id: string; // account-scoped storage object path
}
```

A provider addresses images **only** by 1-based ordinal into the set it was
given. The message id and object path are resolved here, from WACRM's own
records — a provider cannot name a message, a path, or a URL. An ordinal
outside the analysed set is rejected, so a result cannot claim to come from an
image that was not part of the call.

`source_media_id` is the object path (`account-<id>/inbound/…`), not a URL. It
is what an operator needs to find the attachment, and it is not a credential:
the `chat-media` bucket is public by design and no signed URL exists.

## Uncertainty handling

- Absent visual signal is `unknown`, never `not_indicated`. The default for
  `dismantling` and `heavy_handling` is `unknown`.
- Counts are approximate and confidence-scored.
- The output carries an `uncertainty` block: whether ambiguities or quality
  issues were found, whether a volume range was observed at all, the lowest
  observation confidence, and `possible_duplicate_photos`.
- Customer-stated context is passed under
  `origin: 'customer_statement'` and echoed as `supplied_context`. It is
  explicitly separate from everything observed, and the tool does not let it
  become an observation.
- `need_more_photos` and `follow_up_questions` are the provider's own
  assessment rather than a derived heuristic, so a weak photo is reported as
  weak instead of being quietly analysed as if it were clear.

## Failure behaviour

| Situation                                                              | Result                                                                                                     |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Account has no usable AI configuration                                | `unavailable`, not retryable, before any media is read                                                     |
| Account AI configuration could not be read                             | `unavailable`, retryable, message `Image analysis configuration could not be read`                         |
| No image media in scope                                                | `invalid_input`                                                                                            |
| Unknown / foreign conversation, or a message id outside it             | `not_found` (indistinguishable, so no cross-account enumeration)                                           |
| Account supplied as input, unknown key, bad limit, empty `message_ids` | `invalid_input`                                                                                            |
| Media not stored in `chat-media` (legacy Meta proxy pointer)           | `unavailable`, not retryable                                                                               |
| Media in another account's folder                                      | `forbidden`                                                                                                |
| Traversal, non-`https`, credentialed, or wrong-bucket reference        | `invalid_input`                                                                                            |
| Unsupported declared MIME, or content that is not a supported image    | `invalid_input`                                                                                            |
| Declared type disagrees with the actual bytes                          | `invalid_input`                                                                                            |
| Image over `max_bytes_per_image`, or set over `max_total_bytes`        | `invalid_input`                                                                                            |
| More than `max_images`                                                 | `invalid_input`                                                                                            |
| Stored media missing or unreadable                                     | `unavailable`, retryable                                                                                   |
| Empty object                                                           | `unavailable`, not retryable                                                                               |
| Provider timeout                                                       | `unavailable`, retryable, message `Image analysis timed out`                                               |
| Provider threw (HTTP error, network error, non-JSON, empty answer)     | `unavailable`, retryable, message `Image analysis provider failed` — the provider's message never surfaces |
| Provider answer truncated by the output cap                            | `unavailable`, retryable, `Image analysis provider failed`                                                  |
| Invalid provider result                                                | `internal`, message names only the safe `reason`                                                           |
| Caller cancellation                                                    | `unavailable`, retryable                                                                                   |

No storage path, object name, credential, database error, or provider message
appears in any returned error.

## Observability

Three existing mechanisms, no new table and no new logging system:

- **Durable tool audit** — the existing read-tool path writes one
  metadata-only row to `ai_tool_call_audit` per invocation (migration `047`):
  tool, account, actor, correlation id, duration, outcome, safe error code, and
  retryability. Still no tool input, output, media reference, or content.
- **Token usage** — a successful vision call appends one row to the existing
  `ai_usage_log` with `mode: 'image_analysis'`, the account's provider and model,
  and the provider's token counts. This reuses the cost trail rather than a
  second accounting system; migration
  `048_ai_usage_image_analysis_mode.sql` widens `mode`'s CHECK for it, and
  `supabase/ci/verify-schema.sql` asserts that widening rather than trusting the
  migration ran. Logging is fire-and-forget and swallows its own errors.
- **Operator log** — one `console.info('[ai image-analysis] vision call', …)`
  per call with account id, conversation id, correlation id, provider, model,
  image count, duration, outcome, token counts, and (on failure) the provider
  error `code`/`status`.

Never logged: image bytes, customer message text, enquiry facts, storage
object paths, signed URLs, the API key, or the provider's raw error message.

## Manual validation procedure

This spends tokens on the account's real key, so it is **not** run
automatically. Do it deliberately, on a test conversation.

Preconditions: migrations applied through 048; an `ai_configs` row for the test
account with `provider`, `model`, and a working `api_key`; `is_active = true`;
and a chat-media attachment in the `account-<id>/` folder for a real inbound
image.

1. Send a photo (and ideally two different photos) from the test WhatsApp
   number into a test conversation. Confirm the attachment was mirrored into
   the `chat-media` bucket under `account-<account_id>/inbound/` — legacy
   Meta-hosted media will not analyse.
2. Add an enquiry with a couple of customer-stated facts (e.g. "old sofa and
   some bags") so the context block is exercised.
3. Invoke `analyze_images` from a trusted server-side caller with a
   `ToolExecutionContext` for that account and `{ conversation_id }`. There is no
   HTTP route for it yet, so call `AI_TOOL_REGISTRY.analyze_images.execute(...)`
   from a script or a scratch route; do **not** add a public endpoint.
4. Check the result: `analyzer_id` is `configured_vision_model`; `images[]` has
   one entry per analysed photo with an ordinal and a resolved
   `source_message_id` / `source_media_id`; `observations[]` carry a `kind`, a
   `label`, a 0..1 `confidence`, a `basis`, and resolved `sources`;
   `guarantees` is all-false; and `supplied_context` is echoed separately from
   the observations.
5. Check the honesty signals: `need_more_photos`, `follow_up_questions`,
   `image_quality`, and `uncertainty` should describe the photos honestly,
   including when they are poor.
6. Check that **no reply was sent**: no new `messages` row in the conversation,
   nothing in the Meta conversation, and no outbound call in the server log.
   `analyze_images` is a read tool and cannot send.
7. Check observability: one `ai_tool_call_audit` row for `analyze_images` and
   one `ai_usage_log` row with `mode = 'image_analysis'`; and the operator log
   line carries provider/model/image count/duration/tokens but no content.
8. Negative check (optional): temporarily point the account at a non-vision
   model and confirm the call returns a safe retryable `unavailable` rather than
   an empty or fabricated analysis. Restore the model afterwards.

The automated suite already covers every step above except the live provider
call: `src/lib/ai/image-analysis/vision-analyzer.test.ts` and the production
resolver block in `src/lib/ai/tools/analyze-images.test.ts` mock `fetch`, so no
test reaches a live AI API.

## Known limitations

1. **The vision model is the account's chat model.** There is no separate
   vision model setting. Both shipped defaults are vision-capable, and a
   non-vision model fails safely, but an operator who wants a dedicated vision
   model cannot choose one today. That is a deliberate consequence of reusing
   the existing configuration rather than adding a second one.
2. **Analysis is opt-in per call, not automatic.** Nothing invokes
   `analyze_images` automatically; Objective 10 (orchestrator) owns that, and no
   automatic reply is enabled.
3. **No perceptual deduplication.** Only identical object references are
   collapsed. Two photographs of the same sofa taken seconds apart are two
   images, and an observation of "sofa, count 1" from each is not merged. This
   output is `uncertainty.visual_deduplication: 'identical_media_object_only'`
   and `possible_duplicate_photos`, and downstream consumers must treat counts
   as a lower bound. Perceptual or embedding-based deduplication was
   deliberately not attempted: it needs a business decision about what counts
   as "the same item".
4. **Legacy Meta-hosted media is not analysable.** See the boundary section
   above.
5. **Observations are not persisted.** The result is returned to the caller and
   is not written to any table. Durable storage of analysis results, and any
   link back to the enquiry, is a later decision (and would need a migration).
6. **No orchestrator and no HTTP route.** Nothing calls this tool yet;
   Objective 10 owns that.
7. **No retries.** A provider failure is surfaced, not retried, matching the
   rest of the AI layer.
8. **Limits are constants.** Not operator-configurable in this change.
9. **Volume is a relative unit.** By design, not a gap to be filled by the
   vision layer.

## Tests

`src/lib/ai/image-analysis/{result,media,vision-analyzer}.test.ts` and
`src/lib/ai/tools/analyze-images.test.ts` cover:

- single sofa; mixed room clearance; bags/boxes; garden and construction waste;
  bulky/heavy indicators; a poor-quality photo; an ambiguous item; a
  need-more-photos case;
- multi-image source traceability, and that a source ordinal outside the
  analysed set is rejected;
- that the result carries no price or weight value, and that a provider
  pricing field is rejected as `forbidden_field`;
- valid image, multiple images, cross-account denial, wrong conversation,
  unsupported MIME, content/declared-type mismatch, missing media, empty
  media, too many images, oversized image, total-size limit, arbitrary URL
  rejection, no credential leakage in errors;
- provider boundary: fake analyzer, provider unavailable, timeout,
  cancellation, provider throw, invalid provider result, output-schema
  validation, and that image bytes are not retained in a recorded call.

`vision-analyzer.test.ts` additionally covers the production adapter with a
mocked `fetch`: provider selection for OpenAI and Anthropic, refusal to guess
an endpoint for an unsupported provider, base64 inlining with no URL / path /
account id / message id / key in the payload, the prompt guarantees, context
labelling and bounding, unvalidated pass-through of the provider answer,
truncation refusal, JSON decoding, timeout, caller cancellation, an
already-aborted signal, error sanitization (the provider's message reaches
neither the caller nor the log), the observability payload, and per-account
configuration resolution including the no-config, switched-off, cross-account,
and unreadable-config cases.

The production resolver block in `analyze-images.test.ts` covers the tool wired
the way the registry is: an end-to-end validated observation, several images in
one provider call, `unavailable` with no media read when unconfigured, no
cross-account resolution, rejection of a smuggled price, a smuggled exact
weight, an out-of-range ordinal, and a malformed confidence, the media boundary
still enforced (foreign-account folder, legacy Meta pointer), `account_id`
still refused as input, and proof that the only database write is the
account's own usage row while every HTTP call goes to the provider.

`registry.test.ts` asserts `analyze_images` is in the allowlist, is a
`read` tool with `side_effects: 'none'` and no approval property, and that the
registry still offers no unrestricted query tool.
