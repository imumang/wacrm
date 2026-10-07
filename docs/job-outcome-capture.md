# Job outcome capture

Objective 02 of the AI Learning System roadmap: the operational path that
turns a historical case from an empty learning shell into a trustworthy
learning record.

Objective 01 built the case model. It deliberately left the outcome side
inert — the fact keys existed, but nothing could write them, there was no
completed-job workflow, and there was no way to finalize a case. This
document describes what now writes them.

- Migration: `supabase/migrations/050_job_outcome_capture.sql`
- Domain: `src/lib/historical-cases/outcome.ts` (capture, finalization,
  correction), `model.ts` (vocabularies, classification)
- Repository: `src/lib/historical-cases/repository.ts`
- Operator routes: `src/app/api/historical-cases/...`
- Verification: `supabase/ci/verify-schema.sql`,
  `supabase/ci/verify-outcome-capture.sql`
- Reading: [historical-cases.md](historical-cases.md) for the case model
  itself

## The shape of it

```
operator (staff, after a job or after losing one)
      │
      │  POST /api/historical-cases/outcome
      ▼
   captureJobOutcome ──► ensureHistoricalCase ──► historical_cases
      │                                                 │
      ├─ fact upserts ──► historical_case_facts         │
      ├─ completed_at  ──► historical_cases             │
      └─ classify      ──► historical_cases + evidence_classification snapshot
                                 │
      operator (staff, closing the job)
      │
      │  POST /api/historical-cases/[caseId]/finalize
      ▼
   finalizeHistoricalCase ──► enquiry_facts / image_analysis /
                              commercial / outcome snapshots
                              + the case row, frozen
```

Two operator actions, never one. Capture writes; finalize freezes.
Nothing in WACRM finalizes a case by itself, because WACRM has no way yet
to know when a case will stop changing, and a case frozen too early is a
training example that can never be corrected.

## Two capture shapes, never blended

```jsonc
// a job that happened
{ "enquiry_id": "…", "outcome_type": "completed", "completed": { … } }

// a job that did not
{ "enquiry_id": "…", "outcome_type": "lost", "lost": { … } }
```

A rejected or unanswered quote has no arrival time, no load count, no
disposal weight and no collected amount, and the lost-business input has
**no field** in which to record one. The separation is enforced by the
shape, not by a validation rule that could be forgotten: a capture that
carries `arrival_at` on a `lost` outcome is rejected as an unrecognised
field, and there is nothing to strip before the rejection happens.

The completed-job fields:

| Field | Required | Provenance | Meaning |
| --- | --- | --- | --- |
| `final_operational_outcome` | always | `operator_entered` | `completed`, `partially_completed`, `cancelled_on_arrival`, `no_show` |
| `completed_at` | for a worked job | — (case column) | when the job finished |
| `final_amount_collected` | for a worked job | `confirmed_outcome` | what was actually taken |
| `actual_load_units` | optional | `confirmed_outcome` | loads removed, as a fraction |
| `actual_disposal_weight_kg` | optional | `confirmed_outcome` | weight handed to the disposal site, kg |
| `disposal_weight_source_message_id` | optional | — (fact column) | the message holding the weighbridge ticket |
| `arrival_at` | optional | `confirmed_outcome` | crew on site |
| `departed_at` | optional | `confirmed_outcome` | crew left |
| `crew_count` | optional | `operator_entered` | how many |
| `actual_dismantling_required` | optional | `operator_entered` | whether dismantling / special handling was actually needed |
| `scope_change_type` | optional | `operator_entered` | how the job differed from the quote |
| `scope_change_reason` | optional | `operator_entered` | why |
| `final_job_notes` | optional | `operator_entered` | anything else worth keeping |

The lost-business fields:

| Field | Required | Provenance |
| --- | --- | --- |
| `quote_decision` | always | `operator_entered` |
| `final_job_notes` | optional | `operator_entered` |

### The caller never chooses provenance

Provenance is assigned by the capture service, per fact, from a fixed
table. An operator cannot mark their own note as a `confirmed_outcome`
measurement, and — the point of the whole exercise — neither can a model.

Two rules follow from that and are worth stating plainly:

