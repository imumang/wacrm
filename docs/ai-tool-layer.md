# AI business tool layer

Objective 02 begins with a narrow, provider-neutral business-tool boundary,
the `get_customer` and `get_conversation` read tools, and the deliberately
separate `create_repeat_enquiry` write tool. It does not add an LLM integration,
expose a database query tool, or connect tools to draft/auto-reply features.

## Architecture

The implementation lives in `src/lib/ai/tools`:

- `contract.ts` defines the common execution contract and structured errors.
- `get-customer.ts` implements `get_customer`.
- `get-conversation.ts` implements `get_conversation`.
- `analyze-images.ts` implements `analyze_images`. Its media-retrieval
  boundary, provider abstraction, production vision adapter, observation
  schema, and limits live in `src/lib/ai/image-analysis/`; see
  [`image-analysis.md`](./image-analysis.md).
- `create-repeat-enquiry.ts` implements `create_repeat_enquiry`.
- `audit.ts` persists the metadata-only audit trail.
- `context.ts` builds a tool execution context from trusted auth state.
- `index.ts` exports the explicit tool allowlist.

Tools are plain TypeScript objects and can be called by application code,
tests, a future orchestrator, or another trusted server-side caller without an
LLM. Provider-specific function schemas can be adapters over these contracts;
provider concerns do not enter the business tools.

Every tool has one wrapped `execute(context, input)` method and returns:

```ts
type ToolResult<T> =
  | { ok: true; data: T; correlation_id: string }
  | {
      ok: false;
      error: {
        code:
          | 'not_found'
          | 'forbidden'
          | 'invalid_input'
          | 'conflict'
          | 'unavailable'
          | 'internal';
        message: string;
        retryable: boolean;
      };
      correlation_id: string;
    };
```

Unknown exceptions are collapsed to a generic `internal` error. Database
details, stack traces, credentials, and secrets are not returned.

## Read/write contract boundary

`defineReadTool(name, handler)` always produces `access: 'read'` and
`side_effects: 'none'`. It has no option that can be flipped to create a write.
`defineWriteTool(name, { side_effects, handler })` is a separate factory and
declares a non-empty side-effect list, mandatory explicit approval,
account/tool-scoped idempotency, required account and actor identity, mandatory
audit handling, and caller-controlled cancellation/timeout semantics.

This keeps the existing read guarantees intact and makes adding a side effect a
visible code-review event rather than a changed boolean.

## Execution context

`ToolExecutionContext` supplies:

- a Supabase client;
- the trusted `account_id` scope;
- actor identity (`user`, `api_key`, or `system`);
- a required `correlation_id`;
- an optional `AbortSignal` cancellation boundary;
- a metadata-only audit recorder (best-effort for reads, mandatory for writes);
- optional bounded `audit_metadata` (requested limits and similar shapes).

`WriteToolExecutionContext` additionally requires an `idempotency_key`, an
explicit `ToolApproval`, and a metadata-only audit recorder. Approval is supplied
by trusted server-side caller context, never tool/model input. It binds the
approval ID and approver to one account, tool, idempotency key, and resource.
Missing, malformed, or mismatched approval fails closed before the handler runs.
This is the smallest explicit approval boundary for the first write tool; it is
not represented as the full Objective 09 policy engine.

The account is intentionally not accepted from model-controlled tool arguments.
A cookie-authenticated caller should build the context from
`getCurrentAccount()`/`requireRole()`. A trusted webhook or future orchestrator
may use a service-role client, but must fix `account_id` from its authenticated
server-side context. The tools never construct or expose a service-role client.

## Trusted context construction

`src/lib/ai/tools/context.ts` is the single adapter from existing
authenticated state to a `ToolExecutionContext`:

```ts
createToolExecutionContext(
  { kind: 'session', context: await requireRole('agent') },
  { correlation_id: 'run-42', signal: AbortSignal.timeout(5_000) }
);

createWriteToolExecutionContext(
  { kind: 'api_key', context: await requireApiKey(request, 'messages:send') },
  { idempotency_key, approval }
);
```

The three accepted authorization sources are the cookie-session
`AccountContext`, the API-key `ApiKeyContext`, and an explicit `system`
variant for a trusted caller that already holds a client scoped to one
account. From those it derives `account_id`, the actor, and the client;
generates a `correlation_id` when the caller did not supply one; and attaches
the durable audit sink. It accepts no account, role, or actor parameter, so a
request body, query string, or model argument cannot widen the scope, and it
constructs no Supabase client — a caller that wants the audit trail written by
a different trusted client passes that client as `audit_db`. The returned
object is frozen and contains only `db`, `account_id`, `actor`,
`correlation_id`, optional `signal`, `audit`, and optional `audit_metadata`.
The adapter holds no model, provider, or prompt concept.

