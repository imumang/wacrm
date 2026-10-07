# Canonical quote record and decision lifecycle

Migration `052_quote_record_lifecycle.sql` adds the operational source of truth
for commercial proposals. It does **not** calculate a price and does not send a
message.

## Boundaries

These remain different facts:

1. an AI/hybrid recommendation (`origin` plus its immutable revision);
2. a human approval (`approved_at`, `approved_by_user_id`);
3. a customer-facing proposal (`presented_at`, `presented_by_user_id`);
4. the customer's decision (`customer_decision` and decision attribution);
5. the final amount collected (`historical_case_facts.final_amount_collected`).

`quotes` intentionally has no final-collected field. A quoted £300, accepted
£300 and collected £350 remain independently queryable. The difference does
not imply the quote was wrong; scope belongs to the outcome domain.

`deals.value` is not used. It remains generic pipeline value with no proven
quote semantics.

## Money

Amounts are integer **minor units** in `BIGINT`, bounded to values the
TypeScript layer handles safely. `GBP 30000` means £300.00. APIs accept integers
only, never floating-point major units.

- `fixed`: `fixed_amount_minor` is set; range columns are null.
- `range`: `range_min_minor` and `range_max_minor` are set; fixed is null.

Unknown is null, not zero. A real range stays a range—no midpoint is stored.

## Lifecycle and customer decision

Workflow and customer outcome are separate dimensions.

`draft` / `awaiting_approval` → `approved` → `presented`

Terminal workflow states are `expired`, `withdrawn`, and `superseded`.
AI/hybrid proposals begin at `awaiting_approval`; manual/imported proposals
begin at `draft`. They cannot start approved or presented.

Customer decision begins as `unknown` and is recorded once, only on a
presented quote: `accepted`, `rejected_price`, `found_better_price`,
`no_response`, `cancelled_by_customer`, or `other_lost`.

A follow-up revision may supersede a decided presented quote. The old decision
stays immutable on that revision and the new proposal starts `unknown`; case
classification follows the newest revision rather than carrying a rejection
forward into a new negotiation.

`no_response` is not rejection. A competing price is commercial evidence, not
proof of the objectively correct job price.

## Revisions and operator feedback

Commercial terms are immutable. Changing an amount, range, currency,
assumption, exclusion, note, origin, or provenance creates a new revision.
`quote_create_revision` locks the enquiry lineage, supersedes the old record,
and creates `revision_number + 1` in one transaction. A partial unique index
allows one current quote per enquiry. Concurrent attempts serialize: one wins
and stale attempts conflict.

`supersedes_quote_id`/`superseded_by_quote_id` preserve the chain. A human
revision of an AI/hybrid proposal also sets `recommendation_quote_id`, so future
evaluation can compare recommendation and approved/customer-facing value.

Structured override reasons are supported but optional while the business
decision “require reason for operator quote changes?” remains unresolved.
Labels are descriptive feedback, not claims that one factor was the objectively
correct price cause. `other` and a bounded note support extension.

Approving an AI suggestion unchanged adds human approval to that same immutable
proposal. Modifying it creates a manual revision referencing the suggestion.
Withdrawing it records rejection of the proposal without presenting it.

## Origin and historical provenance

Origins are `manual`, `ai_suggested`, `hybrid_engine`, and
`imported_historical`. Imported records must carry `source_reference` and
`source_observed_at`. Missing decisions remain `unknown`; missing outcomes
remain absent. No legacy WhatsApp bulk reconstruction or message-price
extraction is part of this model.

## Audit and idempotency

`quote_events` is trigger-written and append-only. It records creation,
approval, presentation, customer decision, expiry, withdrawal and supersession
with actor, timestamp, state transition and idempotency key. It contains no
message/customer content and does not duplicate immutable quote terms.

Every write requires a bounded idempotency key. Creation has an account-scoped
unique key; transition keys are account-scoped; revision replay returns the
already-created successor. The revision RPC and database constraints are the
concurrency boundary, not a read-before-write assumption.

## Domain and operator API

`src/lib/quotes/` exposes explicit operations only: `createManualQuote`,
`createQuoteSuggestion` (domain-only; no AI tool/caller is added),
`approveQuote`, `reviseQuote`, `markQuotePresented`, `recordQuoteDecision`,
`withdrawQuote`, `expireQuote`, `getCurrentQuote`, and `getQuoteHistory`.
There is no arbitrary update method.

Operator JSON routes:

- `GET /api/quotes?enquiry_id=...`
- `POST /api/quotes` (`create_manual` / `create_imported`)
- `POST /api/quotes/[quoteId]/actions`

Writes require agent or higher; manual historical entry is admin-gated.
`Idempotency-Key` is required. Account and actor come from `requireRole`; bodies
cannot select an account. The caller's session client and explicit account
predicates both apply. No route sends WhatsApp messages, and no AI tool can
approve, present, accept, or send a quote.

## Historical learning compatibility

Canonical `quotes` are operational truth going forward. Historical-case facts
such as `ai_suggested_amount`, `human_approved_amount`,
`customer_facing_quote_amount`, and `quote_decision` remain readable for old
cases and immutable snapshots; migration 052 does not rewrite them.

When canonical quotes exist for an enquiry:

- evidence classification uses quote history instead of legacy quote-shaped
  facts;
- finalization snapshots a bounded compact tail of quote revisions into
  `commercial` and reports the total/truncation; the full immutable history
  remains in `quotes` and `quote_events`;
- lost-outcome capture records the decision on the presented quote and does not
  add a duplicate `quote_decision` fact;
- `final_amount_collected` still comes only from completed-job capture.

The future evaluation axes remain distinct: prediction → human approval →
customer-facing proposal → decision → completed outcome.

## Security invariants

- Composite account/enquiry and account/self-reference foreign keys.
- RLS: account members read; agents write; no authenticated delete.
- Terms and identity are immutable; only explicit transitions mutate.
- Customer decisions are one-way and actor-attributed.
- Events are append-only and trigger-written.
- A finalized historical case rejects later quote attachment.
- AI/hybrid origin cannot begin approved or customer-facing.
- The quote domain constructs no service-role client.

## Deferred

Price calculation, retrieval, confidence, model/rule versions, auto-send,
booking, the AI orchestrator and the full operator UI remain out of scope.
