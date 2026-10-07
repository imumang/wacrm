# Vector memory

Objective 03 of the AI Learning System roadmap: the versioned,
account-scoped vector store that Objective 04 (Similar Job and Image
Retrieval) will search.

This objective builds **memory**, not prediction. There is no similarity
ranking here, no hybrid pricing, no confidence, and no learned
estimator. What exists is a durable, reproducible store of semantic
representations of historical jobs, plus the guarantees that make
storing vectors safe.

- Migration: `supabase/migrations/053_embeddings_vector_memory.sql`
- Domain layer: `src/lib/vector-memory/`
- Operator surface: `POST /api/vector-memory` (JSON)
- Schema verification: `supabase/ci/verify-schema.sql`
- Behaviour verification: `supabase/ci/verify-vector-memory.sql`

Companions: [`historical-cases.md`](./historical-cases.md) (the case
model this reads), [`image-analysis.md`](./image-analysis.md) (the
observations one builder consumes),
[`ai-provider-architecture.md`](./ai-provider-architecture.md) (the
embedding provider path this reuses), and
[`quote-domain.md`](./quote-domain.md) (the money this objective
deliberately never touches).

## What already existed, and what was reused

WACRM already had a working embedding path. Objective 03 is a **second
consumer of it**, not a second embedding system:

| Existing capability | Where | How Objective 03 uses it |
| --- | --- | --- |
| pgvector extension | migration 030 | Reused; no new vector store technology |
| `vector(1536)` + cosine HNSW | `ai_knowledge_chunks` | Same column type, same metric, same index strategy |
| `embedTexts` OpenAI client | `src/lib/ai/embeddings.ts` | Extended in place (usage + cancellation), **not** duplicated |
| `ai_configs.embeddings_api_key` | migration 030 | The only credential; decrypted via `loadEmbeddingsKey` |
| `ai_usage_log` cost trail | migration 029 | Embedding spend added with mode `embeddings` |
| `loadAiConfig` / `loadEmbeddingsKey` | `src/lib/ai/config.ts` | The only way a key is read |

Deliberately **not** added: a second AI configuration table, a second
provider SDK, a second embeddings endpoint, or a separate cost
accounting system. An Anthropic-only account already gets `unavailable`
from the provider resolver, exactly as it does for the knowledge base —
Anthropic has no embeddings endpoint, and that is a supported state, not
an error.

## Embedding kinds — the modality distinction

Three kinds, and conflating any two of them is the failure this union
exists to prevent:

| Kind | What it is | Producible today |
| --- | --- | --- |
| `case_text` | A text embedding of the canonical business description of one job | Yes |
| `image_observation_text` | A text embedding derived from **validated structured visual observations** | Yes |
| `native_image` | A true visual vector computed from pixels | **No** |

### `image_observation_text` is not `native_image`

This is the single most important naming decision in the objective.

`image_observation_text` means: a vision model looked at a photograph
and *described* what it saw; WACRM validated that description; WACRM
serialised the description into words; a **text** embedding model
embedded those words.

That is a description of an image, in words, produced by another model.
It is not a visual vector. It measures semantic similarity between
*descriptions*, not similarity between images, and it inherits every
limitation of the describing model — including the things it refused to
commit to.

Treating one as the other would create a dataset that claims visual
provenance it does not have, and Objective 04 would rank against a
fiction. Both are recorded as distinct `embedding_kind` values, so
Objective 04 can keep "two jobs whose photos were described similarly"
separate from "two jobs that look similar".

### Native image embeddings: explicitly unsupported

An audit of the approved provider architecture found **no** native image
embedding capability that can be reached safely from WACRM's controlled
media boundary:

- The configured chat/vision models are used for vision *description*
  through `analyze_images`, which returns validated structured
  observations. That is not an embedding endpoint.
- `src/lib/ai/embeddings.ts` is a text-only `/v1/embeddings` client.
- `ai_configs` has no second provider, and adding one purely to complete
  a checklist would mean a new credential, a new data processor for
  customer photographs, and a new review surface — decisions this
  objective is not permitted to make on its own.

