# Historical cases

Objective 01 of the AI Learning System roadmap: the canonical historical
"case" record that future similarity retrieval, quote estimation, confidence
calculation, evaluation, and learning will consume.

> **Objectives 02 and 03 are now implemented.** The outcome side of
> this document — finalization, the completion / lost-business capture
> workflow, and the capture-only fact keys — is described in
> [job-outcome-capture.md](job-outcome-capture.md). The historical
> import side — source identity, import quality, dry-run, idempotency
> and conflict handling — is described in
> [historical-import.md](historical-import.md). The vector-memory
> side — embedding kinds, the price-leakage invariant, and
> model/version compatibility — is described in
> [vector-memory.md](vector-memory.md). Where any of those documents
> would disagree with this one, they are newer.

A case is **not** a second CRM. It is the learning-facing view of one
enquiry/job lifecycle, and it stores only what WACRM cannot reconstruct from
a canonical entity later.

- Migration: `supabase/migrations/049_historical_cases.sql`
- Domain layer: `src/lib/historical-cases/model.ts`,
  `src/lib/historical-cases/repository.ts`
- Schema verification: `supabase/ci/verify-schema.sql`,
  `supabase/ci/verify-historical-import.sql`

## What already exists, and what was reused

Everything operational already has a home, and none of it was copied:

