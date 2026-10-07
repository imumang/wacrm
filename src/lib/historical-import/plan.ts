/**
 * Objective 02 (Historical Import and Normalization) - the planner.
 *
 * Pure. It reads source rows and current case state and returns a plan;
 * it performs no I/O and holds no client. That is what makes the dry run
 * trustworthy: `dryRunHistoricalImport` and `executeHistoricalImport`
 * run *this* function and differ only in whether they apply the result.
 * A dry run is therefore not a second implementation of the mapping
 * that could disagree with the first one - it is the same mapping with
 * the writes switched off.
 *
 * The rules the planner encodes, and the reason each exists:
 *
 * 1. **One enquiry is one case, always.** The objective-01 identity
 *    guarantee (`historical_cases_one_per_enquiry`) is what the whole
 *    one-case-per-job model rests on. The planner never proposes a
 *    second case for an enquiry.
 *
 * 2. **A case with a ledger entry is already imported.** The source
 *    ledger is the idempotency marker, so a second run examines the
 *    same rows, writes nothing and reports the same numbers.
 *
 * 3. **A finalized case is never touched.** Not amended, not enriched,
 *    not annotated. It is reported as a conflict so a human decides
 *    what an already-frozen training example should learn from a source
 *    that arrived later.
 *
 * 4. **Only annotations, never values, are imported from an enquiry.**
 *    An enquiry column already holds its value on the canonical row.
 *    What a case adds is the *provenance* of that value, and there is
 *    exactly one honest provenance available for a value WACRM received
 *    without learning who typed it: `imported_historical`.
 *
 * 5. **Nothing is inferred from a workflow state.** A cancelled
 *    enquiry is a lost enquiry. It never becomes a rejected price, it
 *    never becomes a completed job, and it never becomes a
 *    `no_response` - silence is silence, and `no_response` is a
 *    recorded decision, not an absence nobody noticed.
 *
 * 6. **No price, ever.** The planner has no code path that writes any
 *    monetary fact from any source, because no structured monetary
 *    source exists in WACRM to write from.
 */

import {
  type HistoricalCaseFact,
  type HistoricalCaseFactInput,
} from '../historical-cases/model';
import {
  normalizeInstant,
  normalizeText,
  normalizeTextList,
  normalizeUkPostcode,
} from './normalize';
import {
  decideImportedFact,
  eligibilityForImportQuality,
  sourceRef,
  type HistoricalImportConflictReason,
  type HistoricalImportEligibilityDecision,
  type HistoricalImportQuality,
  type HistoricalImportSkipReason,
  type HistoricalImportSourceKind,
} from './model';
import type { HistoricalImportEnquiryRow } from './repository';

/** One canonical `enquiries` column and the fact key that annotates it. */
interface CanonicalColumnMapping {
  readonly fact_key: string;
  readonly column: string;
  readonly kind: 'text' | 'text_list' | 'boolean' | 'postcode';
}

/**
 * The thirteen canonical facts an enquiry can annotate.
 *
 * Exactly the objective-01 canonical vocabulary - nothing added, and
 * `preferred_date` / `preferred_time_window` deliberately absent: they
 * belong to a booking domain this application does not have, and a
 * preferred date is not an observation of anything.
 */
const CANONICAL_COLUMN_MAPPINGS: readonly CanonicalColumnMapping[] = [
  { fact_key: 'customer_intent', column: 'customer_intent', kind: 'text' },
  { fact_key: 'postcode', column: 'postcode', kind: 'postcode' },
  { fact_key: 'address', column: 'address', kind: 'text' },
  { fact_key: 'property_type', column: 'property_type', kind: 'text' },
  { fact_key: 'floor', column: 'floor', kind: 'text' },
  { fact_key: 'lift_available', column: 'lift_available', kind: 'boolean' },
  { fact_key: 'parking', column: 'parking', kind: 'text' },
  { fact_key: 'access_constraints', column: 'access_constraints', kind: 'text_list' },
  { fact_key: 'item_descriptions', column: 'item_descriptions', kind: 'text_list' },
  { fact_key: 'waste_type', column: 'waste_type', kind: 'text' },
  { fact_key: 'estimated_volume', column: 'estimated_volume', kind: 'text' },
  {
    fact_key: 'heavy_special_items',
    column: 'heavy_special_items',
    kind: 'text_list',
  },
  { fact_key: 'photos_received', column: 'photos_received', kind: 'boolean' },
];

