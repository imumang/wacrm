# Conversation and enquiry state

Objective 01 adds durable business state for a customer enquiry without
changing WhatsApp transport, automatic replies, quoting, or booking.

## Architecture

`conversations` remains the permanent WhatsApp thread for a contact. The
database already enforces one conversation per `(account_id, contact_id)`, so
putting job state directly on that row would overwrite a completed job when the
same customer returns later.

`enquiries` is therefore a separate account-scoped entity linked to a
conversation. A partial unique index permits history but allows at most one
non-terminal enquiry per conversation. Existing conversations are not
backfilled: their real business state is unknown, and labelling them as new
enquiries would fabricate data. The domain layer creates an enquiry explicitly,
with `new_enquiry` as its initial state — see
[Initial enquiry activation](#initial-enquiry-activation).

Customer name and phone remain canonical on `contacts`. `EnquiryContext` composes
those values with an enquiry when needed; they are not copied into `enquiries`.
The enquiry does not duplicate quote or booking state. Migration 052 later adds
an account-scoped quote entity linked back to the enquiry; booking remains
deferred.

## Workflow

States:

`new_enquiry` → `gathering_information` / `awaiting_photos` /
`ready_for_quote` → `quote_draft` → `quote_sent` → `awaiting_acceptance` →
`booking_requested` → `booked` → `reschedule_requested` / `completed`.

`cancelled` is reachable from any active phase where cancellation is meaningful.
`cancelled` and `completed` are terminal. Deliberate correction loops are
allowed for gathering more information, revising a quote, and returning a
reschedule request to `booked`. Other backward jumps are rejected.

The same transition graph is enforced in TypeScript and by the
`guard_enquiry_write` database trigger. Repository transitions use a
compare-and-set update against the previously read state, preventing stale
concurrent writers from overwriting a newer transition.

## Structured facts

Unknown scalar facts are `NULL`; unknown list facts are also `NULL`. An empty
list means the list is known to contain no entries. `missing_information` is a
typed, non-null list and can explicitly identify facts still required. No
business-required set is guessed because those requirements have not yet been
defined.

Stored facts cover intent, service address/access, property/floor/lift/parking,
items and waste, volume, heavy or special items, photo receipt, preferred date,
preferred time window, and missing information. Input and database rows are
runtime-validated by `src/lib/enquiries/model.ts`.

## Tenancy and audit

- Every application query filters by `account_id`.
- A composite foreign key `(conversation_id, account_id)` prevents cross-account
  links even for service-role writes that bypass RLS.
- RLS allows account viewers to read and agents or above to create/update.
- There is no authenticated delete policy; account/conversation cascades remain.
- `created_at`, `updated_at`, and `state_changed_at` record timestamps.
- `enquiry_state_events` is trigger-written and append-only, recording the
  initial state and every state transition, with `auth.uid()` when available.

## Domain entry points

`src/lib/enquiries/repository.ts` exports explicit, account-scoped functions to
create, retrieve, update facts, and transition an enquiry.

## Initial enquiry activation

A thread has to have business state before anything can reason about it, so the
first genuine customer inbound message creates it. This is deterministic: no
message classification, no intent inference, no AI.

`ensureInitialEnquiryForConversation` in `src/lib/enquiries/repository.ts` is the
whole rule, and it is called from the shared inbound boundary
(`afterInboundInsert` in `src/lib/whatsapp/inbound.ts`) rather than from the Meta
webhook, so any future inbound path inherits it.

**Activation rule.** Create a `new_enquiry` only when the conversation has _no
enquiry rows at all_. Never create a second enquiry because the previous one is
terminal or because no enquiry is currently active. A completed job followed by
"thanks" leaves the thread with its completed enquiry and nothing new; a repeat
job is an explicit business action, not a side effect of someone typing.

That distinction is load-bearing, because the database does _not_ enforce it. The
partial unique index only covers non-terminal rows, so a completed or cancelled
history would happily accept a second insert. The explicit zero-history read is
the only thing preventing a repeat job from appearing out of nowhere.

**Idempotency and race safety.**

- The account-scoped existence read is the fast path and covers terminal-only
  histories.
- `idx_enquiries_one_active_per_conversation` rejects a concurrent second insert
  with a unique violation, because `new_enquiry` is non-terminal. That violation
  is caught and resolved back to the winning row, so two simultaneous first
  deliveries converge on one enquiry rather than surfacing a constraint error.
  Verified against a live database: the second insert fails with 23505 on that
  index and the conversation is left with exactly one row.
- `(conversation_id, account_id)` is a composite foreign key, and the
  conversation is verified to belong to the account before insert, so this holds
  on service-role writes that bypass RLS.

**Trigger scope.** The call sits behind `persistInboundMessage`'s genuine-first-
insert result, which is the whole scope: reactions short-circuit earlier, status
events never reach it, and outbound agent sends are not ingested here. The only
traffic that can create an enquiry is a live customer inbound conversation
message.

**Failure and retry.** Enquiry creation is best-effort. The inbound message row
is already committed when this runs and is the authoritative record of the
delivery, so a failure is logged and swallowed rather than thrown — a rejection
here would make Meta redeliver and duplicate. The log carries a bounded label
(`EnquiryRepositoryError:<code>`), not the driver message, which can echo SQL,
constraint names, and column values. No separate retry mechanism is needed: the
rule keys off "no enquiry history yet", so a later inbound message re-attempts
activation on its own. A conversation whose first message failed therefore ends
up with an enquiry as soon as the customer writes again.

**Creator attribution.** The database requires `created_by_user_id` on insert.
Inbound activation uses the WhatsApp config owner — the same stable account-level
owner the contact and conversation inserts use — because an inbound message has
no single human author.

## Domain entry points (continued)

The remaining functions — create, retrieve, update facts, transition — are used
by the AI business tools and by tests.

## Explicit repeat enquiry action

`createRepeatEnquiry` and the `create_repeat_enquiry` write tool implement the
only repeat-job path. The action requires trusted, account/tool/resource-bound
approval, an actor, correlation ID, idempotency key, and a write-audit sink. It
fails when no enquiry history exists or any non-terminal enquiry is present.

Eligible completed/cancelled history is preserved unchanged. The new row starts
at `new_enquiry` with every fact unknown; old address, postcode, item, quote, and
booking information is not copied. Migration 046 stores immutable action
identifiers and enforces account-scoped idempotency, while the existing partial
unique index prevents concurrent duplicate active enquiries. Trigger-written
state history records the new enquiry's initial state.

## Pre-migration limitation

A conversation created before migration 045 with zero enquiry rows is
indistinguishable in deterministic data from a genuine first-time conversation
whose first enquiry has not yet been activated. The system therefore does not
guess. It does not inspect message text, apply heuristics, or invoke AI
classification to label such a thread as repeat work. `create_repeat_enquiry`
rejects zero-history conversations until a separate migration/reconciliation
decision is made.
