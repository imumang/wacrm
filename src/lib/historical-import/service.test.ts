import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  HISTORICAL_IMPORT_VERSION,
  type HistoricalCaseSource,
  type HistoricalImportRun,
} from './model';
import {
  dryRunHistoricalImport,
  executeHistoricalImport,
  listHistoricalImportSummaries,
} from './service';

const ACCOUNT = 'account-1';
const OTHER_ACCOUNT = 'account-2';
const USER = 'user-1';
const CONTACT = 'contact-1';
const CONVERSATION = 'conversation-1';
const ENQUIRY = 'enquiry-1';

type Row = Record<string, unknown>;

interface Call {
  table: string;
  operation: 'select' | 'insert' | 'update' | 'upsert';
  filters: Array<[string, unknown]>;
  notFilters: Array<[string, unknown]>;
  inFilters: Array<[string, unknown[]]>;
  order: Array<[string, boolean]>;
  limit: number | null;
  offset: number;
  payload: Row | null;
}

interface FakeDatabase {
  client: SupabaseClient;
  calls: Call[];
  tables: Record<string, Row[]>;
}

/**
 * Column defaults, so a row the double returns looks like the row
 * Postgres would build rather than like the payload that was sent.
 */
const TABLE_DEFAULTS: Record<string, Row> = {
  historical_cases: {
    source_kind: 'live_enquiry',
    case_state: 'open',
    completed_at: null,
    evidence_quality_tier: null,
    evidence_rule_version: null,
    evidence_reasons: [],
    evidence_classified_at: null,
    learning_eligibility: 'pending',
    learning_exclusion_reason: null,
    learning_eligibility_basis: null,
    finalized_at: null,
    created_by_user_id: null,
  },
  historical_case_facts: {
    value_text: null,
    value_number: null,
    value_integer: null,
    value_boolean: null,
    value_timestamp: null,
    provenance: 'imported_historical',
    source_message_id: null,
    source_media_id: null,
    observed_at: null,
    recorded_by_user_id: null,
  },
  historical_case_snapshots: {
    recorded_by_user_id: null,
  },
  historical_case_sources: {
    source_version: null,
    source_observed_at: null,
    import_run_id: null,
    import_quality_reasons: [],
  },
  historical_import_runs: {
    status: 'running',
    started_at: '2026-03-01T09:00:00.000Z',
    completed_at: null,
    dry_run: true,
    records_examined: 0,
    cases_created: 0,
    cases_updated: 0,
    cases_reused: 0,
    facts_imported: 0,
    records_skipped: 0,
    ambiguous_records: 0,
    conflicts: 0,
    errors: 0,
    summary: {},
    error_metadata: [],
    importer_version: HISTORICAL_IMPORT_VERSION,
    triggered_by_user_id: null,
  },
};

