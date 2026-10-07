# Historical import and normalization

Objective 02 of the AI Learning System roadmap: a safe, repeatable
pipeline that converts the historical evidence WACRM already holds into
historical cases — without inventing a fact and without promoting
unreliable evidence into trusted learning data.

- Migration: `supabase/migrations/051_historical_import.sql`
- Domain: `src/lib/historical-import/`
  (`model.ts`, `normalize.ts`, `source-inventory.ts`, `plan.ts`,
  `repository.ts`, `service.ts`)
- Operator route: `src/app/api/historical-import/route.ts`
- Verification: `supabase/ci/verify-schema.sql`,
  `supabase/ci/verify-historical-import.sql`
- Reading: [historical-cases.md](historical-cases.md) for the case
  model, [job-outcome-capture.md](job-outcome-capture.md) for how a
  case acquires real outcomes

---

## The headline finding, stated before anything else

**WACRM has no backfilled historical business evidence.**

Migration 045 created `enquiries` and said so explicitly: *"Historical
conversations are intentionally not backfilled: their business state
cannot be known without inventing facts."* Every enquiry in WACRM was
therefore created by a person, from a live conversation, since that
migration shipped. There are no invoices, no payments, no weighbridge
records, no calendar, no pre-052 quote table and no external import staging
area.

What that means for this objective, plainly:

- The historical volume available to import today is **the number of
  `enquiries` rows in the account**, which on a fresh deployment is
  whatever the outcome-capture and repeat-enquiry workflows have
  created since. That is not a limitation of the importer; it is the
  size of the history that exists.
- Everything else — pre-enquiry conversations, pipeline rows — is
  *reported* and deliberately *not* mapped.
- **No imported case can carry a price, a customer decision, or an
  outcome.** There is no structured source for any of them, so the
  imported facts are provenance annotations of the canonical enquiry
  columns, and the cases classify as **unclassified**.

That last sentence is the correct result, not a disappointment. It is
the objective's own example of import quality being separate from
evidence quality: an enquiry can map perfectly and still prove nothing
about a job, because the business never recorded what happened.

---

## 1. Source inventory

The inventory is code, not prose:
`HISTORICAL_SOURCE_INVENTORY` in
`src/lib/historical-import/source-inventory.ts`. It is exported by the
inspection route, so the document an operator reads and the table that
drove the mapping cannot drift apart.

| Adapter | Tables | What it is | Class | Maps to facts? | Skip reason |
| --- | --- | --- | --- | --- | --- |
| `enquiries` | `enquiries`, `enquiry_state_events` | A durable job record inside one conversation | operator entry (canonical) | **yes**, annotations only | — |
| `legacy_conversations` | `conversations`, `messages` | Pre-enquiry WhatsApp history | unknown | no | `requires_enquiry_segmentation` |
| `deals` | `deals`, `pipelines`, `pipeline_stages` | A kanban card with a pipeline value | unknown | no | `source_semantics_unproven` |

Sources the roadmap asks about that **did not exist in the pre-052 history** are
recorded in `HISTORICAL_ABSENT_SOURCES`, so "we did not import the
invoices" is a verified statement rather than an omission:

- structured historical quotes — the new canonical quote table does not
  retroactively prove `deals.value` or old message prices
- invoices and payments — no entity of any kind
- load and disposal records — no entity; the fact keys exist and stay
  empty
- diary / calendar — no entity
- external CRM / spreadsheet exports — no connection, no import table,
  no staging area

### `deals` is not a quote

This is the entry most likely to be got wrong by somebody in a hurry,
so it is worth the detail:

- `deals.value` is pipeline value. Nothing in the schema, the
  application or the documentation shows it was ever the number sent to
  a customer.
- `deals.status` is free text defaulting to `'active'`, with no
  won/lost semantics enforced anywhere.
- There is no approval, no customer-facing amount and no customer
  decision attached to a deal, so a deal cannot answer any of the
  commercial questions the case model asks.
- `deals.expected_close_date` is a forecast, not an observation.

Mapping it into `customer_facing_quote_amount` would manufacture a
quote lifecycle this application has never had. The importer reports
deals and maps none of them.

### Price mentions in messages

