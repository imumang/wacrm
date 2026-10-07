/**
 * Objective 02 (Historical Import and Normalization) - the source
 * inventory.
 *
 * This module answers one question for every historical source inside
 * WACRM: **what is it, how much does it prove, and can it safely become
 * a historical-case fact?**
 *
 * It exists as code rather than as a paragraph in a document because
 * the inventory has to be answerable at run time. The importer reports
 * what it found and what it deliberately refused to map, and a report
 * that is generated from the same table that drove the mapping cannot
 * drift away from the behaviour it describes.
 *
 * Every entry is derived from the schema and the application behaviour,
 * not from a wish. Where the honest answer is "this exists but its
 * meaning is not established", the entry says exactly that and the
 * importer refuses to map it. Two entries in particular are the ones
 * most likely to be got wrong by somebody in a hurry:
 *
 * - `deals` is NOT a quote. It is a generic pipeline row. `value` is
 *   pipeline value, `status` is free text defaulting to `'active'`, and
 *   there is no approval, no customer decision and no completed state.
 *   Mapping it into `customer_facing_quote_amount` would manufacture a
 *   quote lifecycle this application has never had.
 *
 * - `messages` is NOT structured quote data. Monetary values appear in
 *   message text all the time, and none of them is a quote until
 *   something deterministic says so. There is no such thing here.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  HISTORICAL_IMPORT_SKIP_REASONS,
  type HistoricalImportFinding,
  type HistoricalImportSkipReason,
  type HistoricalImportSourceType,
} from './model';

/**
 * What kind of statement a source record makes.
 *
 * This is the question that decides provenance, and it is not the same
 * as "who typed it". A number an operator typed into a pipeline row and
 * a number somebody read off a weighbridge ticket are both typed by a
 * person and are not remotely the same kind of evidence.
 */
export type HistoricalSourceSemantic =
  | 'customer_statement'
  | 'operator_entry'
  | 'ai_output'
  | 'commercial_decision'
  | 'actual_outcome'
  | 'structural_reference'
  | 'unknown';

export interface HistoricalSourceInventoryEntry {
  /** The source adapter this entry describes. */
  source_type: HistoricalImportSourceType;
  /** The canonical tables that hold it. */
  tables: readonly string[];
  /** What the source actually is, in business terms. */
  semantic_meaning: string;
  /** How much the record can be trusted, and why. */
  reliability:
    | 'canonical'
    | 'operational'
    | 'unproven'
    | 'not_applicable';
  /** The strongest kind of statement the record makes. */
  semantic_class: HistoricalSourceSemantic;
  /** Whether any of it may populate a historical-case fact. */
  mappable_to_case_fact: boolean;
  /** The provenance an imported fact would carry. */
  expected_provenance: string;
  /** What the evidence tier can become, and what it cannot. */
  evidence_quality_impact: string;
  /** The specific ways this source can mislead an importer. */
  known_ambiguity: readonly string[];
  /** Why the importer skips it, when it skips it. */
  skip_reason: HistoricalImportSkipReason | null;
  /** Run-level finding this entry triggers, when it applies. */
  finding: HistoricalImportFinding | null;
}

/**
 * The inventory. One entry per adapter, and every claim here is
 * traceable to the schema or to existing application behaviour.
 */