/** The canonical table an enquiry row came from. */
export const IMPORT_SOURCE_SYSTEM_ENQUIRY = 'wacrm.enquiries';
/** The canonical table a message reference came from. */
export const IMPORT_SOURCE_SYSTEM_MESSAGE = 'wacrm.messages';

/** Why an enquiry maps one-for-one onto a case. A stable vocabulary phrase. */
export const IMPORT_REASON_ENQUIRY_EXACT =
  'one enquiry is one job record and maps one-for-one onto a case';

export interface ImportMediaPlan {
  readonly sourceRecordId: string;
  readonly observedAt: string | null;
  readonly quality: HistoricalImportQuality;
  readonly qualityReasons: readonly string[];
}

export type EnquiryImportOutcome =
  | {
      readonly outcome: 'skip';
      readonly sourceKind: HistoricalImportSourceKind;
      readonly sourceRecordId: string;
      readonly ref: string;
      readonly reason: HistoricalImportSkipReason;
      readonly quality: HistoricalImportQuality;
    }
  | {
      readonly outcome: 'conflict';
      readonly enquiryId: string;
      readonly ref: string;
      readonly reason: HistoricalImportConflictReason;
      readonly quality: HistoricalImportQuality;
      readonly qualityReasons: readonly string[];
    }
  | {
      readonly outcome: 'plan';
      readonly enquiryId: string;
      readonly conversationId: string;
      readonly ref: string;
      readonly quality: HistoricalImportQuality;
      readonly qualityReasons: readonly string[];
      readonly observedAt: string | null;
      readonly facts: readonly HistoricalCaseFactInput[];
      /**
       * Facts that were proposed and then not written because the case
       * already says something stronger or different.
       *
       * Reported rather than applied, so an operator can see exactly
       * which keys disagreed instead of discovering it as a silent
       * no-op later.
       */
      readonly conflicts: readonly {
        readonly factKey: string;
        readonly reason: HistoricalImportConflictReason;
      }[];
      /** True when the case already exists and is being added to. */
      readonly reusingCase: boolean;
      readonly media: readonly ImportMediaPlan[];
      readonly eligibility: HistoricalImportEligibilityDecision | null;
    };

export interface PlanEnquiryInput {
  readonly enquiry: HistoricalImportEnquiryRow;
  /** The existing case for this enquiry, when one exists. */
  readonly existingCase: { readonly finalizedAt: string | null } | null;
  /** The facts already on that case, for conflict resolution. */
  readonly existingFacts: readonly HistoricalCaseFact[];
  /** True when the source ledger already attributes this enquiry. */
  readonly alreadyAttributed: boolean;
  /** Bounded inbound media references for the enquiry's conversation. */
  readonly mediaReferences: readonly {
    readonly id: string;
    readonly created_at: string;
  }[];
}

/**
 * Decide what to do with one enquiry.
 *
 * The order of the checks is the whole policy:
 *
 *   already attributed  -> skip (idempotency)
 *   finalized case      -> conflict (never mutate frozen truth)
 *   otherwise           -> plan annotations, honouring per-fact conflicts
 */