Monetary values appear in message text constantly. **None of them is a
quote.** There is no structured legacy quote source to give those old numbers
meaning. Migration 052's canonical quote table records the new workflow; it
does not retroactively classify messages. The importer has no code path that writes any monetary fact
from any source, and there is no NLP or LLM price extractor behind it
either — writing one was explicitly out of scope, and adding one later
would not help: a price in a message is still not a quote until
something deterministic says so.

Two run-level findings make this visible on every run:
`no_structured_quote_source` and `no_structured_outcome_source`.

### Messages and images

Inbound attachments are imported as **references**, not observations:

- the source ledger names the `messages` row id, and that row keeps its
  own `created_at` and `media_type`;
- **no `image_observed` fact is ever written.** That provenance means
  "a validated model looked at this photograph"; claiming it without
  running analysis would be the most serious fabrication available to
  this objective;
- no media bytes are fetched, no image analysis runs, and no AI provider
  is called. There is no code path here that could.

Only inbound (`sender_type = 'customer'`) media messages are recorded,
so an agent's or a bot's own attachment never enters the ledger as
customer evidence. Capped at
`HISTORICAL_IMPORT_MAX_MEDIA_PER_CASE` (20) per case.

The canonical storage *object path* is deliberately not extracted. The
only column that could hold it without implying an observation is
`historical_case_facts.source_media_id`, which the database gates behind
`image_observed`. That attachment point belongs to the image-enrichment
phase, which runs analysis and can then write both together.

---

## 2. What the importer does

### Architecture

```
GET  /api/historical-import   → inspect: counts, inventory, recent runs
POST /api/historical-import   → { source_type, dry_run, offset, limit }

dryRunHistoricalImport  ─┐
                         ├─► planEnquiryImport  (pure)
executeHistoricalImport ─┘         │
                                   ▼
                    read source rows ──► decide ──► apply or report
```

`plan.ts` is pure. `dryRunHistoricalImport` and
`executeHistoricalImport` call **the same planner** for the same inputs
and differ only in whether the plan is applied. A dry run is therefore
not a second implementation of the mapping that could disagree with the
first one.

### Per-enquiry mapping

For each `enquiries` row, in this order:

1. **already attributed** → skip (`already_imported`)
2. **case is finalized** → conflict (`finalized_case_not_mutated`)
3. **no usable canonical column** → skip (`no_mappable_facts`)
4. otherwise → plan

The plan proposes one **canonical annotation fact** per populated,
recognisable `enquiries` column: `customer_intent`, `postcode`,
`address`, `property_type`, `floor`, `lift_available`, `parking`,
`access_constraints`, `item_descriptions`, `waste_type`,
`estimated_volume`, `heavy_special_items`, `photos_received`.

Canonical keys carry a **provenance and no value** — that is the
objective-01 design, and it is why the importer cannot write a stale
copy of a postcode that a later correction would contradict.

`observed_at` is the enquiry's `created_at`, not `state_changed_at`:
`created_at` is immutable (migration 045's trigger refuses to change
it), and an "observed at" that moved while nothing was re-imported would
make idempotency impossible to reason about.

`preferred_date` and `preferred_time_window` are **not** mapped. They
have no fact key, and a preferred date belongs to a booking domain this
application does not have.

### What is never derived

Not inferred, under any circumstance, by any code path:

- a final outcome from an enquiry's age or a conversation's silence
- an accepted quote from a price having been mentioned
- a final collected amount from a quoted amount
- an actual load from images, from a weight, or from anything else
- a disposal weight from anything at all
- a labour duration without both observed timestamps
- a rejection from silence (`no_response` is a *recorded decision*,
  and the importer never records one)
- a workflow state into a commercial decision
- a kilogram-per-load conversion — none exists anywhere in WACRM

`enquiries.workflow_state` is never read by the mapper at all. The
evidence classifier reads it on its own terms (a cancelled enquiry
reaches tier F); the import does not interpret it.

---

## 3. Source identity and idempotency

Every imported record is attributed in `historical_case_sources`:

| Column | Meaning |
| --- | --- |
| `source_kind` | closed vocabulary: `enquiry`, `legacy_conversation`, `message`, `deal`, `contact` |
| `source_record_id` | the canonical row's own UUID |
| `source_system` | the table it came from, e.g. `wacrm.enquiries` |
| `source_version` | a version or hash where one exists — **null today**, because no WACRM row has a natural one and inventing a fingerprint would be a fabrication |
| `source_observed_at` | the source record's own timestamp, normalized to an instant |
| `import_run_id` | the run that brought it in |
| `imported_at` | when the import happened |