| Learning fact                                                                                                                                                     | Where it lives                                        | Why it was not copied                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Conversation, contact, name, phone                                                                                                                                | `conversations`, `contacts`                           | Operational truth; the case holds `conversation_id` and `contact_id` references only.                             |
| Job identity and lifecycle state                                                                                                                                  | `enquiries.workflow_state`                            | The case is keyed by `enquiry_id`, one case per enquiry.                                                          |
| Workflow history                                                                                                                                                  | `enquiry_state_events`                                | Already append-only and trigger-written.                                                                          |
| Source images / message text                                                                                                                                      | `messages`                                            | Chat stays in chat. A case references a message id, never its content.                                            |
| Postcode, address, property type, floor, lift, parking, access constraints, item descriptions, waste type, estimated volume, heavy/special items, photos received | `enquiries` columns                                   | See [Provenance](#provenance) — the case records _where each of these came from_, not a second copy of the value. |
| AI spend and tool audit                                                                                                                                           | `ai_usage_log`, `ai_tool_call_audit`                  | Already scoped and immutable.                                                                                     |
| Image observations                                                                                                                                                | Produced by `analyze_images`, **not persisted** today | Stored as a `image_analysis` snapshot at finalization (Objective 02).                                             |

`deals` (pipeline value) is deliberately **not** treated as a quote entity.
It is a generic CRM deal row, not a quote with an approval and a customer
decision, and reusing it would invent a quote lifecycle that does not exist.
Migration 052 therefore adds a separate canonical `quotes` domain rather than
widening `deals`; see `docs/quote-domain.md`.

## Architecture

Three tables, three jobs.

```
enquiries ──1:1──> historical_cases ──1:n──> historical_case_facts
                         │
                         └──1:n──> historical_case_snapshots
```

### `historical_cases` — identity, references, classification, eligibility

One row per enquiry, enforced by `historical_cases_one_per_enquiry`. It holds:

- `enquiry_id`, `conversation_id`, `contact_id` — references, each protected
  by a composite `(id, account_id)` foreign key so a service-role write cannot
  cross accounts or contradict the enquiry it claims to come from.
- `source_kind` (`live_enquiry` / `imported_historical`).
- `case_state` (`open` / `finalized`) and `finalized_at`.
- `completed_at` — when the job actually completed. This is deliberately not
  derived from the enquiry on read: a terminal `cancelled` enquiry cannot
  answer that question, and "completed" is a learning fact, not a workflow
  state.
- `evidence_quality_tier`, `evidence_rule_version`, `evidence_reasons`,
  `evidence_classified_at` — see [Evidence quality](#evidence-quality).
- `learning_eligibility`, `learning_exclusion_reason`,
  `learning_eligibility_basis` — see [Learning eligibility](#learning-eligibility).

Identity fields (`id`, `account_id`, `enquiry_id`, `conversation_id`,
`contact_id`, `source_kind`, `created_at`) are immutable in a database
trigger, and once `finalized_at` is set the whole row is frozen.

### `historical_case_facts` — learning-only facts with per-value provenance

One row per `(case_id, fact_key)`. This is where the roadmap's fact list lives
when the canonical entity has nowhere to put it.

**The trade-off.** Provenance belongs to a value, not to a case, and there are
three ways to carry that:

1. _A `provenance` column next to every scalar on a wide case table._ Cheapest
   to query, but every new fact then needs a value column **and** a provenance
   column **and** a constraint, and it forces a migration to add any fact at
   all. With ~25 learning facts that is 50 columns of schema churn before the
   quote, booking, and outcome objectives have even defined their fields.
2. _Full EAV: one table per fact, one row per observation._ Maximum fidelity,
   unbounded flexibility, and no possible type safety. It also moves every
   business rule into query glue and makes "did we ever record a final amount?"
   an unbounded scan.
3. _A closed key vocabulary with one typed row per key._ What is implemented.

Option 3 was chosen because it gets the property that actually matters —
provenance is per value — without the schema churn of (1) or the loss of type
safety of (2). The vocabulary is **closed**: a key that is not in
`historical_case_fact_kind` (SQL) or `historicalCaseFactKind` (TypeScript) does
not exist. Adding a fact is an explicit, reviewed change to both places, which
is the point: a learning dataset should not grow new columns because a prompt
invented one.

Two kinds of key:

- **Canonical keys** (`customer_intent`, `postcode`, `address`,
  `property_type`, `floor`, `lift_available`, `parking`,
  `access_constraints`, `item_descriptions`, `waste_type`,
  `estimated_volume`, `heavy_special_items`, `photos_received`) annotate a
  column that already exists on `enquiries`. They carry a **provenance and no
  value**. That is the cheapest way to answer "was this postcode
  customer-stated or operator-entered?" without copying the postcode into a
  second table that could then drift out of sync.
- **Captured keys** originally held values with no canonical home. Migration
  052 adds canonical `quotes`; the quote-shaped keys remain compatibility data
  for pre-052 cases and snapshots, while new operational quote evidence comes
  from the quote domain. Payment, booking and completed-job entities still do
  not exist.

Captured keys, by area:

| Area             | Keys                                                                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enquiry / access | `service_type`, `carry_distance_metres`, `dismantling_required`                                                                                                                  |
| Waste / items    | `item_count`, `estimated_load_units`, `actual_load_units`, `actual_disposal_weight_kg`                                                                                           |
| Operations       | `travel_distance_km`, `travel_time_minutes`, `crew_count`, `estimated_labour_minutes`, `actual_labour_minutes`                                                                   |
| Commercial       | `ai_suggested_amount`, `human_approved_amount`, `customer_facing_quote_amount`, `quote_decision`, `final_amount_collected`, `quote_adjustment_amount`, `quote_adjustment_reason` |
| Outcome          | `outcome_no_show`, `final_operational_outcome`, `actual_dismantling_required`, `scope_changed`, `scope_change_type`, `scope_change_reason`, `final_job_notes` |

Objective 02 (migration 050) added the capture-only keys:

| Area             | Keys                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------- |
| Timing           | `arrival_at`, `departed_at` (a `timestamp` value kind)                                   |
| Outcome          | `final_operational_outcome`, `actual_dismantling_required`, `scope_change_type`           |

`quote_decision` also gained the lost-business values
`rejected_price`, `found_better_price`, `no_response`,
`cancelled_by_customer` and `other_lost`. See
[job-outcome-capture.md](job-outcome-capture.md).

Every scalar is nullable. `null` means _unknown_, never zero — an unknown load
is not a small load.

`image_observed` facts must name both `source_message_id` and
`source_media_id`, enforced by a CHECK constraint. That is what keeps
"the model saw a sofa in a photo" from becoming an unfalsifiable label: it
always points back at a specific WACRM record.

### `historical_case_snapshots` — immutable learning truth

Append-only, payload-bounded (16 KB object), with a `source_version` recording
what produced it. Today only `evidence_classification` snapshots are written,
by every reclassification. `enquiry_facts`, `image_analysis`, `commercial`, and
`outcome` are reserved for finalization (Objective 02).

Snapshots cannot be updated, and cannot be deleted while their case still
exists; only the account/case cascade removes them.

## Canonical reference vs snapshot

The rule:

> A canonical entity is current operational truth.
> A snapshot is immutable learning/training truth at a particular lifecycle
> point.

**Referenced, never snapshotted (yet):** contact identity, conversation,
enquiry workflow state and its event history, messages and media.

**Snapshotted at finalization:** the enquiry fact set as it stood when the job
closed, validated image observations, canonical quote revisions (or legacy
commercial facts when no quote exists), and the outcome.
That is the point at which the operational record stops being the answer and
the training example becomes the answer.

Nothing is snapshotted eagerly. A case in `new_enquiry` costs one row.

**When does a case become immutable?** At `finalized_at`, set explicitly.
Nothing finalizes automatically in this objective — see
[Creation and finalization](#creation-and-finalization). The guards are already
in place (frozen case row, frozen facts, append-only snapshots), so enabling
finalization later is a domain method, not a migration.

Historical learning therefore stays reproducible even if a customer later
corrects their phone number, an operator re-types the item list, or an
enquiry's postcode is fixed: the snapshot is what a training example was
actually built from.

## Evidence quality

Six tiers plus an explicit **unclassified** state. `null` tier is a finding, not
an absence: `evidence_classified_at` is set and `evidence_reasons` explains
why the case could not be placed.

| Tier | Meaning                                                                   | Evidence required                                                                                          |
| ---- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| A    | Completed job with a trustworthy final outcome                            | `completed_at` set **and** `final_amount_collected` with `confirmed_outcome` provenance                    |
| B    | Accepted quote, final outcome incomplete                                  | `quote_decision = accepted` **and** the job has not completed                                              |
| C    | Human-issued quote with a known customer decision, no trustworthy outcome | `quote_decision = accepted` **and** the job completed **and** no confirmed final amount                    |
| D    | Human-issued quote, outcome unknown                                       | `human_approved_amount` or `customer_facing_quote_amount` **and** no decision                              |
| E    | AI suggestion only                                                        | `ai_suggested_amount` with `ai_suggested` provenance, **and** no human quote, **and** no confirmed outcome |
| F    | Rejected or abandoned                                                     | No confirmed outcome, **and** the enquiry was cancelled or the business was lost for a recorded reason      |
| —    | Unclassified                                                              | Nothing above is satisfied, or the evidence conflicts                                                      |

Derivation is a pure, deterministic function
(`classifyHistoricalCaseEvidence`), and the same necessary conditions are
re-checked inside the database by
`public.historical_case_evidence_supports_tier`, which re-reads the case's own
facts. A service-role write therefore cannot claim a tier it has not earned.

**Deviation from the roadmap wording, stated deliberately.** The roadmap
phrases C as "human-issued quote with known customer decision". Once a decision
_and_ an outcome can both be recorded, that phrase overlaps A, B and F, and an
exclusive ladder is impossible under that wording. C is therefore reserved for
the one remaining state: the decision is known (accepted) and the job is marked
complete, but nobody captured the final amount — a real and distinguishable
data state, and a useful one for the learning pipeline to measure against.

**No tier is reachable by omission.** Every tier requires positive evidence of
its own. A case with only descriptive facts (items, access) stays unclassified
rather than being filed as a rejected job.

**Conflicting evidence is unclassified, not resolved.** A cancelled enquiry
with a confirmed outcome is reported as a conflict for a human. Guessing here
is how a dataset becomes untrustworthy.

**Six lost decisions, one tier.** Objective 02 split `rejected` into
`rejected_price`, `found_better_price`, `no_response`,
`cancelled_by_customer` and `other_lost`. They all reach F, because none
describes a job that happened — but they do not collapse together:
`HistoricalCaseClassification.quote_decision` carries the decision, and
each value records its own reason in `evidence_reasons`, stating in its own
words that the case is not a completed-job price. See
[job-outcome-capture.md](job-outcome-capture.md).

`historicalCaseLearningPopulation` names the five populations a training
pipeline must draw from separately, as a pure function of a classification
the case already carries. An operator exclusion wins over the tier, so an
excluded tier-A case cannot be recovered by filtering on evidence.

## Provenance

| Class                 | Meaning                                                                            |
| --------------------- | ---------------------------------------------------------------------------------- |
| `customer_stated`     | The customer said it, in the conversation                                          |
| `operator_entered`    | A person typed it into WACRM                                                       |
| `image_observed`      | A validated observation from an analysed photo, with a source message and media id |
| `system_derived`      | Computed by WACRM itself                                                           |
| `imported_historical` | Came in from a historical import (Objective 03)                                    |
| `ai_suggested`        | Produced by a model. A prediction.                                                 |
| `confirmed_outcome`   | Observed after the job, and only for facts that can be known after the job         |

`ai_suggested` is the reason this is not just "who typed it": a typed fact and
a predicted fact are not the same kind of evidence.

Provenance rules, enforced in both layers:

- `confirmed_outcome` is only allowed on post-job **measured** keys
  (`final_amount_collected`, `actual_load_units`, `actual_disposal_weight_kg`,
  `actual_labour_minutes`, `arrival_at`, `departed_at`,
  `scope_change_reason`, `final_job_notes`). Objective 02 kept it off
  `crew_count`, `scope_change_type` and `final_operational_outcome`:
  those are things a person asserts about a day that already happened, and
  `operator_entered` is their honest provenance.
- `ai_suggested` is **forbidden** on any confirmed-outcome key, any
  human-issued quote key, any customer-decision key, and any outcome key
  (`HISTORICAL_CASE_AI_FORBIDDEN_KEYS`).
- `ai_suggested_amount` **requires** `ai_suggested` provenance.
- `image_observed` requires a source message and a source media id.
- A stored timestamp must be an ISO-8601 instant with a timezone
  designator. "08:00 on site" is not an instant, and a dataset that
  cannot tell it apart from "08:00 UTC" cannot derive a labour duration
  from it.

## AI feedback-loop protection

The locked decision is "no self-training feedback loop from AI quote to
training truth". Three mechanisms enforce it, in order of how early they stop
the mistake:

1. **Vocabulary.** There is no fact key that means "the price the customer
   paid" other than `final_amount_collected`, and it cannot be written with
   `ai_suggested` provenance. A model cannot propose a fact that means its own
   output was correct.
2. **Evidence tiers.** Tiers A and B require a confirmed outcome or a recorded
   customer decision. An AI suggestion alone reaches at most E, and the
   database re-derives the requirement from the case's facts on every tier
   write.
3. **Separate fields.** `ai_suggested_amount`, `human_approved_amount`,
   `customer_facing_quote_amount`, `final_amount_collected`, and
   `quote_decision` are five distinct facts with five distinct provenances.
   "What the model said", "what a person approved", "what the customer was
   told", "what the customer decided", and "what was actually collected" can
   never collapse into one column.

Covered by tests in `model.test.ts` and `repository.test.ts`, and by the
row-level assertions reproduced in `supabase/ci/verify-schema.sql`.

## Learning eligibility

An operator-owned decision with three states:

| State      | Meaning                                             |
| ---------- | --------------------------------------------------- |
| `pending`  | The default. Trains nothing until somebody decides. |
| `included` | May be used as model-training evidence.             |
| `excluded` | Withheld from training, with a reason.              |

Reasons: `incomplete`, `ambiguous`, `bad_data`, `outlier`, `operator_excluded`,
`privacy_deletion`, `test_data`. An exclusion requires a reason and a basis
(`operator`, `system_rule`, `import_policy`); an exclusion without a reason is
rejected in both TypeScript and by a CHECK constraint.

**Exclusion never deletes.** The case stays readable as history and stays
available for retrieval; it simply stops being training evidence. That makes an
exclusion reversible, auditable, and reversible-after-a-mistake, and it is why
a privacy request can withhold a case without destroying the audit trail around
it.

Eligibility is deliberately **not** derived from the evidence tier. Tiers
describe how strong the evidence is; eligibility is a decision. Deriving one
from the other would make a privacy or test-data exclusion impossible to
express.

### Retrieval and training are different questions

They are different queries, not one flag read twice:

- `listTrainingEligibleCases` — cases explicitly `included`. Tier is _not_
  part of the filter; hiding an included case would make the flag a lie.
- `listRetrievalCases` — classified cases that are not `excluded`, optionally
  floored at a minimum tier. A `pending` case with good evidence is a
  legitimate comparable; what it must never become is training truth without a
  decision.

There is no stored "retrieval eligible" column, because the rule belongs to
the query that has a reason for it, not to the row.

## Repository API

Narrow and account-scoped by construction. There is no generic `search()`, no
caller-supplied filter object, and no way to read another account's data.
Future similar-job retrieval is expected to consume a deliberate service here,
not to run SQL a prompt influenced.

| Function                                                      | Purpose                                                                                                                                     |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `ensureHistoricalCase`                                        | Get-or-create the one case for an enquiry; derives conversation and contact from canonical rows and adopts the winner of a lost insert race |
| `getHistoricalCase` / `getHistoricalCaseByEnquiry`            | Account-scoped single reads                                                                                                                 |
| `recordHistoricalCaseFact`                                    | Record or replace one fact with its own provenance                                                                                          |
| `getHistoricalCaseFacts`                                      | One case's facts, bounded                                                                                                                   |
| `classifyHistoricalCase`                                      | Recompute the tier, store it, and append a classification snapshot                                                                          |
| `setHistoricalCaseCompleted`                                  | Record the completion timestamp                                                                                                             |
| `setHistoricalCaseLearningEligibility`                        | Include or exclude, with a reason                                                                                                           |
| `listTrainingEligibleCases` / `listRetrievalCases`            | Bounded list reads (default 50, clamped to 200)                                                                                             |
| `appendHistoricalCaseSnapshot` / `getHistoricalCaseSnapshots` | Append-only learning truth                                                                                                                  |
| `freezeHistoricalCase` (050)                                   | Compare-and-set freeze; `null` means somebody else won                                                                                     |
| `loadEnquiryFactsForCapture` (050)                            | The enquiry columns a finalization snapshot copies                                                                                           |

Every list read applies a limit and a deterministic order. Validation is total
and strict: an unrecognised key, a wrong value kind, an out-of-range number, or
an illegal provenance is rejected before it becomes a request.

The capture, finalization and correction entry points live in
`src/lib/historical-cases/outcome.ts` and are described in
[job-outcome-capture.md](job-outcome-capture.md).

## Creation and finalization

**Nothing creates a historical case automatically from the message path.**
There is deliberately still no call to `ensureHistoricalCase` from the
inbound path, from `afterInboundInsert`, or from any tool. A case exists
because a human (or a future objective) asked for one.

Objective 02 gave that "asked for one" an owner: the outcome-capture
workflow calls `ensureHistoricalCase` when staff record a completed job or
a lost enquiry. That is still explicit and still operator-driven — the
rule that matters is unchanged, which is that a case is never created
because somebody typed in a chat window.

Finalization likewise exists now, as an operator action, and is still
never automatic. See [job-outcome-capture.md](job-outcome-capture.md).

## Tenancy, RLS and immutability

- `account_id` on every table, with `ON DELETE CASCADE` from `accounts`.
- Composite `(id, account_id)` foreign keys for the case → enquiry,
  conversation and contact references, so a privileged write cannot attach a
  case to another account's data or to a conversation that is not the enquiry's.
- `historical_case_facts.source_message_id` is checked inside a
  `SECURITY DEFINER` trigger, because `messages` has no `account_id` column
  (migration 017 reaches it through its parent conversation). A cross-account
  message reference is rejected even on a service-role write.
- RLS: account members read; agents and above write. **No authenticated DELETE
  policy** on any of the three tables.
- Identity fields are immutable; a finalized case is frozen; its facts cannot
  be inserted or updated; its snapshots cannot be updated or deleted while the
  case exists.
- `historical_case_evidence_supports_tier` is `SECURITY DEFINER` with
  `EXECUTE` revoked from `PUBLIC` and granted only to `authenticated` and
  `service_role`, so it cannot be used as an unauthenticated oracle.
- **One correction to the freeze, from migration 050.** Three columns may
  change on a finalized case — `learning_eligibility`,
  `learning_exclusion_reason` and `learning_eligibility_basis` — and only
  towards `excluded` (with a reason and a basis) or back to `included`.
  Nothing the case said can change, and every change appends an immutable
  `correction` snapshot. Objective 01's freeze left this field unreachable,
  which would have made a mis-recorded or unconsented case permanently
  stuck in the training population.

## Deferred

Not implemented, and not required for these two objectives:

- **Embeddings and vector search.** Objective 03 has since added the
  account-scoped vector store (`case_embeddings`, migration 053) plus the
  deterministic semantic-input builders. See
  [vector-memory.md](vector-memory.md). The *search* is still Objective
  04, and this document's case facts are exactly what it reads.
- **Similar-job / similar-image retrieval** (Objective 04). The retrieval
  population query exists; the search does not.
- **Case memory service** (Objective 05+).
- **Quote calculation, feature model, confidence, explanation** (Objectives
  05-08). The canonical quote lifecycle is recorded; nothing prices anything.
- **Booking, availability, orchestrator, draft replies, policy, learning /
  evaluation pipeline, monitoring** (Objectives 09-16).
- **Travel distance and time capture.** The keys exist and the capture
  workflow deliberately does not expose them: nobody records them today, and
  a field that is always empty teaches nothing. They remain populated by
  historical import.
- **An operator UI** for outcome capture. The workflow is an authenticated
  JSON route, because this application has no enquiry screen to extend and
  building one is the operator-UI objective's work.
- **A durable operator action log** — every capture request, not just the
  facts it produced. This is the monitoring objective.
- **Validated image-analysis observations** are not persisted today;
  `analyze_images` returns them to the caller and they are not stored. They
  become an `image_analysis` snapshot at finalization.
- **Imported historical cases**: `source_kind = 'imported_historical'`
  is now written by the historical importer, together with the durable
  source ledger and import-run audit trail that make it traceable,
  idempotent and reviewable. See
  [historical-import.md](historical-import.md). An imported case still
  starts `pending`, so historical data cannot be trusted into training
  merely by arriving, and an import cannot promote a case past the
  evidence tiers it has actually earned.

Fields from the roadmap's required-case-facts list that are **not** yet
represented, and why:

| Roadmap fact                                                          | Status                                                                                            |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Actual load/volume, actual disposal weight, crew count, actual labour | **Captured** (Objective 02). Load and weight are separate facts with no conversion between them    |
| Arrival / departure timestamps                                        | **Captured** (Objective 02); the duration is derived, never typed                                   |
| Travel distance/time                                                  | Key exists; still no capture source                                                               |
| Validated image-analysis observations                                 | Key does not exist as a fact; reserved as the `image_analysis` snapshot kind, written only if observations exist |
| Final job notes, scope changed / why                                  | **Captured** (Objective 02), with a closed `scope_change_type` vocabulary and never inferred       |
| Actual dismantling / special handling                                 | **Captured** (Objective 02) as `actual_dismantling_required`                                       |
| Booking date/time, van/crew assignment                                | **Deferred** — no booking domain exists, and inventing one is explicitly out of scope             |
| Payment method, invoice number                                        | **Deferred** — no payment domain exists                                                           |
| Service type                                                          | Key exists. Note `enquiries.customer_intent` is free text and is _not_ treated as a service type. |