The audit recorder receives tool name, access, declared side effects, account,
actor, correlation ID, timing, outcome, retryability, safe error category, and
write approval / idempotency identifiers. It never receives tool input or
customer output. A committed repeat action also retains approval, correlation,
and idempotency identifiers on the enquiry itself.

## Durable audit trail

Migration `047_ai_tool_call_audit.sql` adds `ai_tool_call_audit`: one row per
tool invocation, account-scoped by a foreign key to `accounts`, with an
immutability trigger and read/append RLS policies only. Columns are the
account, tool name, access, declared side effects, actor type and identifier,
correlation ID, `started_at`, `finished_at`, `duration_ms`, outcome, safe
error code, retryable flag, approval and idempotency identifiers, and an
optional bounded `execution_metadata` object.

The row is metadata only. Tool input, tool output, customer names and phones,
message text, enquiry facts, media references, secrets, and database errors or
stacks are never written: the contract layer passes no payloads to the audit
hook, and `audit.ts` additionally refuses anything it does not recognise.
Identifiers must be UUIDs or bounded tokens, side-effect tokens are bounded,
and `execution_metadata` is restricted to an allowlist of numeric/boolean keys
(`requested_message_limit`, `truncated`, and similar execution shapes). A
string cannot enter the metadata bag at all, so customer content has nowhere
to hide. Audit-row identity (`account_id`) always comes from the execution
context, which the context adapter fixed from authorization state.

### Audit failure policy

The policy differs by access, and both branches are explicit:

- **Read tools: best effort, never silent.** A read is side-effect free, so an
  audit-storage outage must not turn a successful customer lookup into an
  error. The contract logs the failed write with account, tool, correlation
  ID, and outcome — metadata only, never the database error — so the failure
  is alertable.
- **Write tools: fail closed.** An approved side effect whose audit row is
  missing is unauditable, so a sink failure returns a retryable `unavailable`
  result. The caller replays with the same idempotency key, which is safe.

The durable sink itself never swallows an error: it throws a sanitized,
retryable `unavailable` and does not log the underlying database message,
which may carry schema or connection detail. The caller (contract layer or a
direct caller) decides whether that is fatal.

Callers can pass `AbortSignal.timeout(milliseconds)` when they need a timeout.
Cancellation returns retryable `unavailable`. A cancelled write may already
have committed because a PostgREST promise cannot be rolled back by an
`AbortSignal`; callers must retry with the same idempotency key.

## `get_customer`

Input:

```ts
interface GetCustomerInput {
  contact_id?: string;
  conversation_id?: string;
}
```

At least one identifier is required. When both are supplied, they must resolve
to the same account-scoped customer. `account_id` is provided by the execution
context, not by the model.

The output includes only canonical business context:

- contact ID and conversation ID when one exists;
- name, phone, and WhatsApp identity fields;
- address/postcode from the current active enquiry only;
- bounded tags and recent notes;
- the active enquiry and up to three recent completed/cancelled enquiries;
- source/freshness and explicit output-bound metadata.

Unknown scalar values are `null`; unknown enquiry lists retain the enquiry
model's `null` semantics. A BSUID-only contact's blank stored phone is returned
as `null`. Notes are limited to five and 1,000 characters each, tags to 20,
historical enquiries to three, enquiry lists to 20 items, and enquiry strings
to 500 characters. Truncation is reported in the output.

No email, profile, account, credential, provider configuration, or unrelated
CRM data is returned. Deals are not treated as quotes or bookings. A canonical
quote domain now exists, but this original read contract has not been widened
to return it; booking/job entities remain absent.

## `get_conversation`

Input:

```ts
interface GetConversationInput {
  conversation_id: string;
  recent_message_limit?: number; // default 20, allowed range 1..50
}
```

The output contains:

- conversation ID and CRM thread status;
- a minimal customer/contact reference;
- recent messages in chronological order;
- direction, sender type, content type, timestamp, and delivery status;
- bounded text plus media reference/MIME metadata (never media bytes);
- reply/interactive references and the canonical `ai_generated` marker;
- the active enquiry's workflow state, structured facts, and
  `missing_information`;
- up to 20 canonical `enquiry_state_events`, in chronological order, across
  this conversation's enquiry history;
- freshness and context-window metadata.

The database query reads newest first using deterministic
`created_at DESC, id DESC`, fetches `limit + 1`, records whether earlier
messages exist, and reverses the retained rows for chronological output. Message
text is limited to 2,000 characters. Media references longer than 2,048
characters are omitted and marked truncated. Media-only messages remain in the
window with `content_text: null` and media metadata.

The durable enquiry facts are loaded independently of message truncation, so a
long conversation does not discard current business state. No LLM summary is
created. Enquiry transitions use deterministic `changed_at DESC, id DESC`
selection before chronological presentation; the output reports whether older
events were omitted. Event attribution remains explicitly `null` when the
canonical trigger event has no authenticated user.