So `native_image` is a registered kind that nothing can produce.
`generateNativeImageEmbedding()` throws a typed `unsupported` error
rather than returning `null`, because "this does not exist in WACRM at
all" is a different answer from "this account has not configured a key",
and collapsing them would make a permanent architectural fact look like
a settings problem an operator should keep retrying.

## Provider and model strategy

| Field | Value |
| --- | --- |
| Provider | `openai` |
| Model | `text-embedding-3-small` |
| `model_version` (WACRM pin) | `text-embedding-3-small-1536-v1` |
| Dimensions | 1536 |
| Credential | `ai_configs.embeddings_api_key` |
| Distance metric | cosine (`vector_cosine_ops`) |

`model_version` is WACRM's own pin rather than the provider's model id.
It exists so a future change of provider-side model — same name,
different weights — becomes a *distinct compatibility group* even though
the string `text-embedding-3-small` did not change.

### The registry is a migration, not a setting

`public.case_embedding_registered_model(provider, model, model_version)`
maps a compatibility group to its dimension count, and a `CHECK`
constraint rejects any row whose values do not match. It holds exactly
one entry today, deliberately hard-coded.

A runtime-editable registry would let a row be added without anybody
deciding that two vector spaces can now share an index. Adding a model
is therefore a migration, which must also decide:

- whether the new model shares the `vector(1536)` column, or
- gets its own column **and its own HNSW index** (see below).

## Model / version compatibility

A vector may only ever be compared with another vector from the same
compatibility group. Four values define that group and are stored on
every row:

```
(provider, embedding_model, model_version, dimensions)
```

`parseCaseEmbedding` refuses to read back a row whose combination is not
registered. This is stricter than it first appears, and that is the
point: a vector from a model WACRM does not know cannot even be *loaded*
into the domain layer, so a partial deploy cannot put two vector spaces
into one comparison.

Semantic input version is recorded separately
(`case-text-v1`, `image-observation-text-v1`) because it changes for a
different reason. A model upgrade means new coordinates; a builder change
means the same coordinates now describe something slightly different.
Bumping either one re-embeds, and conflating them would make an innocuous
wording change look like a model change and vice versa.

## Canonical case text

`buildCaseSemanticInput` is a pure function. The same case state under
the same `semantic_input_version` always produces byte-identical text
and therefore the same content hash.

Output is a sorted, newline-delimited `label: value` document — a
structured form rather than prose, so an operator can see exactly what
was embedded and the price-exclusion argument is checkable by reading
the labels.

**Included** (`SEMANTIC_ENQUIRY_FIELDS`): item descriptions, waste type,
property type, floor, lift, parking, access constraints, estimated
volume, heavy/special items.

**Included** (`SEMANTIC_CASE_FACT_KEYS`): service type, item count,
estimated/actual load units, carry distance, quoted/actual dismantling,
crew size, estimated/actual labour minutes, and a closed-vocabulary
`scope_change_type`.

**Excluded, and why:**