export function planEnquiryImport(
  input: PlanEnquiryInput
): EnquiryImportOutcome {
  const enquiryId = String(input.enquiry.id ?? '');
  const conversationId = String(input.enquiry.conversation_id ?? '');
  const ref = sourceRef('enquiry', enquiryId);

  if (enquiryId === '') {
    return {
      outcome: 'skip',
      sourceKind: 'enquiry',
      sourceRecordId: '(missing id)',
      ref: sourceRef('enquiry', '(missing id)'),
      reason: 'unusable_source',
      quality: 'unusable',
    };
  }

  if (input.alreadyAttributed) {
    return {
      outcome: 'skip',
      sourceKind: 'enquiry',
      sourceRecordId: enquiryId,
      ref,
      reason: 'already_imported',
      quality: 'exact',
    };
  }

  if (input.existingCase?.finalizedAt != null) {
    return {
      outcome: 'conflict',
      enquiryId,
      ref,
      reason: 'finalized_case_not_mutated',
      quality: 'exact',
      qualityReasons: [
        'the case is finalized, so new imported evidence is reported rather than applied',
      ],
    };
  }

  // `created_at` rather than `state_changed_at`: it is the enquiry's own
  // creation instant, the database refuses to let it change, and it is
  // therefore stable across re-runs. `state_changed_at` moves as the
  // enquiry progresses, and an "observed at" that changes when nothing
  // was re-imported would make idempotency impossible to reason about.
  const observedAt = normalizeInstant(input.enquiry.created_at);

  const unmappable: string[] = [];
  const candidates: HistoricalCaseFactInput[] = [];

  for (const mapping of CANONICAL_COLUMN_MAPPINGS) {
    const raw = input.enquiry[mapping.column];
    if (isAbsent(raw, mapping.kind)) continue;

    if (!isUsableValue(raw, mapping.kind)) {
      unmappable.push(
        `${mapping.column} is not a recognisable ${describeKind(mapping.kind)}`
      );
      continue;
    }

    candidates.push({
      fact_key: mapping.fact_key as HistoricalCaseFactInput['fact_key'],
      value_source: 'canonical',
      provenance: 'imported_historical',
      observed_at: observedAt,
    });
  }

  // Existing facts are resolved one by one, and a conflict removes a
  // candidate rather than overwriting what is already there. This is
  // where "do not downgrade trustworthy provenance" and "do not
  // overwrite newer confirmed outcome data" are enforced.
  const existingByKey = new Map(
    input.existingFacts.map((fact) => [fact.fact_key, fact])
  );
  const facts: HistoricalCaseFactInput[] = [];
  const conflicts: Array<{
    factKey: string;
    reason: HistoricalImportConflictReason;
  }> = [];
  for (const candidate of candidates) {
    const decision = decideImportedFact(
      existingByKey.get(candidate.fact_key) ?? null,
      candidate
    );
    if (decision.action === 'write') {
      facts.push(candidate);
    } else if (decision.action === 'conflict') {
      conflicts.push({ factKey: candidate.fact_key, reason: decision.reason });
    }
  }

  if (facts.length === 0 && unmappable.length === 0) {
    return {
      outcome: 'skip',
      sourceKind: 'enquiry',
      sourceRecordId: enquiryId,
      ref,
      reason: 'no_mappable_facts',
      quality: 'unusable',
    };
  }

  const qualityReasons: string[] = [IMPORT_REASON_ENQUIRY_EXACT];
  if (unmappable.length > 0) {
    // Bounded: the reason list is stored on the ledger row, and a
    // pathological enquiry must not turn into an unbounded string.
    qualityReasons.push(...unmappable.slice(0, 5));
  }

  return {
    outcome: 'plan',
    enquiryId,
    conversationId,
    ref,
    quality: unmappable.length > 0 ? 'partial' : 'exact',
    qualityReasons,
    observedAt,
    facts,
    conflicts,
    reusingCase: input.existingCase !== null,
    media: input.mediaReferences.map(planMediaReference),
    eligibility: eligibilityForImportQuality(
      unmappable.length > 0 ? 'partial' : 'exact'
    ),
  };
}