There is no separate canonical outstanding-question model; callers should use
`missing_information`. Quote/booking status is omitted from this original tool
contract. Quote data is available through the explicit quote domain; booking
has no canonical model. Last human/AI action summaries are also omitted: `ai_generated`
identifies generated messages, but the current sender fields do not reliably
distinguish every deterministic automation from a human action.

## `analyze_images`

A read tool with `access: 'read'` and `side_effects: 'none'`, registered in the
allowlist alongside the other business tools. It resolves customer-uploaded
images from canonical WACRM message records, hands the bytes to an injected
provider-neutral `ImageAnalyzer`, and returns validated structured
observations. It calculates no price, estimates no weight, and infers no
hidden property or access detail.

Full documentation — contract, media-retrieval/security boundary, observation
schema, limits, source traceability, uncertainty handling, and known
limitations — is in [`image-analysis.md`](./image-analysis.md). In summary:

- Input is `conversation_id` plus either `message_ids` (explicit WACRM message
  ids) or `image_limit` (newest images, default 3), and an optional
  `include_context`. The account comes from the execution context; media is
  never referenced by URL, path, or provider media id, and any other key is
  rejected.
- Media is read only from the `chat-media` bucket through an object path
  derived from the message row's own `media_url` and verified to begin with
  `account-<account_id>/`. No URL is ever fetched, so there is no SSRF surface
  and no credential is produced or consumed.
- Every observation, ambiguity, and quality issue carries resolved
  `source_message_id` / `source_media_id` references. A provider addresses
  images only by ordinal and cannot name a message, path, or URL.
- The analyzer is resolved **per account** from that account's existing
  `ai_configs` row through the same `loadAiConfig` the draft button and the
  inbound auto-reply use, and drives the production vision adapter for the
  account's configured provider and model. An account with no usable
  configuration gets a structured, non-retryable `unavailable` before any media
  is read. There is no second key column and no client-visible configuration.
  The full path is also exercised offline in tests through
  `createFakeImageAnalyzer`.

## `create_repeat_enquiry`

Input is only `{ conversation_id }`. The trusted write context carries the
account, actor, correlation ID, idempotency key, and approval. Approval must be
for resource `{ type: 'conversation', id: conversation_id }`.

The tool creates one blank `new_enquiry` only when the account-scoped
conversation already has enquiry history and no enquiry is active. Completed
and cancelled histories are eligible; any other workflow state blocks the
write. It never copies prior facts, address, postcode, quote state, or booking
state, and historical rows are not changed.

Migration 046 stores immutable `repeat_action_idempotency_key`,
`repeat_action_approval_id`, and `repeat_action_correlation_id` values on the
new row. A partial unique index on
`(account_id, repeat_action_idempotency_key)` makes the same approved action
replay-safe. The existing one-active-enquiry index prevents two concurrent
actions from opening two jobs. On a same-key race, the loser reloads and returns
the winning row with `created: false`; a different-key race is a `conflict`.
The existing trigger appends the initial `null -> new_enquiry` state event.

## Tenant isolation and authorization

- Each parent lookup explicitly filters by `account_id`.
- A conversation is account-verified before reading its child messages.
- A contact is account-verified before reading child contact-tag joins.
- Notes, contacts, tags, conversations, and enquiries use explicit account
  filters even when RLS is active.
- Unknown and foreign resource IDs both return `not_found`, preventing resource
  enumeration across accounts.
- Existing RLS remains the second boundary for user-session clients.
- Read tools perform no inserts, updates, deletes, RPC writes, external calls,
  or Meta API operations.
- `create_repeat_enquiry` explicitly scopes every conversation/enquiry read and
  insert by account; the composite conversation/account foreign key and RLS are
  database backstops.
- No tool performs a Meta API operation or sends a message.

## Current limitations

- The tools are not yet called by an AI orchestrator or HTTP route. The text
  generation path is live (inbox draft, inbound auto-reply); the business
  tools, including `analyze_images`, are not yet reachable from a route.
- Read-tool audit is best effort: a sink outage leaves a gap in the trail for
  that invocation, visible in the operator log. Write-tool audit is mandatory.
- The approval object is an explicit fail-closed boundary, not the complete
  policy/risk engine planned in Objective 09.
- `analyze_images` uses the account's configured chat model for vision. Both
  shipped defaults are vision-capable and a non-vision model fails safely, but
  there is no dedicated vision-model setting. See
  [`image-analysis.md`](./image-analysis.md#vision-model-selection).
- Quote, booking, and draft-reply AI tools are intentionally absent. The
  server-side quote domain grants no AI approval, presentation, acceptance, or
  send authority.
- The audit trail is retained for the account lifetime; there is no retention or
  export policy yet.