export const HISTORICAL_SOURCE_INVENTORY: readonly HistoricalSourceInventoryEntry[] =
  [
    {
      source_type: 'enquiries',
      tables: ['enquiries', 'enquiry_state_events'],
      semantic_meaning:
        'A durable job record inside one WhatsApp conversation. Created explicitly by the enquiry domain layer, never inferred from a message, and never backfilled for history.',
      reliability: 'canonical',
      semantic_class: 'operator_entry',
      mappable_to_case_fact: true,
      expected_provenance: 'imported_historical',
      evidence_quality_impact:
        'Supplies the canonical annotation facts (postcode, address, property type, floor, lift, parking, access, items, waste type, estimated volume, heavy/special items, photos). Supplies NO price, decision or outcome, so an imported case classifies as unclassified unless a later capture adds them. Never becomes tier A from import alone.',
      known_ambiguity: [
        'A populated column does not say whether the customer said it or an operator typed it. That provenance is genuinely lost, so imported_historical is the only honest label.',
        'workflow_state records a workflow boundary, not a business outcome. A cancelled enquiry is a lost enquiry; it is never read as a rejected price and never as a completed job.',
        'estimated_volume and the item list are free text. They are annotated, never parsed into a load count.',
        'preferred_date and preferred_time_window have no fact key. They belong to a booking domain this application does not have.',
      ],
      skip_reason: null,
      finding: null,
    },
    {
      source_type: 'legacy_conversations',
      tables: ['conversations', 'messages'],
      semantic_meaning:
        'Pre-enquiry WhatsApp history: the permanent thread for a contact, which may contain several real jobs and may contain none.',
      reliability: 'operational',
      semantic_class: 'unknown',
      mappable_to_case_fact: false,
      expected_provenance: 'imported_historical',
      evidence_quality_impact:
        'None. Nothing here is imported, so nothing here changes a tier.',
      known_ambiguity: [
        'One conversation is NOT one job. A contact can clear out a garage in March and a flat in July in the same thread.',
        'There is no deterministic marker of where one enquiry ends and the next begins. Inventing one would be guessing, and guessing conversation segmentation with a language model is explicitly out of scope for this objective.',
        'A closed conversation is inbox hygiene, not a commercial outcome. Silence is not a rejection.',
        'The age of a conversation says nothing about whether a job happened.',
      ],
      skip_reason: 'requires_enquiry_segmentation',
      finding: 'legacy_conversations_require_segmentation',
    },
    {
      source_type: 'deals',
      tables: ['deals', 'pipelines', 'pipeline_stages'],
      semantic_meaning:
        'A generic CRM pipeline row: a card on a kanban board with a title, a pipeline value, a free-text status and an optional expected close date.',
      reliability: 'unproven',
      semantic_class: 'unknown',
      mappable_to_case_fact: false,
      expected_provenance: 'imported_historical',
      evidence_quality_impact:
        'None. Nothing here is imported.',
      known_ambiguity: [
        'deals.value is pipeline value. There is no evidence anywhere in the schema or the application that it was ever the number sent to a customer.',
        'deals.status is free text defaulting to active, with no won/lost semantics enforced anywhere.',
        'There is no quote approval, no customer-facing amount and no customer decision attached to a deal, so a deal cannot answer any of the commercial questions the case model asks.',
        'deals.expected_close_date is a forecast, not an observation.',
      ],
      skip_reason: 'source_semantics_unproven',
      finding: 'no_structured_quote_source',
    },
  ];

/**
 * Historical sources the roadmap asks about that did not exist in the
 * pre-052 data. The new quote table is an operational destination, not
 * evidence that retroactively gives old messages or deals quote semantics.
 *
 * Recorded so that "we did not import the invoices" is a verified
 * statement rather than an omission somebody will later wonder about.
 */
export const HISTORICAL_ABSENT_SOURCES: readonly {
  readonly source: string;
  readonly finding: HistoricalImportFinding;
  readonly note: string;
}[] = [
  {
    source: 'structured quotes',
    finding: 'no_structured_quote_source',
    note: 'No pre-052 structured historical quote, invoice or payment source exists. The canonical quotes table records the new workflow and does not prove the meaning of legacy deals.value or prices mentioned in messages.',
  },
  {
    source: 'invoices and payments',
    finding: 'no_structured_outcome_source',
    note: 'No payment, invoice, weighbridge or disposal-receipt entity exists. There is no structured record anywhere of what a customer was finally charged.',
  },
  {
    source: 'load and disposal records',
    finding: 'no_structured_outcome_source',
    note: 'No table records an actual load, a disposal weight, a crew size or an on-site labour duration. The fact keys exist and stay empty.',
  },
  {
    source: 'diary and calendar',
    finding: 'no_structured_outcome_source',
    note: 'There is no calendar, diary or booking table. Historical jobs cannot be recovered from a schedule that was never in this system.',
  },
  {
    source: 'external CRM / spreadsheet exports',
    finding: 'no_structured_quote_source',
    note: 'No NocoDB connection, import table or staging area exists. Anything held outside WACRM is outside this importer by construction; a file-based adapter would be a separate, explicitly reviewed change.',
  },
];

// ---------------------------------------------------------------------------
// Live inspection
// ---------------------------------------------------------------------------

export interface HistoricalSourceCounts {
  enquiries: number;
  enquiries_already_imported: number;
  legacy_conversations: number;
  deals: number;
  deals_with_value: number;
  }

export interface HistoricalSourceInspection {
  account_id: string;
  counts: HistoricalSourceCounts;
  /** What would be imported, per adapter, before anything is written. */
  mappable: Record<HistoricalImportSourceType, number>;
  /** What is present but deliberately not mapped, per adapter. */
  unmappable: Record<HistoricalImportSourceType, number>;
  findings: HistoricalImportFinding[];
  inventory: readonly HistoricalSourceInventoryEntry[];
  /**
   * Roadmap sources that do not exist in WACRM at all, so "we did not
   * import the invoices" is a verified statement rather than an
   * omission somebody will later wonder about.
   */
  absent_sources: typeof HISTORICAL_ABSENT_SOURCES;
}