| Excluded | Reason |
| --- | --- |
| Every monetary fact key | See [price leakage](#price-leakage-prevention) |
| `final_job_notes`, `scope_change_reason` | Free text an operator wrote; routinely mentions money |
| `customer_intent` | Untrusted free text from a customer: can contain a price they were quoted elsewhere, a competitor's name, an address, or a prompt injection. Structured `item_descriptions` is the normalised equivalent and is attacker-free. |
| `postcode`, `address` | Location is a **structured** retrieval feature (Objective 06), not a semantic one. Embedding a postcode makes every customer in a postcode a neighbour of every other — noise dressed up as similarity. |
| `travel_distance_km`, `travel_time_minutes` | Same reasoning. Travel is a real price driver, but it must be an explainable term in Objective 04's score, not a property of the vector. |

Three builder properties are enforced, not merely documented:

1. **Unknown stays absent.** A missing floor is an omitted line — not
   `floor: none`, not `floor: ground`. `tristateBoolean` returns `null`
   for `null` so an unknown never encodes as a known negative.
2. **Estimated is not actual.** Where both exist they are separately
   labelled (`job estimated load units: 1` / `job actual load units: 2`),
   so a job that came out larger does not flatten into one statement.
3. **No banding is invented.** Load units and labour minutes are emitted
   as raw numbers because load-size definitions are an unresolved
   business input (`17 - Business Inputs Needed.md`). Objective 04 owns
   structured load features.

A finalized case is described by its frozen `enquiry_facts` snapshot, not
the live `enquiries` row, so a later correction cannot silently change
what the case means. An open case is described by the live row.

## Price-leakage prevention

The critical invariant. **No monetary value ever enters embedding input.**

Two independent layers, because either alone would be weaker than the
pair:

1. **By construction.** The builders read from an explicit allowlist.
   `indexSemanticFacts` *skips* monetary keys rather than merely not
   using them — that is the one place where a future "just one more
   field" edit could quietly pull a price in.
2. **By check.** `assertNoMonetaryLeakage` re-reads the finished text
   and throws if it matches money-shaped tokens (currency symbols or
   codes next to numbers, money words) or commercial decision words
   ("accepted", "rejected").

It fails **closed**, with the offending token named, so an operator can
fix the source rather than wondering why a job will not embed.

**Why this matters for what comes next.** Retrieval must answer *"which
historical jobs were operationally similar?"*, not *"which jobs
happened to have similar prices?"*. Price and outcome information is
joined **after** comparable cases are retrieved. If a vector encoded
price, the corpus would rank by price and the quote engine would learn
to average prices of similar-priced jobs — a feedback loop with no
operational signal in it.

The structural half is enforced too: `case_embeddings` has **no
monetary column at all**, asserted by `verify-vector-memory.sql`, which
fails if one ever appears.

Covered by tests that put a price in every commercial fact, in the
customer's free-text intent, and in an item description.

## Image-observation embeddings

`buildImageObservationSemanticInput` serialises validated visual
observations. It emits item categories, approximate counts, relative
volume spans, bulky/heavy indicators, dismantling indicators, ambiguity,
and visible property notes.

It explicitly does **not** emit price, exact weight, storage paths,
signed URLs, message ids, media ids, image bytes, or the provider's raw
response. Source references remain metadata on the embedding **row**,
where traceability belongs — a signed URL in embedding input would be
both a credential leak and a transient value that would poison the
content hash.

Ambiguity is preserved, never resolved: an ambiguous observation becomes
its own line marked `uncertain` and is never merged into the confident
set. Low-quality imagery is recorded as its own observation
(`image quality: blurred`), because "these photos were dark" is exactly
the signal Objective 04 needs in order not to trust a visual match
derived from them.

Two adapters feed the same deterministic core:
`imageObservationRecordsFromAnalysis` (a live `analyze_images` result)
and `imageObservationRecordsFromSnapshot` (a finalized case's frozen
`image_analysis` snapshot). The service path uses only the snapshot —
there is deliberately **no** route that accepts observation JSON from a
request body, because an arbitrary embedding source is exactly what
would let somebody write arbitrary text into the dataset's semantic
memory.

## Source and content hashes

- `source_entity` / `source_reference` — which canonical record the
  input came from (the case, or a specific frozen snapshot) and a
  bounded non-secret reference. Never a URL, storage path, or key.
- `content_hash` — SHA-256 (lowercase hex) of the exact text handed to
  the provider. Hashed over the text and nothing else, so it is a pure
  function of the content sent.

The **identity tuple** is
`(account, case, kind, semantic input version, provider, model, model version, content hash)`.
A unique index on it makes generation idempotent: re-running an unchanged
case under an unchanged model cannot produce a second row.

## Stale and superseded vectors

Vectors are never deleted to express a lifecycle change. Deletion happens
only through the case or account cascade — i.e. only when somebody
decided the source data itself is gone.

| State | Meaning |
| --- | --- |
| `current` | Participates in active retrieval |
| `stale` | Content, builder version, or model changed; a newer row replaced it |
| `superseded` | Explicitly replaced, with `superseded_by` naming the replacement |
| `withheld` | The source case is excluded from learning. Present and auditable, never retrievable |

Staleness is detected **from data, not from a flag**: the canonical
semantic input is rebuilt and its content hash compared with the stored
one. That single comparison covers every re-embedding trigger the
roadmap lists — source changed, derived summary changed, model changed —
without the operation needing to be told which happened.

`idx_case_embeddings_one_current` enforces at most one current vector
per (account, case, kind), so a case cannot appear twice in its own
neighbourhood. Because the insert is what that index rejects, a model
upgrade retires the incumbent **first** and inserts second; the window
in which a case has no current vector is safe, because a missing current
vector reads as "not embedded yet" and the operation is resumable.

## Eligibility

`evaluateVectorMemoryEligibility` is a pure function. A case is eligible
when:

- it is **not** `learning_eligibility = 'excluded'`, and
- it provides at least **2 independent operational signals**.

Three deliberate non-requirements:

- **Evidence tier is not required.** A tier describes evidence *strength*,
  not whether a vector is worth having. Requiring tier A would mean only
  completed jobs with a collected amount could ever be recalled, and the
  dataset would be far smaller and narrower than the business.
- **Finalization is not required.** An open case with a real job
  description is a legitimate comparable.
- **Embedding generation never upgrades a case.** It cannot change an
  evidence tier or a learning eligibility; the policy is a pure function
  of inputs it does not write back.

Evidence tier and learning eligibility remain available to Objective 04
as retrieval metadata — but by **join**, not by duplication. They are
canonical columns on `historical_cases` that legitimately change while a
case is open; a copy on the vector row would drift, and retrieval would
filter on a value the case no longer holds. `loadCurrentEmbedding`
returns both.

## Privacy and deletion

Derived memory must not outlive a privacy decision.

- **Exclusion withholds.** A trigger on `historical_cases` moves the
  case's current vectors to `withheld` when it becomes excluded, and
  releases them when it is re-included. Without it, an operator's or a
  privacy request's exclusion would stop at the case row and the vector
  — which still physically contains the job description — would remain
  retrievable.
- **Withheld is fail-closed.** A privileged write cannot reactivate a
  withheld vector while its case is still excluded. Re-including the
  *case* is the only way out, and it goes through the trigger, so the
  decision stays reversible and auditable rather than destructive.
- **Insertion is fail-closed too.** A new vector cannot be stored as
  `current` for an excluded case.
- **Deletion cascades.** The composite `(historical_case_id, account_id)`
  foreign key is `ON DELETE CASCADE`, so a deleted case — or a deleted
  account — takes its derived memory with it.

`privacy_deletion` is currently an *exclusion reason* (withhold, not
delete). A future hard-delete path inherits cascade removal for free.

## Re-embedding and model upgrades

`runCaseEmbeddingOperation` is the only bulk-spend entry point.

| Property | How |
| --- | --- |
| Model/version aware | Identity tuple + content-hash comparison |
| Bounded | `limit` clamped to 1..100; at most 5 pages per run |
| Resumable | Reports `next_offset`; deterministic ordering |
| Idempotent | A second run over unchanged data generates nothing |
| Account scoped | Account from trusted auth, explicit filter in every query |
| Dry-run by default | `dry_run` defaults to **true** |
| No automatic mass calls | No migration, webhook, or capture path calls it |

Modes: `missing` (backfill only), `stale` (refresh only), `all`.

Nothing here runs automatically. Applying migration 053 generates
**zero** vectors and costs nothing.

## Operator surface

`POST /api/vector-memory`, admin-only (`canGenerateVectorMemory`,
matching the RLS write policy).

```jsonc
// dry-run is the default
{ "mode": "all", "dry_run": true, "limit": 10, "offset": 0 }
```

`GET /api/vector-memory` returns coverage counts by kind and state.

What the surface deliberately is not:

- **Not a search interface.** No query vector, no similarity, no top-k,
  no weights. Objective 04 owns retrieval; this route has no code path
  that could return a comparable job.
- **Not an arbitrary embedding source.** The only inputs are a mode, a
  bound, and an offset. Semantic content is always rebuilt from
  canonical data inside the domain layer.
- **Not account-selectable.** The account comes from the caller's
  profile; no body field can redirect a write at another tenant.
- **Not a UI.** There is no operator screen for this yet.

Responses carry case ids, outcomes, and reasons — never semantic text,
amounts, or vector values. Errors are classified; a `database_error`
does not surface the Postgres message, because driver errors echo
constraint names and row values.

## Usage and cost

Embedding spend lands in the **existing** `ai_usage_log` trail with
`mode = 'embeddings'`, alongside `auto_reply`, `draft`, and
`image_analysis`. Recorded: provider, model, kind, token usage, and a
run correlation id (breadcrumb log, since adding a column is the
monitoring objective's decision).

Never logged: API keys, vector values, image bytes, private message
bodies, or full semantic content. `logAiUsage` is fire-and-forget, so
accounting can never fail a generation run.

`ai_usage_log` skips a row when the provider reports no usage, which is
why `embedTextsWithUsage` returns the provider's usage block rather than
discarding it.

## Tenancy and RLS

- `account_id` on every row, composite `(id, account_id)` foreign keys
  for case and supersede references, so a service-role write cannot
  attach a vector to another account's case.
- Read: account members. Write: admin+. **No authenticated DELETE
  policy** — vectors are superseded, never deleted.
- `is_account_member` gates every policy; verified as `authenticated`
  (not table owner) in `verify-vector-memory.sql`.

## Distance metric and index choice

**Cosine.** Every registered model emits L2-normalised vectors, so
cosine distance and inner product rank identically, and cosine is what
`match_ai_knowledge_semantic` already uses — one metric across both
vector stores rather than two that disagree by a scale factor.

**HNSW, not IVFFlat**, for the reason recorded in migration 030:
per-account case vectors start empty and grow incrementally, and
IVFFlat must be trained on existing rows, so its centroids are
meaningless — and its recall poor — until the table is large enough to
`REINDEX`. HNSW needs no training.

**Compatibility groups.** One HNSW index is correct today because the
registry holds exactly one entry, so every row is a comparable
1536-dimension OpenAI vector. If a second model is registered, it must
**not** share this index: it gets its own column and its own index, and
Objective 04 selects by compatibility group. Mixing two vector spaces in
one ANN index is the classic silent-wrong-answer bug.

Filters (`state`, `account_id`) are applied by the caller above the ANN
scan. At learning-dataset scale (hundreds to low thousands of vectors
per account) a partial index is not worth the write-path complexity;
revisit when it is.

## Transient query embeddings

`buildTransientQueryEmbedding` returns a vector for a live enquiry,
computed and returned but **never persisted**. It uses the same builder
and the same version tag as a stored case vector, which is what makes a
query vector comparable with the corpus at all.

It does not create a historical case. A live enquiry is not a learning
example, it is a question; persisting one so a query could be answered
would grow the training dataset with every message that arrives.

It does not retrieve. Objective 04 takes the vector and searches.

## Deferred, deliberately

- **Similar-job / similar-image retrieval and ranking** (Objective 04).
  The retrieval population query exists; the search does not.
- **Native image embeddings.** See above.
- **Persistent validated image observations.** `analyze_images` still
  returns observations to the caller rather than storing them, so the
  `image_observation_text` path is implemented and tested but has no
  production producer yet beyond a finalized case's `image_analysis`
  snapshot. Persisting live observations is outcome-capture/operator
  work.
- **A durable operator action log** for embedding runs (the monitoring
  objective). Today a run is traceable by its correlation id in
  `ai_usage_log` and the server log.
- **An operator UI** for coverage or re-embedding.
- **Retrieval-weight tuning, distance/latency tuning at scale.**