`source_observed_at` and `imported_at` are separate columns because
"when the customer messaged" and "when we imported it" are different
facts.

### Idempotency, in three constraints

Re-running the importer converges instead of duplicating:

| Guarantee | Enforced by |
| --- | --- |
| one case per enquiry | `historical_cases_one_per_enquiry` (049) |
| one value per key per case | `historical_case_facts_one_per_key` (049) |
| **one case per source record** | `historical_case_sources_one_record_one_case` (051) |

The third is the one this objective adds. Without it, a conversation
that somehow acquired two enquiry rows would be imported as two cases,
and the dataset would double-count the same business evidence.

A second run therefore examines every row, writes nothing, and reports
the same numbers with `already_imported` as the skip reason. That is
the observable definition of idempotent, and it is asserted in
`service.test.ts` and in `verify-historical-import.sql`.

The ledger is also append-only: `UPDATE` is refused, `DELETE` is
refused while the case exists, and a **finalized case accepts no new
source row at all** (an imported source attached to a frozen case would
add evidence to a training example that was never re-frozen).

---

## 4. Import runs and dry-run behaviour

`historical_import_runs` is the audit record of an attempt:

`account_id`, `source_type`, `status`, `started_at`, `completed_at`,
`dry_run`, `records_examined`, `cases_created`, `cases_updated`,
`cases_reused`, `facts_imported`, `records_skipped`,
`ambiguous_records`, `conflicts`, `errors`, `summary` (JSONB),
`error_metadata` (JSONB), `importer_version`, `triggered_by_user_id`.

### The dry-run promise is a database constraint

```sql
CONSTRAINT historical_import_runs_dry_run_no_writes CHECK (
  NOT dry_run OR (cases_created = 0 AND cases_updated = 0)
)
```

The promise an operator relies on before approving a real import is not
a code convention. The database will refuse to *record* a dry run that
claims to have created a case, and `parseHistoricalImportRun` refuses
to read one.

A dry run still writes an `historical_import_runs` row. That is not a
historical-case mutation — no case, no fact, no source ledger row, and
not even a reclassification moves — and it is what makes *"we dry-ran
this and it said 412 cases"* an answerable question months later.

### What a dry run reports

| Field | Meaning |
| --- | --- |
| `records_examined` | source records read |
| `summary.projection.cases_to_create` | cases that **would** be created |
| `summary.projection.cases_to_update` | existing cases that would gain facts |
| `summary.projection.cases_to_reuse` | existing cases the run would add to |
| `summary.projection.facts_to_import` | facts that would be written |
| `summary.projection.media_references_to_record` | attachment references that would be attributed |
| `summary.import_quality` | per-quality record counts |
| `summary.evidence_tiers` | tier counts, `unclassified` for the explicit null |
| `summary.skip_reasons` + `summary.samples` | why records were skipped, with up to ten ids per reason |
| `summary.conflict_reasons` + samples | every refusal, counted and sampled |
| `summary.findings` | bounded run-level statements |
| `has_more` / `next_offset` | paging |

The **projection** lives in the summary rather than in `cases_created`
because those run columns are the *written* counters and the CHECK
above forbids a non-zero one on a dry run. A dry run needs somewhere to
say what it *would* do, and a projection is not a claim.

### Nothing customer-shaped goes in a log

`summary` is bounded to 8 KB and `error_metadata` to 8 KB and 50
entries. A sample reference is `<kind>:<uuid>`. There is no message
body, no name, no phone number, no address and no media URL anywhere in
an import log, and `buildImportSummary` refuses to produce a summary
that would not fit rather than silently truncating it.

An error detail is `{ source_kind, source_record_id, reason }` where
`reason` is a bounded class name (`repository_database_error`). The
Postgres message is deliberately not used: driver errors echo
constraint names and row values, and an import log is not somewhere
customer data should be duplicated into.

---

## 5. Import quality — separate from evidence tier

`import_quality` answers *"did this source record map cleanly onto the
case model?"*. `evidence_quality_tier` answers *"how much does this case
prove about a real job?"*. The roadmap's vocabulary is used verbatim:

| Quality | Meaning |
| --- | --- |
| `exact` | mapped with no interpretation — one canonical enquiry row is one job record, one-for-one |
| `high_confidence_mapping` | a mechanical, reversible resolution was needed (an attachment reference) and nothing more |
| `partial` | some of the record mapped, some of it was unusable; the unusable part is reported, not repaired |
| `ambiguous` | could plausibly mean more than one thing — skipped rather than guessed |
| `unusable` | cannot become a case at all |

They are stored on different tables (`historical_case_sources` vs
`historical_cases`), counted separately in the run summary, and never
substituted for one another.

The clearest illustration is a real dry run:

> An enquiry with `postcode = 'n/a'`, a real address and a real item
> list is recorded as `partial` — the mapping was nearly clean — while
> the case it produces is **unclassified**, because nothing in it is
> evidence that a job happened. Both statements are true, and neither
> is implied by the other.

---

## 6. Normalization

Deterministic, mechanical, and never semantic. All of it lives in
`src/lib/historical-import/normalize.ts`.

| Normalizer | Rule | Notes |
| --- | --- | --- |
| `normalizeInstant` | aware timestamp → canonical UTC ISO-8601 | a timezone-less value is **rejected**, not assumed to be UTC |
| `normalizeUkPostcode` | uppercase, one internal space | a **recogniser**, not a writer |
| `normalizeText` | trim, collapse whitespace runs | no re-casing, no re-spelling, no truncation |
| `normalizeTextList` | normalize each entry, drop empties, de-duplicate | for the `TEXT[]` enquiry columns |

Two of these are recognisers rather than writers, and the distinction
matters: **nothing here writes back to a canonical column.**
`enquiries.postcode` is operational truth and this objective does not
touch it. What the importer records is a provenance annotation for the
column, which is why recognising the value is the only thing that has
to be right.

A value that fails to be recognised is reported as unmapped and does
not become a fact. `postcode = 'n/a'` is not a postcode somebody
fat-fingered; it is a cell that does not contain a postcode, and
importing it would put "this job had a postcode" into a dataset where
what is actually known is "somebody typed something here once".

Deliberately **not** implemented, and why:

- **monetary numeric representation** — there is no structured
  monetary source to normalize. The fact model carries no currency
  column and `accounts.default_currency` is the only currency record
  in the system. Adding a money normalizer now would be a mapper with
  no source.
- **canonical load units / kg disposal weight** — no source, and no
  conversion factor may be invented (`17 - Business Inputs Needed.md`
  still lists load-size definitions as unresolved).
- **semantic item/access vocabulary** — a customer's description is not
  paraphrased, re-spelled or re-categorized. A semantic rewrite is a
  new fact wearing an old fact's name.

---

## 7. Provenance and trust

### Every imported fact is `imported_historical`

A canonical value WACRM received without learning who produced it has
exactly one honest provenance: it came from a historical import. The
rule is retained wherever the source does not reliably preserve a
stronger semantic provenance, and no source here does.

`imported_historical` is **not a promotion**:

- it is forbidden on `ai_suggested_amount` by the existing vocabulary,
  and `ai_suggested` is forbidden on every outcome, decision and
  human-quote key;
- tier A still requires `completed_at` **and** a `confirmed_outcome`
  `final_amount_collected`, re-checked in SQL on every tier write;
- an imported `final_amount_collected` therefore does **not** support
  tier A, and `verify-historical-import.sql` asserts exactly that.

### Provenance strength order

`decideImportedFact` answers one question: *may an imported fact
replace a fact already on the case?* It uses a documented total order:

```
confirmed_outcome > operator_entered > customer_stated
                  > image_observed > system_derived
                  > imported_historical > ai_suggested
```

An import can fill a gap and can fill nothing else. This is a conflict
rule, not a training weight.

### Eligibility

An imported case arrives `pending` — the database default — and stays
there until an operator decides. Historical data is never trusted into
training by arriving.

The two qualities that are not honest mappings are excluded up front,
with `import_policy` as the basis, which is the basis objective 01
already defined for exactly this case:

| Quality | Eligibility | Reason | Basis |
| --- | --- | --- | --- |
| `exact`, `high_confidence_mapping`, `partial` | `pending` (unchanged) | — | — |
| `ambiguous` | `excluded` | `ambiguous` | `import_policy` |
| `unusable` | `excluded` | `incomplete` | `import_policy` |