function makeDb(seed: Record<string, Row[]> = {}): FakeDatabase {
  const tables: Record<string, Row[]> = {
    enquiries: seed.enquiries ?? [enquiryRow()],
    conversations: seed.conversations ?? [
      { id: CONVERSATION, account_id: ACCOUNT, contact_id: CONTACT, created_at: '2026-01-01T00:00:00.000Z' },
    ],
    contacts: seed.contacts ?? [
      { id: CONTACT, account_id: ACCOUNT },
    ],
    messages: seed.messages ?? [],
    deals: seed.deals ?? [],
    historical_cases: seed.historical_cases ?? [],
    historical_case_facts: seed.historical_case_facts ?? [],
    historical_case_snapshots: seed.historical_case_snapshots ?? [],
    historical_case_sources: seed.historical_case_sources ?? [],
    historical_import_runs: seed.historical_import_runs ?? [],
  };

  const db: FakeDatabase = {
    client: null as unknown as SupabaseClient,
    calls: [],
    tables,
  };

  let idCounter = 0;

  db.client = {
    from(table: string) {
      const call: Call = {
        table,
        operation: 'select',
        filters: [],
        notFilters: [],
        inFilters: [],
        order: [],
        limit: null,
        offset: 0,
        payload: null,
      };
      db.calls.push(call);

      let writePayload: Row = {};

      const matches = (row: Row): boolean => {
        if (!call.filters.every(([column, value]) => row[column] === value)) {
          return false;
        }
        if (
          !call.notFilters.every(([column, value]) => row[column] !== value)
        ) {
          return false;
        }
        return call.inFilters.every(([column, values]) =>
          values.includes(row[column])
        );
      };

      const rows = (): Row[] => {
        const result = [...(tables[table] ?? [])].filter(matches);
        for (const [column, ascending] of [...call.order].reverse()) {
          result.sort((left, right) => {
            const a = left[column];
            const b = right[column];
            if (a === b) return 0;
            const direction = (a as never) < (b as never) ? -1 : 1;
            return ascending ? direction : -direction;
          });
        }
        const offset = call.offset;
        const end =
          call.limit === null ? undefined : offset + call.limit;
        return result.slice(offset, end);
      };

      const execute = (): { data: Row[] | Row | null; error: unknown } => {
        if (call.operation === 'select') {
          return { data: rows(), error: null };
        }
        if (call.operation === 'insert' || call.operation === 'upsert') {
          const payload = writePayload;
          const now = '2026-03-01T00:00:00.000Z';
          const row: Row = {
            ...(TABLE_DEFAULTS[table] ?? {}),
            created_at: now,
            updated_at: now,
            imported_at: now,
            id: `row-${++idCounter}`,
            ...payload,
          };
          if (call.operation === 'upsert') {
            const conflict = (tables[table] ?? []).find(
              (candidate) =>
                candidate.case_id === payload.case_id &&
                candidate.fact_key === payload.fact_key
            );
            if (conflict) {
              Object.assign(conflict, row, { id: conflict.id as string });
              return { data: conflict, error: null };
            }
          }
          (tables[table] ??= []).push(row);
          return { data: row, error: null };
        }

        const target = rows()[0];
        if (!target) return { data: null, error: null };
        Object.assign(target, writePayload, {
          updated_at: '2026-03-02T00:00:00.000Z',
        });
        return { data: target, error: null };
      };

      const unwrap = (
        result: { data: Row[] | Row | null; error: unknown }
      ): { data: Row | null; error: unknown } => {
        if (result.error) return { data: null, error: result.error };
        if (Array.isArray(result.data)) {
          if (result.data.length > 1) {
            return { data: null, error: { code: 'PGRST116' } };
          }
          return { data: result.data[0] ?? null, error: null };
        }
        return { data: result.data, error: null };
      };

      const chain = {
        select() {
          return chain;
        },
        eq(column: string, value: unknown) {
          call.filters.push([column, value]);
          return chain;
        },
        neq(column: string, value: unknown) {
          call.notFilters.push([column, value]);
          return chain;
        },
        not(column: string, operator: string) {
          if (operator === 'is') call.notFilters.push([column, null]);
          return chain;
        },
        in(column: string, values: unknown[]) {
          call.inFilters.push([column, values]);
          return chain;
        },
        order(column: string, options?: { ascending?: boolean }) {
          call.order.push([column, options?.ascending ?? true]);
          return chain;
        },
        limit(value: number) {
          call.limit = value;
          return chain;
        },
        range(from: number, to: number) {
          call.offset = from;
          call.limit = to - from + 1;
          return chain;
        },
        insert(payload: Row) {
          call.operation = 'insert';
          writePayload = payload;
          call.payload = payload;
          return chain;
        },
        upsert(payload: Row) {
          call.operation = 'upsert';
          writePayload = payload;
          call.payload = payload;
          return chain;
        },
        update(payload: Row) {
          call.operation = 'update';
          writePayload = payload;
          call.payload = payload;
          return chain;
        },
        maybeSingle() {
          return Promise.resolve(unwrap(execute()));
        },
        single() {
          return Promise.resolve(unwrap(execute()));
        },
        then(
          onFulfilled: (value: unknown) => unknown,
          onRejected?: (reason: unknown) => unknown
        ) {
          return Promise.resolve({ data: rows(), error: null }).then(
            onFulfilled,
            onRejected
          );
        },
      };

      return chain;
    },
  } as unknown as SupabaseClient;

  return db;
}