- **Measured is not the same as asserted.** `final_amount_collected`,
  `actual_load_units`, `actual_disposal_weight_kg` and the two
  timestamps are `confirmed_outcome`: somebody observed them after the
  job. `crew_count`, `final_job_notes`, `scope_change_type` and
  `final_operational_outcome` are `operator_entered`: a person is
  telling you what happened. Both are honest; they are not the same kind
  of evidence, and a future pipeline is entitled to weight them
  differently.
- **`actual_labour_minutes` is `system_derived`.** Nobody measured it.
  WACRM computed it from two observed instants, and the difference is
  arithmetic rather than evidence.

## Actual vs estimated, and unknown vs zero

Estimated facts already had a home (`estimated_load_units`,
`estimated_labour_minutes`, `estimated_volume` on the enquiry). Actual
facts are separate keys with separate provenances, and the capture
surface cannot write an estimated value into an actual one.

Every measurement is optional. If nobody weighed the load,
`actual_disposal_weight_kg` is **absent** — not zero, not estimated from
the photographs, not carried over from the enquiry. A crew that did not
weigh the load did not weigh the load, and recording a zero would be a
fabrication that looks like a measurement.

The only two things a worked job cannot be captured without are the
operational outcome and the collected amount, because without them the
case cannot reach tier A and is not worth finalizing as a training
example. An optional measurement being unavailable never blocks
finalization.

## Load quantity is not disposal weight

Two facts, two provenances, and **no conversion between them**.

- `actual_load_units` is how many loads left the property. Fractional
  values are ordinary: `0.5`, `1`, `1.5`, `2`, and `0.25` are all
  accepted. There is deliberately no rounding to a half-load grid,
  because no business rule defines one.
- `actual_disposal_weight_kg` is the total weight handed over.

They are related in the physical world and unrelated in this dataset.
Nothing derives one from the other, in either direction, and no
kilograms-per-load factor exists anywhere in the codebase. Inventing one
would be the single most damaging thing this objective could do: it
would manufacture a plausible-looking load figure for every job nobody
weighed, and those invented figures would then be trained on as though
somebody had measured them.

`17 - Business Inputs Needed.md` still lists **load-size definitions** and
**disposal-cost categories** as unresolved. Until the business defines
them, the two facts stay separate.

Canonical mass unit: kilograms. It matches the fact key name, and there
is no other mass unit anywhere in WACRM.

## Labour timing

`arrival_at` and `departed_at` are stored as facts, not as columns on
the case row, so they carry provenance and can be corrected while the
case is open. `actual_labour_minutes` is **derived**, never typed:

```ts
deriveLabourMinutes('2026-03-01T09:00:00Z', '2026-03-01T10:45:00Z') // 105
```

Rules:

- Departure must be **after** arrival. Equal or inverted is rejected.
- Both timestamps must carry a timezone designator. "09:00 on site" is
  not an instant, and accepting one would make the derived duration
  depend on which server read it. Accepted: `…T09:00:00Z`,
  `…T09:00:00+01:00`. Rejected: `2026-03-01T09:00:00`, `09:00`, a
  number.
- Stored timestamps are normalised to canonical UTC.
- One timestamp present → duration stays **unknown**. The fact is not
  written. `null` is not zero minutes.
- Partial minutes truncate towards zero, in TypeScript and in SQL
  identically, because two implementations of "how many minutes" must
  never disagree about a value the database re-derives.

The database re-derives the duration on every write of
`actual_labour_minutes` and rejects a value that disagrees with the
case's own `arrival_at` / `departed_at`
(`historical_case_derive_labour_minutes`). A service-role write cannot
hand-type "90 minutes" next to a 105-minute pair.

The rule is deliberately one-directional. It is not applied to a write of
the timestamps themselves, because a correction is exactly when they
change: blocking the timestamp until the derived duration was also
updated would make an operator who mistyped 17:00 for 16:30 unable to
correct it. The capture service closes that instead by always writing
the derived value in the same call.

## Commercial outcome: six losses, not one

`quote_decision` is the commercial outcome of an enquiry. Objective 01
gave it four values; extending it is the point of this section, because
`rejected` was carrying four different things and only one of them is a
statement about our price.

| Value | The customer… | Evidence about price |
| --- | --- | --- |
| `accepted` | said yes | none yet — the job has not happened |
| `rejected_price` | said the number was too high | about this customer, not about the job |
| `found_better_price` | quoted a lower number elsewhere | stronger than silence; still not the job price |
| `no_response` | never replied | **nothing** |
| `cancelled_by_customer` | withdrew | not about price |
| `other_lost` | — | not about price |
| `rejected` | (retained from objective 01) | read as an explicit rejection |
| `pending` / `unknown` | — | none recorded |