function planMediaReference(reference: {
  id: string;
  created_at: string;
}): ImportMediaPlan {
  const observedAt = normalizeInstant(reference.created_at);
  if (observedAt === null) {
    return {
      sourceRecordId: reference.id,
      observedAt: null,
      quality: 'partial',
      qualityReasons: [
        'the message row is a canonical reference but carries no usable timestamp',
      ],
    };
  }
  return {
    sourceRecordId: reference.id,
    observedAt,
    quality: 'high_confidence_mapping',
    qualityReasons: [
      'a canonical inbound media reference; no image observation is claimed',
    ],
  };
}

/**
 * Plan one legacy conversation with no enquiry row.
 *
 * Not a mapping, a refusal with a reason. The importer will not decide
 * where one job ends and the next begins inside a single thread, and it
 * will not ask a language model to decide either - that is the single
 * most reliable way to manufacture case boundaries that never existed.
 *
 * Consequence, stated plainly: pre-enquiry history is currently
 * unreachable by this importer. Recovering it needs deterministic
 * operator segmentation - or an objective that defines a defensible
 * segmentation rule - before any of it can become a training case.
 */
export function planLegacyConversation(conversationId: string): {
  outcome: 'skip';
  sourceKind: HistoricalImportSourceKind;
  sourceRecordId: string;
  ref: string;
  reason: HistoricalImportSkipReason;
  quality: HistoricalImportQuality;
} {
  return {
    outcome: 'skip',
    sourceKind: 'legacy_conversation',
    sourceRecordId: conversationId,
    ref: sourceRef('legacy_conversation', conversationId),
    reason: 'requires_enquiry_segmentation',
    quality: 'unusable',
  };
}

/**
 * Plan one deal row.
 *
 * A pipeline row is not a quote. `value` is pipeline value, `status` is
 * free text, and neither has been shown by the schema, the application
 * or the documentation to mean "the number we sent the customer". So
 * the deal is reported as an available-but-unmapped source and nothing
 * else: no amount, no decision, no outcome.
 */
export function planDeal(deal: {
  id: string;
  value: number | null;
  status: string | null;
}): {
  outcome: 'skip';
  sourceKind: HistoricalImportSourceKind;
  sourceRecordId: string;
  ref: string;
  reason: HistoricalImportSkipReason;
  quality: HistoricalImportQuality;
} {
  return {
    outcome: 'skip',
    sourceKind: 'deal',
    sourceRecordId: deal.id,
    ref: sourceRef('deal', deal.id),
    reason: 'source_semantics_unproven',
    quality: 'unusable',
  };
}

// ---------------------------------------------------------------------------
// Value inspection
// ---------------------------------------------------------------------------

function isAbsent(raw: unknown, kind: CanonicalColumnMapping['kind']): boolean {
  if (raw === null || raw === undefined) return true;
  if (kind === 'text_list') return !Array.isArray(raw) || raw.length === 0;
  if (kind === 'boolean') return typeof raw !== 'boolean';
  if (typeof raw !== 'string') return true;
  return raw.trim() === '';
}

/**
 * Whether a populated source value is usable *as evidence that the
 * column holds what it claims to hold*.
 *
 * A recognizer, never a repair. `postcode = 'n/a'` is not a postcode
 * somebody fat-fingered; it is a cell that does not contain a postcode,
 * and importing it as a postcode annotation would put "this job had a
 * postcode" into the dataset when what is actually known is "somebody
 * typed something here once".
 */
function isUsableValue(
  raw: unknown,
  kind: CanonicalColumnMapping['kind']
): boolean {
  switch (kind) {
    case 'text':
      return normalizeText(raw) !== null;
    case 'text_list':
      return normalizeTextList(raw) !== null;
    case 'boolean':
      return typeof raw === 'boolean';
    case 'postcode':
      return normalizeUkPostcode(raw) !== null;
    default:
      return false;
  }
}

function describeKind(kind: CanonicalColumnMapping['kind']): string {
  switch (kind) {
    case 'text_list':
      return 'list of values';
    case 'postcode':
      return 'UK postcode';
    default:
      return kind;
  }
}