---

## 8. Conflict handling

Deterministic, and every branch is a refusal to change something:

| Situation | Outcome | Reason code |
| --- | --- | --- |
| no fact on that key | write | — |
| existing `confirmed_outcome` | keep, report | `confirmed_value_retained` |
| existing provenance stronger | keep, report | `stronger_provenance_retained` |
| same value, same provenance | skip, **not** a problem | `value_unchanged` |
| different values | keep the existing one, report | `existing_value_retained` |
| finalized case | nothing written, report | `finalized_case_not_mutated` |
| source record already attributed | nothing written | `already_imported` |

**The importer never overwrites.** A bulk import that can overwrite is a
bulk import that can destroy the newest confirmed evidence in an
account.

One asymmetry worth knowing: `existing_value_retained` is only
reachable for a *captured* fact, because a canonical annotation carries
no value — two annotations of the same key at the same provenance have
nothing to disagree about, and calling that a conflict would fill the
report with noise that says nothing.

---

## 9. Operator boundary

`POST /api/historical-import` / `GET /api/historical-import`.

- `admin` or above (`canImportHistoricalData` in
  `src/lib/auth/roles.ts`), matching the RLS write policy the writes
  actually run under.
- **The account comes from the caller's profile.** There is no body
  field that can point a read or a write at another tenant, so there is
  nothing to validate away.
- The caller's own Supabase client is used, so RLS applies on top of the
  explicit `account_id` filter the repository applies.
- `dry_run` **defaults to true**. An import that forgets to say what it
  is gets a plan instead of a write.
- Inputs are a source type, a dry-run flag and a bounded page position.
  No table name, no filter object, no query.
- Errors are classified: a domain `invalid_input` returns 400 with the
  domain's own message; an unclassified error returns a generic 500 and
  the driver message goes to the server log only.

This is not an AI tool, and it is not a query interface. It is four
operations: inspect, dry-run, execute, read back a run.

---

## 10. Idempotency, paging and bounds

- Default page 200, clamped to 500; offset ceiling 10 000.
- Deterministic ordering (`created_at`, then `id`) on every page read, so
  a repeated run reads the same rows in the same order.
- Every read applies `account_id` and a limit.
- State reads are batched per page (cases for the page's enquiries, and
  their facts, in two queries) rather than per enquiry. Writes go
  through the objective-01 repository one record at a time, which is
  acceptable for an operator-triggered, bounded import and keeps the
  write path identical to the one outcome capture already uses.

---

## 11. Production import procedure

**Nothing has been bulk-imported.** This objective ships the pipeline
and its verification; executing a real import is an operator decision
that has not been taken.

### Dry run (always first)

```bash
# 1. Apply migrations and prove the guards hold.
supabase db reset --local --no-seed
supabase db query --local --file supabase/ci/verify-schema.sql
supabase db query --local --file supabase/ci/verify-historical-import.sql

# 2. Inspect, as an operator (admin or above).
curl -s "$BASE_URL/api/historical-import" \
  -H "Authorization: Bearer $ACCESS_TOKEN"

# 3. Dry-run each adapter. Repeat with offset = next_offset while
#    has_more is true.
for source_type in enquiries legacy_conversations deals; do
  curl -s -X POST "$BASE_URL/api/historical-import" \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    -H 'Content-Type: application/json' \
    -d "{\"source_type\":\"$source_type\",\"dry_run\":true}"
done
```

### What to read before approving

| Read | Question it answers |
| --- | --- |
| `summary.projection.cases_to_create` | how many cases would be added |
| `summary.projection.facts_to_import` | how many facts |
| `summary.import_quality` | how many records mapped cleanly, and how many did not |
| `summary.skip_reasons` + `samples` | what was refused, and ten ids per reason |
| `summary.conflict_reasons` + `samples` | what would clash with existing evidence |
| `summary.findings` | what this installation has no source for |
| `errors` / `error_metadata` | whether anything failed |

### Then, only after explicit approval

```bash
curl -s -X POST "$BASE_URL/api/historical-import" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"source_type":"enquiries","dry_run":false}'
```