`no_response` is the value most likely to be mistaken for a rejection,
and it is the reason the split exists. Merging "too dear" with "never
replied" overstates how often this business is priced out — which is a
commercial conclusion somebody would then act on.

All six lost values reach tier F, because none of them describes a job
that happened. They do **not** collapse together:

- `classification.quote_decision` carries the decision on the result.
- `evidence_reasons` carries a distinct, human-readable reason per
  value, each of which states in its own words that the case is not a
  completed-job price.

## Scope change

`scope_change_type` is a closed vocabulary and is **never inferred**:
`no_material_change`, `more_waste_than_expected`,
`less_waste_than_expected`, `access_harder_than_expected`,
`access_easier_than_expected`, `customer_added_work`,
`customer_removed_work`, `other`.

The one thing it is explicitly not derived from is the money. A job that
collected less than quoted may have been under-priced, or may have been
a smaller job, or may simply have been under-paid — and those are three
completely different lessons. Reading the reason out of the price gap is
precisely the invented business fact this dataset must not contain.

Recording a `scope_change_type` also writes the objective-01
`scope_changed` boolean, derived from it: `false` for
`no_material_change`, `true` for everything else. `no_material_change`
is still written rather than omitted, so "the crew said nothing changed"
is a recorded fact rather than an absence.

## Finalization

`POST /api/historical-cases/[caseId]/finalize` freezes the case.

Four snapshot categories, each written **only if the facts for it
exist**:

| Snapshot | Holds |
| --- | --- |
| `enquiry_facts` | the enquiry's canonical columns as they stood, plus the provenance each was annotated with |
| `image_analysis` | validated `image_observed` facts, each naming its source message and media |
| `commercial` | canonical quote revisions when present (legacy quote-shaped facts otherwise), plus collected outcome for comparison |
| `outcome` | completion timestamp, load, weight, timing, derived duration, crew, scope change, notes |

A case with no image observations gets **no** `image_analysis` snapshot.
An empty section in a training example reads as "we looked and found
nothing" rather than "we never looked", and only one of those is true.

Money and the day it describes are kept apart. A question about what we
charged is answered from `commercial`; a question about what the job
involved is answered from `outcome`. Keeping them apart is what stops a
price question from being answered with a load count.

Finalization is idempotent four ways over:

1. a case that is already finalized returns immediately and writes
   nothing;
2. a category that already has a snapshot is skipped, so an interrupted
   run resumes rather than failing;
3. a partial unique index (`idx_historical_case_snapshots_one_finalization`)
   makes a second snapshot of the same kind impossible in the database,
   so a replayed or concurrent finalize cannot leave two competing
   answers about what a training example was built from;
4. the freeze itself is a compare-and-set on `case_state`, so exactly
   one caller wins and the loser reads the winner's answer.

It refuses a case with no recorded captured facts whose enquiry is still
open: freezing that would produce a permanently empty shell that no
correction could ever fill.

After `finalized_at` is set, the case row, its facts and its snapshots
are frozen by database triggers. Identity cannot change, the evidence
tier cannot be re-claimed, facts cannot be inserted or updated, and
snapshots cannot be amended or deleted.

## Corrections after finalization

Freezing a case completely left one hole: `learning_eligibility` is the
only mechanism objective 01 designed for withholding a case from
training, and it was the one field a frozen row could not reach. A case
discovered to be mis-recorded or unconsented would have been stuck in the
training population forever.

`POST /api/historical-cases/[caseId]/correction` is that path, and it is
deliberately narrow:

- Exactly three columns may change: `learning_eligibility`,
  `learning_exclusion_reason`, `learning_eligibility_basis`.
- The new state must be `excluded` with a reason and a basis — or
  `included` again, when the exclusion was itself the mistake. A decision
  nobody can undo is not a decision an operator should be afraid to make.
- Nothing the case **said** can change. The facts and the finalization
  snapshots stay frozen, so the training example remains exactly
  reproducible.
- A `note` is required, and an immutable `correction` snapshot is
  appended in both directions recording the previous state, the new
  state and who made the change.

If a finalized amount is genuinely wrong, the honest answer is a new
case — not an edit to the one that was closed. This is a versioning
path, deliberately the smallest one that removes the trap.