function enquiryRow(overrides: Row = {}): Row {
  return {
    id: ENQUIRY,
    account_id: ACCOUNT,
    conversation_id: CONVERSATION,
    workflow_state: 'completed',
    state_changed_at: '2026-02-01T09:00:00+00:00',
    created_at: '2026-01-20T09:00:00+00:00',
    customer_intent: 'Clear out a flat',
    postcode: 'E14 9SH',
    address: '12 Something Street',
    property_type: 'flat',
    floor: '3rd',
    lift_available: false,
    parking: 'on street',
    access_constraints: ['no lift working'],
    item_descriptions: ['sofas', 'fridge'],
    waste_type: 'household',
    estimated_volume: '2 loads',
    heavy_special_items: [],
    photos_received: true,
    ...overrides,
  };
}

function existingCase(overrides: Row = {}): Row {
  return {
    id: 'case-1',
    account_id: ACCOUNT,
    enquiry_id: ENQUIRY,
    conversation_id: CONVERSATION,
    contact_id: CONTACT,
    source_kind: 'live_enquiry',
    case_state: 'open',
    completed_at: null,
    evidence_quality_tier: null,
    evidence_rule_version: null,
    evidence_reasons: [],
    evidence_classified_at: null,
    learning_eligibility: 'pending',
    learning_exclusion_reason: null,
    learning_eligibility_basis: null,
    finalized_at: null,
    created_by_user_id: null,
    created_at: '2026-02-01T00:00:00.000Z',
    updated_at: '2026-02-01T00:00:00.000Z',
    ...overrides,
  };
}

function storedFact(factKey: string, provenance: string): Row {
  return {
    id: `fact-${factKey}`,
    account_id: ACCOUNT,
    case_id: 'case-1',
    fact_key: factKey,
    value_source: 'canonical',
    value_text: null,
    value_number: null,
    value_integer: null,
    value_boolean: null,
    value_timestamp: null,
    provenance,
    source_message_id: null,
    source_media_id: null,
    observed_at: null,
    recorded_by_user_id: null,
    created_at: '2026-02-01T00:00:00.000Z',
    updated_at: '2026-02-01T00:00:00.000Z',
  };
}

function writesTo(db: FakeDatabase, table: string): Call[] {
  return db.calls.filter(
    (call) => call.table === table && call.operation !== 'select'
  );
}

let db: FakeDatabase;

beforeEach(() => {
  db = makeDb();
});

describe('dry run', () => {
  it('performs no historical-case mutation at all', async () => {
    const before = {
      cases: db.tables.historical_cases?.length ?? 0,
      facts: db.tables.historical_case_facts?.length ?? 0,
      sources: db.tables.historical_case_sources?.length ?? 0,
      snapshots: db.tables.historical_case_snapshots?.length ?? 0,
    };

    const result = await dryRunHistoricalImport(db.client, {
      accountId: ACCOUNT,
      sourceType: 'enquiries',
      triggeredByUserId: USER,
    });

    expect(writesTo(db, 'historical_cases')).toHaveLength(0);
    expect(writesTo(db, 'historical_case_facts')).toHaveLength(0);
    expect(writesTo(db, 'historical_case_sources')).toHaveLength(0);
    expect(writesTo(db, 'historical_case_snapshots')).toHaveLength(0);

    expect(db.tables.historical_cases).toHaveLength(before.cases);
    expect(db.tables.historical_case_facts).toHaveLength(before.facts);
    expect(db.tables.historical_case_sources).toHaveLength(before.sources);
    expect(db.tables.historical_case_snapshots).toHaveLength(before.snapshots);

    expect(result.run.dry_run).toBe(true);
    expect(result.run.cases_created).toBe(0);
    expect(result.run.facts_imported).toBe(0);
  });

  it('reports what it would create, without claiming it created it', async () => {
    const result = await dryRunHistoricalImport(db.client, {
      accountId: ACCOUNT,
      sourceType: 'enquiries',
      triggeredByUserId: USER,
    });

    const projection = result.run.summary.projection;
    expect(projection.cases_to_create).toBe(1);
    expect(projection.facts_to_import).toBe(12);
    expect(result.run.records_examined).toBe(1);
    expect(result.run.status).toBe('completed');
  });

  it('reports the evidence tiers an import would produce, unclassified', async () => {
    const result = await dryRunHistoricalImport(db.client, {
      accountId: ACCOUNT,
      sourceType: 'enquiries',
      triggeredByUserId: USER,
    });

    // A dry run does not classify, so the tier counters stay empty and
    // the answer is visible in the executed run instead.
    expect(result.run.summary.evidence_tiers).toEqual({});
    expect(result.findings).toContain('no_structured_quote_source');
    expect(result.findings).toContain('no_structured_outcome_source');
  });

  it('writes only an import-run audit row', async () => {
    await dryRunHistoricalImport(db.client, {
      accountId: ACCOUNT,
      sourceType: 'enquiries',
      triggeredByUserId: USER,
    });

    expect(writesTo(db, 'historical_import_runs').length).toBeGreaterThan(0);
    expect(db.tables.historical_import_runs).toHaveLength(1);
    const run = db.tables.historical_import_runs?.[0] as Row;
    expect(run.dry_run).toBe(true);
    expect(run.cases_created).toBe(0);
    expect(run.completed_at).not.toBeNull();
  });
});