To page, repeat with `offset` set to the previous `next_offset`.
Imported cases stay `pending`, which means they train nothing until
somebody decides. There is **no operator route for that decision yet**:
`setHistoricalCaseLearningEligibility` exists in the domain layer and is
what an eligibility screen would call — and the post-finalization
`correction` route already uses the same function for a frozen case —
but no bulk review surface for imported cases is built. That is the
operator-UI objective's work, not this one's.

---

## 12. Verified numbers

Local dry run against a fixture of **3 enquiries** (one fully
populated, one with `postcode = 'n/a'`, one empty), **1 legacy
conversation** with no enquiry row, and **1 deal** with `value = 420,
status = 'won'`:

| Adapter | Examined | Would create | Would import facts | Skipped | Ambiguous |
| --- | --- | --- | --- | --- | --- |
| `enquiries` | 3 | 2 | 13 | 1 (`no_mappable_facts`) | 1 |
| `legacy_conversations` | 4 (3 already have enquiries) | 0 | 0 | 1 (`requires_enquiry_segmentation`) | 1 |
| `deals` | 1 | 0 | 0 | 1 (`source_semantics_unproven`) | 1 |

Quality counts for the enquiries run: `exact` 1, `partial` 1,
`unusable` 1. Conflicts 0. Errors 0. Evidence tiers: **all
`unclassified`**, which is the honest answer for a history in which no
outcome was ever recorded.

After all three runs, `historical_cases`, `historical_case_facts`,
`historical_case_snapshots` and `historical_case_sources` all still held
**zero** rows. The dry run wrote nothing to the case model.

---

## 13. Known limitations

- **Pre-enquiry history is unreachable by this importer.** It needs
  deterministic operator segmentation, or an objective that defines a
  defensible segmentation rule. This objective will not guess, and will
  not ask a language model to guess either.
- **No price, decision or outcome can be imported**, because no
  structured source for any of them exists. See
  `17 - Business Inputs Needed.md` → *Learning* → "trusted historical
  sources".
- **No monetary normalization**, for the same reason. If a structured
  quote or payment source is added later, currency normalization
  belongs to the objective that introduces it.
- **`deals` stays unmapped** unless its semantics are established by
  schema, application behaviour or documentation.
- **No image enrichment.** Attachments are referenced; nothing is
  analysed, no embeddings exist, and no `image_observed` fact is
  written.
- **Writes are per record**, so a large account's import is chatty.
  Bounded and operator-triggered, but not batched.
- **No re-import path.** A source record already in the ledger is
  skipped on every subsequent run. Deliberate: it is what makes a
  repeated run a no-op. Changing a mapping therefore means a deliberate
  change to the ledger, not a silent overwrite.
- **Media references can be under-reported on a crowded page.** The
  reference query is one bounded read for the whole page, capped at
  `limit × 20`. With the page ordered by message time, a long-running
  thread can consume that budget before later conversations are reached.
  Bounded and deterministic, but not fair across conversations; the
  per-case cap of 20 means the affected cases simply have fewer
  references recorded.
- **No operator UI**, and no i18n surface for one. The route is JSON,
  for the same reason outcome capture is. That is also why the
  operator-review-sample checklist item is **not** satisfied: the run
  summary exposes the ids an operator would review, but nobody has
  reviewed them yet.
- **No durable operator action log** for import *requests* beyond the
  run rows themselves. That belongs to the monitoring objective.
- **A partial mapping is a partial case.** A `partial` enquiry still
  produces a case, because the mapped part is real evidence of what the
  enquiry column held. It stays `pending`, so nothing trains on it
  until somebody decides.

---

## 14. What a future objective must not do

- Do not treat an imported annotation as a customer-stated or
  operator-entered fact to gain confidence it does not have.
- Do not read an import run's `cases_created` as a projection. For a
  dry run it is zero by constraint; the projection is in
  `summary.projection`.
- Do not widen `import_quality` to overlap `evidence_quality_tier`.
  They answer different questions and the roadmap's example depends on
  them staying apart.
- Do not add a message-text price extractor. A price in a message is
  not a quote.
- Do not segment conversations with an LLM. Boundary detection is not a
  language task, and a wrong boundary creates a case that never
  existed.
- Do not reuse an imported source record to attach new evidence to a
  finalized case.
- Do not include imported cases in training without an operator
  decision. They arrive `pending`, and `pending` means pending.