/**
 * Count what is actually there, so an operator can see the shape of
 * their own history before agreeing to import any of it.
 *
 * Every read is account-scoped and bounded. Nothing here writes, and
 * nothing here reads customer content - it counts rows and asks whether
 * a row has already been attributed.
 */
export async function inspectHistoricalSources(
  db: SupabaseClient,
  input: { accountId: string; limit: number }
): Promise<HistoricalSourceInspection> {
  const { accountId } = input;
  const limit = Math.max(1, Math.trunc(input.limit));

  const [enquiries, importedEnquiries, conversations, deals] =
    await Promise.all([
      countRows(db, 'enquiries', accountId, limit, 'id'),
      countAttributedEnquiries(db, accountId, limit),
      countLegacyConversations(db, accountId, limit),
      countDeals(db, accountId, limit),
    ]);

  const counts: HistoricalSourceCounts = {
    enquiries,
    enquiries_already_imported: importedEnquiries,
    legacy_conversations: conversations,
    deals: deals.count,
    deals_with_value: deals.withValue,
  };

  const findings: HistoricalImportFinding[] = [];
  if (conversations > 0) {
    findings.push('legacy_conversations_require_segmentation');
  }
  // Both of these are properties of the installation rather than of a
  // record, and they are true of every WACRM schema to date - so they
  // are reported rather than inferred.
  findings.push('no_structured_quote_source');
  findings.push('no_structured_outcome_source');

  return {
    account_id: accountId,
    counts,
    mappable: {
      enquiries,
      legacy_conversations: 0,
      deals: 0,
    },
    unmappable: {
      enquiries: 0,
      legacy_conversations: conversations,
      deals: deals.count,
    },
    findings,
    inventory: HISTORICAL_SOURCE_INVENTORY,
    absent_sources: HISTORICAL_ABSENT_SOURCES,
  };
}

async function countRows(
  db: SupabaseClient,
  table: string,
  accountId: string,
  limit: number,
  column: string
): Promise<number> {
  // A bounded select rather than `head: true, count: 'exact'`. A count
  // would be one row of metadata instead of `limit` ids, and the
  // importer needs the ids anyway; capping at `limit` keeps the whole
  // inspection proportional to the page the caller asked for.
  const { data, error } = await db
    .from(table)
    .select(column)
    .eq('account_id', accountId)
    .limit(limit);
  if (error) {
    throw new Error(`Could not count ${table}`);
  }
  return Math.min((data ?? []).length, limit);
}

/**
 * How many of this account's enquiries already carry a source ledger
 * entry. The difference from the total is the number of genuinely new
 * cases an import would add, which is the number an operator wants.
 */
async function countAttributedEnquiries(
  db: SupabaseClient,
  accountId: string,
  limit: number
): Promise<number> {
  const { data, error } = await db
    .from('historical_case_sources')
    .select('source_record_id')
    .eq('account_id', accountId)
    .eq('source_kind', 'enquiry')
    .limit(limit);
  if (error) {
    throw new Error('Could not read the historical case source ledger');
  }
  return Math.min((data ?? []).length, limit);
}

/**
 * Conversations with no enquiry row at all.
 *
 * `messages` carries no account_id (migration 017 reaches it through
 * its conversation), so the count goes through the conversation
 * membership instead of filtering messages directly.
 */
async function countLegacyConversations(
  db: SupabaseClient,
  accountId: string,
  limit: number
): Promise<number> {
  const { data, error } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .limit(limit);
  if (error) {
    throw new Error('Could not count legacy conversations');
  }
  const ids = (data ?? []).map((row) => String(row.id));
  if (ids.length === 0) return 0;

  const { data: withEnquiry, error: enquiryError } = await db
    .from('enquiries')
    .select('conversation_id')
    .eq('account_id', accountId)
    .in('conversation_id', ids);
  if (enquiryError) {
    throw new Error('Could not read enquiries for legacy conversations');
  }
  const covered = new Set(
    (withEnquiry ?? []).map((row) => String(row.conversation_id))
  );
  return Math.min(
    ids.filter((id) => !covered.has(id)).length,
    limit
  );
}

async function countDeals(
  db: SupabaseClient,
  accountId: string,
  limit: number
): Promise<{ count: number; withValue: number }> {
  const { data, error } = await db
    .from('deals')
    .select('id, value')
    .eq('account_id', accountId)
    .limit(limit);
  if (error) {
    throw new Error('Could not count deals');
  }
  const rows = data ?? [];
  return {
    count: Math.min(rows.length, limit),
    withValue: Math.min(
      rows.filter((row) => Number(row.value ?? 0) > 0).length,
      limit
    ),
  };
}

/** Every reason the importer can report, so a caller can enumerate them. */
export const HISTORICAL_IMPORT_REPORTABLE_SKIP_REASONS =
  HISTORICAL_IMPORT_SKIP_REASONS;