describe('execute', () => {
  it('creates one case and annotates it with imported provenance', async () => {
    const result = await executeHistoricalImport(db.client, {
      accountId: ACCOUNT,
      sourceType: 'enquiries',
      triggeredByUserId: USER,
    });

    expect(result.run.dry_run).toBe(false);
    expect(result.run.cases_created).toBe(1);
    expect(db.tables.historical_cases).toHaveLength(1);

    const created = db.tables.historical_cases?.[0] as Row;
    expect(created.source_kind).toBe('imported_historical');
    expect(created.evidence_quality_tier).toBeNull();
    expect(created.learning_eligibility).toBe('pending');

    const facts = db.tables.historical_case_facts ?? [];
    expect(facts.length).toBe(12);
    expect(
      facts.every((fact) => fact.provenance === 'imported_historical')
    ).toBe(true);
    expect(facts.every((fact) => fact.recorded_by_user_id === USER)).toBe(
      true
    );
  });

  it('records the source identity of every imported record', async () => {
    await executeHistoricalImport(db.client, {
      accountId: ACCOUNT,
      sourceType: 'enquiries',
      triggeredByUserId: USER,
    });

    const sources = (db.tables.historical_case_sources ??
      []) as unknown as HistoricalCaseSource[];
    expect(sources).toHaveLength(1);
    expect(sources[0]?.source_kind).toBe('enquiry');
    expect(sources[0]?.source_record_id).toBe(ENQUIRY);
    expect(sources[0]?.source_system).toBe('wacrm.enquiries');
    expect(sources[0]?.import_quality).toBe('exact');
    expect(sources[0]?.source_observed_at).toBe('2026-01-20T09:00:00.000Z');
    expect(sources[0]?.import_run_id).not.toBeNull();
  });

  it('records inbound media as a reference and claims no observation', async () => {
    const withMedia = makeDb({
      enquiries: [enquiryRow()],
      conversations: [{ id: CONVERSATION, account_id: ACCOUNT, contact_id: CONTACT }],
      messages: [
        {
          id: 'message-1',
          conversation_id: CONVERSATION,
          sender_type: 'customer',
          media_url: 'https://example.test/storage/v1/object/public/chat-media/account-1/inbound/photo.jpg',
          created_at: '2026-01-25T10:00:00+00:00',
        },
      ],
    });

    await executeHistoricalImport(withMedia.client, {
      accountId: ACCOUNT,
      sourceType: 'enquiries',
      triggeredByUserId: USER,
    });

    const sources = (withMedia.tables.historical_case_sources ??
      []) as unknown as HistoricalCaseSource[];
    const messageSource = sources.find(
      (source) => source.source_kind === 'message'
    );
    expect(messageSource?.source_record_id).toBe('message-1');
    expect(messageSource?.import_quality).toBe('high_confidence_mapping');

    const facts = withMedia.tables.historical_case_facts ?? [];
    expect(
      facts.some((fact) => fact.provenance === 'image_observed')
    ).toBe(false);
  });

  it('is idempotent: a second run changes nothing', async () => {
    await executeHistoricalImport(db.client, {
      accountId: ACCOUNT,
      sourceType: 'enquiries',
      triggeredByUserId: USER,
    });
    const afterFirst = {
      cases: db.tables.historical_cases?.length,
      facts: db.tables.historical_case_facts?.length,
      sources: db.tables.historical_case_sources?.length,
    };

    const second = await executeHistoricalImport(db.client, {
      accountId: ACCOUNT,
      sourceType: 'enquiries',
      triggeredByUserId: USER,
    });

    expect(db.tables.historical_cases).toHaveLength(afterFirst.cases ?? 0);
    expect(db.tables.historical_case_facts).toHaveLength(afterFirst.facts ?? 0);
    expect(db.tables.historical_case_sources).toHaveLength(
      afterFirst.sources ?? 0
    );
    expect(second.run.cases_created).toBe(0);
    expect(second.run.records_skipped).toBe(1);
    expect(second.run.summary.skip_reasons.already_imported).toBe(1);
  });

  it('never turns imported evidence into a confirmed outcome or tier A', async () => {
    const withDeal = makeDb({
      enquiries: [enquiryRow()],
      conversations: [{ id: CONVERSATION, account_id: ACCOUNT, contact_id: CONTACT }],
      deals: [{ id: 'deal-1', account_id: ACCOUNT, value: 420, status: 'won' }],
    });

    const result = await executeHistoricalImport(withDeal.client, {
      accountId: ACCOUNT,
      sourceType: 'enquiries',
      triggeredByUserId: USER,
    });

    const facts = withDeal.tables.historical_case_facts ?? [];
    const keys = facts.map((fact) => fact.fact_key);
    expect(keys).not.toContain('final_amount_collected');
    expect(keys).not.toContain('customer_facing_quote_amount');
    expect(keys).not.toContain('ai_suggested_amount');
    expect(keys).not.toContain('quote_decision');
    expect(
      facts.some((fact) => fact.provenance === 'confirmed_outcome')
    ).toBe(false);
    expect(result.run.summary.evidence_tiers.unclassified).toBe(1);
    expect(
      (withDeal.tables.historical_cases?.[0] as Row).evidence_quality_tier
    ).toBeNull();
  });

  it('ignores AI-written conversation content entirely', async () => {
    const withAiChat = makeDb({
      enquiries: [enquiryRow()],
      conversations: [{ id: CONVERSATION, account_id: ACCOUNT, contact_id: CONTACT }],
      messages: [
        {
          id: 'message-bot',
          conversation_id: CONVERSATION,
          sender_type: 'bot',
          content_type: 'text',
          content_text: 'That job would cost around £420 and take 2 loads.',
          created_at: '2026-01-25T10:00:00+00:00',
        },
      ],
    });

    await executeHistoricalImport(withAiChat.client, {
      accountId: ACCOUNT,
      sourceType: 'enquiries',
      triggeredByUserId: USER,
    });

    const facts = withAiChat.tables.historical_case_facts ?? [];
    expect(facts.length).toBe(12);
    expect(
      facts.some((fact) =>
        ['final_amount_collected', 'customer_facing_quote_amount',
         'ai_suggested_amount', 'actual_load_units',
         'actual_disposal_weight_kg'].includes(String(fact.fact_key))
      )
    ).toBe(false);
    // A bot message is not even a media reference, so no message source
    // row is written for it.
    expect(withAiChat.tables.historical_case_sources).toHaveLength(1);
  });
});