## Evidence tiers

| Situation | Tier | Population |
| --- | --- | --- |
| Completed job + confirmed final amount | **A** | `completed_trusted_price_outcome` |
| Accepted quote, job not yet done | **B** | `accepted_quote_outcome_pending` |
| Accepted, job complete, no collected amount | **C** | `completed_outcome_without_final_amount` |
| Human-issued quote, no decision | **D** | `unclassified` |
| AI suggestion only | **E** | `ai_suggestion_only` |
| Rejected / no response / cancelled | **F** | `explicitly_rejected_quote`, `no_response_quote`, `other_lost_quote` |
| Operator-excluded | any | `excluded` |
| Nothing recorded that places the case | unclassified | `unclassified` |

`historicalCaseLearningPopulation` is a pure function of a
classification the case already carries. It is not stored as a column,
because a second stored flag could disagree with the tier; and an
exclusion wins over the tier, so an excluded tier-A case stays excluded
and a pipeline filtering on evidence alone cannot recover it.

This is what keeps the five populations separate for a future learning
pipeline:

- **completed / trusted price outcomes** — the only price labels.
- **accepted-but-incomplete cases** — a future job, not a past one.
- **explicitly rejected quotes** — negative commercial evidence.
- **no-response quotes** — silence, kept apart from rejection.
- **excluded cases** — withheld, reversible, never deleted.

They are five different queries, not one flag read five times.

AI feedback-loop protection is unchanged and still holds on the legacy keys:
`ai_suggested` provenance is refused on every outcome, decision and
human-quote key, `ai_suggested_amount` requires it, and tier A requires
a `confirmed_outcome` `final_amount_collected` on a completed case.
Canonical quote predictions and `final_amount_collected` remain in separate
domains and can never collapse into one column.

## Tenancy, audit, and what this path cannot do

- Every query is account-scoped, and the account comes from the caller's
  profile — never from a request body — so no body field can point a
  write at another tenant.
- Routes require the `agent` role, matching the RLS policy the write
  actually runs under, and use the caller's own Supabase client so RLS
  applies on top of the explicit filter.
- Composite `(id, account_id)` foreign keys and account-checked trigger
  functions mean a service-role write cannot cross accounts either.
- The recording agent is written to every fact and snapshot
  (`recorded_by_user_id`), so "who recorded this final amount" is
  answerable.
- Every classification appends an immutable
  `evidence_classification` snapshot, so the current answer and its
  history both exist.
- **No approval gate, because no model is in this path.** It is an
  operator recording what they saw. The AI write-tool approval machinery
  gates what a model proposes; using it here would imply an authority
  question that does not exist. The dataset is protected instead by the
  fact vocabulary, which refuses a provenance the domain will not assign.

A durable operator action log — every capture request, not just the
facts it produced — is **not** implemented. It belongs to the monitoring
objective.

## Known limitations

- **No operator UI.** The workflow is an authenticated JSON route. There
  is no enquiry screen in this application to extend, and building one is
  the operator-UI objective's work, not this one's.
- **No i18n surface** exists for capture, because there is no capture UI.
- A derived labour duration cannot be un-set. If a case already has one,
  a later capture must supply both timestamps again; the value is
  refused rather than left disagreeing with the timestamps above it.
- Legacy quote-shaped facts carry no currency column. Migration 052's canonical
  `quotes` do carry an explicit ISO currency and integer minor units, so a
  canonical quote amount and a legacy fact amount are not directly comparable
  without that conversion. Currency normalization for imported legacy amounts
  remains part of the historical-import objective.
- Travel distance and travel time still have no capture source; they
  remain recorded by import only.
- `actual_item_count` is not captured. A job with fewer items than
  expected is recorded as `less_waste_than_expected` rather than as a
  second count.

## What a future learning pipeline must not do

- Do not read a lost quote's amount as a price label.
- Do not merge `no_response` with `rejected_price` when computing a
  price-related rejection rate.
- Do not train on a case whose population is not
  `completed_trusted_price_outcome`.
- Do not treat an absent measurement as zero.
- Do not reconstruct a load figure from a weight, or a weight from a
  load.
- Do not read `actual_labour_minutes` without re-deriving it from
  `arrival_at` and `departed_at`, in case a case predates the guard.
- Do not read `scope_change_type` as a price explanation without
  checking the quote and the collected amount separately.