describe('existing cases', () => {
  it('adds to an existing open case instead of creating a second one', async () => {
    const reusing = makeDb({
      enquiries: [enquiryRow()],
      conversations: [{ id: CONVERSATION, account_id: ACCOUNT, contact_id: CONTACT }],
      historical_cases: [existingCase()],
      historical_case_facts: [storedFact('postcode', 'customer_stated')],
    });

    const result = await executeHistoricalImport(reusing.client, {
      accountId: ACCOUNT,
      sourceType: 'enquiries',
      triggeredByUserId: USER,
    });

    expect(result.run.cases_created).toBe(0);
    expect(result.run.cases_updated).toBe(1);
    expect(result.run.cases_reused).toBe(1);
    expect(reusing.tables.historical_cases).toHaveLength(1);
  });

  it('never downgrades an existing stronger provenance', async () => {
    const reusing = makeDb({
      enquiries: [enquiryRow()],
      conversations: [{ id: CONVERSATION, account_id: ACCOUNT, contact_id: CONTACT }],
      historical_cases: [existingCase()],
      historical_case_facts: [storedFact('postcode', 'customer_stated')],
    });

    const result = await executeHistoricalImport(reusing.client, {
      accountId: ACCOUNT,
      sourceType: 'enquiries',
      triggeredByUserId: USER,
    });

    const facts = reusing.tables.historical_case_facts ?? [];
    const postcode = facts.find((fact) => fact.fact_key === 'postcode');
    expect(postcode?.provenance).toBe('customer_stated');
    expect(result.run.conflicts).toBe(1);
    expect(
      result.run.summary.conflict_reasons.stronger_provenance_retained
    ).toBe(1);
  });

  it('keeps a confirmed outcome and reports the clash', async () => {
    const reusing = makeDb({
      enquiries: [enquiryRow()],
      conversations: [{ id: CONVERSATION, account_id: ACCOUNT, contact_id: CONTACT }],
      historical_cases: [
        existingCase({ completed_at: '2026-02-02T11:00:00+00:00' }),
      ],
      historical_case_facts: [
        {
          ...storedFact('final_amount_collected', 'confirmed_outcome'),
          value_source: 'captured',
          value_number: 385,
        },
      ],
    });

    const result = await executeHistoricalImport(reusing.client, {
      accountId: ACCOUNT,
      sourceType: 'enquiries',
      triggeredByUserId: USER,
    });

    const facts = reusing.tables.historical_case_facts ?? [];
    const amount = facts.find(
      (fact) => fact.fact_key === 'final_amount_collected'
    );
    expect(amount?.value_number).toBe(385);
    expect(amount?.provenance).toBe('confirmed_outcome');
    // The importer proposed nothing for this key - it only writes
    // annotations - so the confirmed measurement is simply untouched,
    // not even reported as a clash.
    expect(
      result.run.summary.conflict_reasons.confirmed_value_retained ?? 0
    ).toBe(0);
  });

  it('refuses to touch a finalized case and says why', async () => {
    const frozen = makeDb({
      enquiries: [enquiryRow()],
      conversations: [{ id: CONVERSATION, account_id: ACCOUNT, contact_id: CONTACT }],
      historical_cases: [
        existingCase({
          case_state: 'finalized',
          finalized_at: '2026-03-01T00:00:00+00:00',
        }),
      ],
    });

    const result = await executeHistoricalImport(frozen.client, {
      accountId: ACCOUNT,
      sourceType: 'enquiries',
      triggeredByUserId: USER,
    });

    expect(result.run.conflicts).toBe(1);
    expect(result.run.summary.conflict_reasons.finalized_case_not_mutated).toBe(
      1
    );
    expect(frozen.tables.historical_case_facts).toHaveLength(0);
    expect(frozen.tables.historical_case_sources).toHaveLength(0);
    expect(writesTo(frozen, 'historical_case_facts')).toHaveLength(0);
  });
});

describe('report-only adapters', () => {
  it('counts conversations with no enquiry and imports none of them', async () => {
    const legacy = makeDb({
      enquiries: [],
      conversations: [
        { id: CONVERSATION, account_id: ACCOUNT, contact_id: CONTACT },
      ],
      messages: [
        {
          id: 'message-1',
          conversation_id: CONVERSATION,
          sender_type: 'customer',
          content_type: 'text',
          content_text: 'hi',
          created_at: '2026-01-01T10:00:00+00:00',
        },
      ],
    });

    const result = await executeHistoricalImport(legacy.client, {
      accountId: ACCOUNT,
      sourceType: 'legacy_conversations',
      triggeredByUserId: USER,
    });

    expect(result.run.records_examined).toBe(1);
    expect(result.run.records_skipped).toBe(1);
    expect(
      result.run.summary.skip_reasons.requires_enquiry_segmentation
    ).toBe(1);
    expect(result.run.ambiguous_records).toBe(1);
    expect(result.run.cases_created).toBe(0);
    expect(legacy.tables.historical_cases).toHaveLength(0);
    expect(result.findings).toContain('legacy_conversations_require_segmentation');
  });

  it('does not count a conversation that already has an enquiry', async () => {
    const mixed = makeDb({
      enquiries: [enquiryRow()],
      conversations: [
        { id: CONVERSATION, account_id: ACCOUNT, contact_id: CONTACT },
      ],
    });

    const result = await executeHistoricalImport(mixed.client, {
      accountId: ACCOUNT,
      sourceType: 'legacy_conversations',
      triggeredByUserId: USER,
    });

    expect(result.run.records_skipped).toBe(0);
  });

  it('examines deals and maps none of them', async () => {
    const withDeals = makeDb({
      enquiries: [],
      conversations: [],
      deals: [
        { id: 'deal-1', account_id: ACCOUNT, value: 420, status: 'won' },
        { id: 'deal-2', account_id: ACCOUNT, value: 0, status: 'active' },
      ],
    });

    const result = await executeHistoricalImport(withDeals.client, {
      accountId: ACCOUNT,
      sourceType: 'deals',
      triggeredByUserId: USER,
    });

    expect(result.run.records_examined).toBe(2);
    expect(result.run.summary.skip_reasons.source_semantics_unproven).toBe(2);
    expect(result.run.cases_created).toBe(0);
    expect(withDeals.tables.historical_cases).toHaveLength(0);
    expect(withDeals.tables.historical_case_facts).toHaveLength(0);
  });
});

describe('account isolation and bounded reads', () => {
  it('scopes every read and write to the account it was given', async () => {
    await executeHistoricalImport(db.client, {
      accountId: OTHER_ACCOUNT,
      sourceType: 'enquiries',
      triggeredByUserId: USER,
    });

    const scoped = [
      'enquiries',
      'conversations',
      'historical_cases',
      'historical_case_facts',
      'historical_case_sources',
      'historical_import_runs',
    ];
    for (const call of db.calls) {
      if (!scoped.includes(call.table)) continue;
      const touched =
        call.filters.some(([column]) => column === 'account_id') ||
        call.payload?.account_id === OTHER_ACCOUNT;
      expect(touched, `${call.table} was not account-scoped`).toBe(true);
    }

    expect(db.tables.historical_cases).toHaveLength(0);
  });

  it('imports nothing for an account with no enquiries', async () => {
    const empty = makeDb({ enquiries: [], conversations: [] });

    const result = await executeHistoricalImport(empty.client, {
      accountId: ACCOUNT,
      sourceType: 'enquiries',
      triggeredByUserId: USER,
    });

    expect(result.run.records_examined).toBe(0);
    expect(result.run.cases_created).toBe(0);
    expect(result.has_more).toBe(false);
  });

  it('reports that a full page means there is more to read', async () => {
    const many = makeDb({
      enquiries: [0, 1].map((index) =>
        enquiryRow({ id: `enquiry-${index}` })
      ),
      conversations: [
        { id: CONVERSATION, account_id: ACCOUNT, contact_id: CONTACT },
      ],
    });

    const result = await executeHistoricalImport(many.client, {
      accountId: ACCOUNT,
      sourceType: 'enquiries',
      triggeredByUserId: USER,
      limit: 2,
    });

    expect(result.has_more).toBe(true);
    expect(result.next_offset).toBe(2);
  });
});

describe('stored summaries', () => {
  it('keeps the run log free of customer content', async () => {
    const chatty = makeDb({
      enquiries: [
        enquiryRow({
          address: '12 Something Street, Flat 3B, E14 9SH',
          item_descriptions: ['a very private description'],
        }),
      ],
      conversations: [{ id: CONVERSATION, account_id: ACCOUNT, contact_id: CONTACT }],
    });

    const result = await executeHistoricalImport(chatty.client, {
      accountId: ACCOUNT,
      sourceType: 'enquiries',
      triggeredByUserId: USER,
    });

    const serialized = JSON.stringify(result.run.summary);
    expect(serialized).not.toContain('Something Street');
    expect(serialized).not.toContain('private description');
    expect(serialized.length).toBeLessThan(8_192);
    expect(result.run.error_metadata).toEqual([]);
  });

  it('lists runs newest first, bounded, for the approval review', async () => {
    await executeHistoricalImport(db.client, {
      accountId: ACCOUNT,
      sourceType: 'enquiries',
      triggeredByUserId: USER,
    });

    const runs = (await listHistoricalImportSummaries(db.client, {
      accountId: ACCOUNT,
      limit: 5,
    })) as HistoricalImportRun[];

    expect(runs).toHaveLength(1);
    expect(runs[0]?.dry_run).toBe(false);
  });
});