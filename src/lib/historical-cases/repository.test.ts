import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import {
  HISTORICAL_CASE_RULE_VERSION,
  type HistoricalCase,
  type HistoricalCaseFact,
} from './model';
import {
  HISTORICAL_CASE_FACT_COLUMNS,
  HISTORICAL_CASE_LIST_MAX_LIMIT,
  HistoricalCaseRepositoryError,
  appendHistoricalCaseSnapshot,
  classifyHistoricalCase,
  ensureHistoricalCase,
  getHistoricalCase,
  getHistoricalCaseByEnquiry,
  getHistoricalCaseFacts,
  listRetrievalCases,
  listTrainingEligibleCases,
  recordHistoricalCaseFact,
  setHistoricalCaseCompleted,
  setHistoricalCaseLearningEligibility,
} from './repository';

const ACCOUNT = 'account-1';
const OTHER_ACCOUNT = 'account-2';
const CONVERSATION = 'conversation-1';
const CONTACT = 'contact-1';
const ENQUIRY = 'enquiry-1';

type Row = Record<string, unknown>;

/**
 * The column defaults migration 049 installs. A real insert returns the
 * row Postgres built, not the payload that was sent, so the double has to
 * supply them or every parsed row looks incomplete.
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
  },
  historical_case_facts: {
    value_text: null,
    value_number: null,
    value_integer: null,
    value_boolean: null,
    source_message_id: null,
    source_media_id: null,
    observed_at: null,
    recorded_by_user_id: null,
  },
  historical_case_snapshots: {
    recorded_by_user_id: null,
  },
};

interface FakeDatabase {
  client: SupabaseClient;
  calls: Array<{
    table: string;
    operation: 'select' | 'insert' | 'update' | 'upsert';
    filters: Array<[string, unknown]>;
    notFilters: Array<[string, unknown]>;
    inFilters: Array<[string, unknown[]]>;
    order: Array<[string, boolean]>;
    limit: number | null;
    payload: Row | null;
  }>;
  historical_cases: Row[];
  historical_case_facts: Row[];
  historical_case_snapshots: Row[];
}

interface FakeSeed {
  enquiries?: Row[];
  conversations?: Row[];
  historical_cases?: Row[];
  historical_case_facts?: Row[];
  historical_case_snapshots?: Row[];
  /** Force the next insert into `table` to report this Postgres error. */
  insertError?: { table: string; code: string };
  failTable?: string;
}

/**
 * A small PostgREST double covering exactly the operations this repository
 * uses: equality, inequality, `is not null`, `in`, deterministic ordering,
 * a bounded limit, insert/upsert/update, and `maybeSingle`/`single`.
 *
 * Every query is recorded so a test can assert that `account_id` was
 * actually applied rather than trusting the call by inspection.
 */
function makeDb(seed: FakeSeed = {}): FakeDatabase {
  const tables: Record<string, Row[]> = {
    enquiries: seed.enquiries ?? [
      {
        id: ENQUIRY,
        account_id: ACCOUNT,
        conversation_id: CONVERSATION,
        workflow_state: 'new_enquiry',
      },
    ],
    conversations: seed.conversations ?? [
      { id: CONVERSATION, account_id: ACCOUNT, contact_id: CONTACT },
    ],
    historical_cases: seed.historical_cases ?? [],
    historical_case_facts: seed.historical_case_facts ?? [],
    historical_case_snapshots: seed.historical_case_snapshots ?? [],
  };

  const db: FakeDatabase = {
    client: null as unknown as SupabaseClient,
    calls: [],
    historical_cases: tables.historical_cases as Row[],
    historical_case_facts: tables.historical_case_facts as Row[],
    historical_case_snapshots: tables.historical_case_snapshots as Row[],
  };

  let idCounter = 0;

  db.client = {
    from(table: string) {
      const call: FakeDatabase['calls'][number] = {
        table,
        operation: 'select',
        filters: [],
        notFilters: [],
        inFilters: [],
        order: [],
        limit: null,
        payload: null,
      };
      db.calls.push(call);

      let writePayload: Row = {};

      const matches = (row: Row): boolean => {
        if (seed.failTable === table) return false;
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
        // Chained order() calls become one ORDER BY list: the first call is
        // the primary sort and later calls only break its ties. Applied
        // right to left, because Array.sort is stable.
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
        return call.limit === null ? result : result.slice(0, call.limit);
      };

      const execute = ():
        { data: Row[]; error: null } | { data: Row | null; error: unknown } => {
        if (seed.failTable === table) {
          return { data: null, error: { message: 'boom', code: 'XX000' } };
        }
        if (call.operation === 'select') {
          return { data: rows(), error: null };
        }
        if (call.operation === 'insert' || call.operation === 'upsert') {
          if (seed.insertError?.table === table) {
            return { data: null, error: { code: seed.insertError.code } };
          }
          const payload = writePayload;
          const now = '2026-03-01T00:00:00.000Z';
          const row: Row = {
            id: `row-${++idCounter}`,
            // Postgres column defaults, which PostgREST returns in the
            // inserted row.
            ...(TABLE_DEFAULTS[table] ?? {}),
            created_at: now,
            updated_at: now,
            ...payload,
          };
          if (call.operation === 'upsert') {
            // The repository upserts on (case_id, fact_key) only.
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

        const target = rows();
        const first = target[0];
        if (!first) {
          return { data: null, error: null };
        }
        Object.assign(first, writePayload, {
          updated_at: '2026-03-02T00:00:00.000Z',
        });
        return { data: first, error: null };
      };

      const unwrap = (
        result:
          { data: Row[]; error: null } | { data: Row | null; error: unknown }
      ): { data: Row | null; error: unknown } => {
        if (result.error) {
          return { data: null, error: result.error };
        }
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
          if (operator === 'is') {
            call.notFilters.push([column, null]);
          }
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
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function callsFor(db: FakeDatabase, table: string) {
  return db.calls.filter((call) => call.table === table);
}

describe('selected fact columns', () => {
  it('includes the timestamp value kind', () => {
    // Omitting `value_timestamp` here failed silently: PostgREST left
    // the column out of every returned row, `parseHistoricalCaseFact`
    // read `undefined`, and arrival/departure silently became null on
    // the way into a finalization snapshot.
    expect(HISTORICAL_CASE_FACT_COLUMNS.split(',')).toContain(
      'value_timestamp'
    );
  });
});

describe('ensureHistoricalCase', () => {
  it('derives conversation and contact from the canonical enquiry', async () => {
    const db = makeDb();

    const result = await ensureHistoricalCase(db.client, {
      accountId: ACCOUNT,
      enquiryId: ENQUIRY,
      createdByUserId: 'user-1',
    });

    expect(result.created).toBe(true);
    expect(result.case.conversation_id).toBe(CONVERSATION);
    expect(result.case.contact_id).toBe(CONTACT);
    expect(result.case.source_kind).toBe('live_enquiry');
  });

  it('scopes the enquiry lookup to the account', async () => {
    const db = makeDb();

    await ensureHistoricalCase(db.client, {
      accountId: OTHER_ACCOUNT,
      enquiryId: ENQUIRY,
      createdByUserId: null,
    }).catch((error: unknown) => {
      expect(error).toBeInstanceOf(HistoricalCaseRepositoryError);
    });

    const enquiryCall = callsFor(db, 'enquiries')[0];
    expect(enquiryCall?.filters).toContainEqual(['account_id', OTHER_ACCOUNT]);
  });

  it('returns the existing case instead of creating a second one', async () => {
    const db = makeDb({ historical_cases: [existingCase()] });

    const result = await ensureHistoricalCase(db.client, {
      accountId: ACCOUNT,
      enquiryId: ENQUIRY,
      createdByUserId: null,
    });

    expect(result.created).toBe(false);
    expect(result.case.id).toBe('case-1');
    expect(callsFor(db, 'historical_cases')).toHaveLength(1);
  });

  it('adopts the winner when a concurrent insert loses the race', async () => {
    const db = makeDb({
      historical_cases: [existingCase()],
      insertError: { table: 'historical_cases', code: '23505' },
    });

    const result = await ensureHistoricalCase(db.client, {
      accountId: ACCOUNT,
      enquiryId: ENQUIRY,
      createdByUserId: null,
    });

    expect(result.created).toBe(false);
    expect(result.case.id).toBe('case-1');
  });

  it('fails closed when the enquiry does not exist', async () => {
    const db = makeDb({ enquiries: [] });

    await expect(
      ensureHistoricalCase(db.client, {
        accountId: ACCOUNT,
        enquiryId: 'missing',
        createdByUserId: null,
      })
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('reports a database failure as a repository error', async () => {
    const db = makeDb({ failTable: 'historical_cases' });

    await expect(
      getHistoricalCase(db.client, ACCOUNT, 'case-1')
    ).rejects.toMatchObject({ code: 'database_error' });
  });
});

describe('account isolation', () => {
  it("never reads another account's case by id", async () => {
    const db = makeDb({ historical_cases: [existingCase()] });

    const found = await getHistoricalCase(db.client, OTHER_ACCOUNT, 'case-1');

    expect(found).toBeNull();
    const call = callsFor(db, 'historical_cases')[0];
    expect(call?.filters).toContainEqual(['account_id', OTHER_ACCOUNT]);
  });

  it("never reads another account's case by enquiry", async () => {
    const db = makeDb({ historical_cases: [existingCase()] });

    const found = await getHistoricalCaseByEnquiry(
      db.client,
      OTHER_ACCOUNT,
      ENQUIRY
    );

    expect(found).toBeNull();
  });

  it("writes facts with the caller's account and case scope", async () => {
    const db = makeDb();

    await recordHistoricalCaseFact(db.client, {
      accountId: ACCOUNT,
      caseId: 'case-1',
      fact: {
        fact_key: 'crew_count',
        provenance: 'operator_entered',
        value_integer: 2,
      },
    });

    // An upsert is addressed by its conflict target rather than by filters,
    // so the account and case scope has to be inside the written payload.
    const call = callsFor(db, 'historical_case_facts')[0];
    expect(call?.payload?.account_id).toBe(ACCOUNT);
    expect(call?.payload?.case_id).toBe('case-1');
  });
});

describe('facts and provenance', () => {
  it('rejects an AI suggestion masquerading as a collected amount', async () => {
    const db = makeDb();

    await expect(
      recordHistoricalCaseFact(db.client, {
        accountId: ACCOUNT,
        caseId: 'case-1',
        fact: {
          fact_key: 'final_amount_collected',
          provenance: 'ai_suggested',
          value_number: 380,
        },
      })
    ).rejects.toMatchObject({ code: 'invalid_input' });

    expect(callsFor(db, 'historical_case_facts')).toHaveLength(0);
  });

  it('keeps provenance per fact rather than per case', async () => {
    const db = makeDb();

    await recordHistoricalCaseFact(db.client, {
      accountId: ACCOUNT,
      caseId: 'case-1',
      fact: {
        fact_key: 'postcode',
        provenance: 'customer_stated',
      },
    });
    await recordHistoricalCaseFact(db.client, {
      accountId: ACCOUNT,
      caseId: 'case-1',
      fact: {
        fact_key: 'customer_facing_quote_amount',
        provenance: 'operator_entered',
        value_number: 400,
      },
    });
    await recordHistoricalCaseFact(db.client, {
      accountId: ACCOUNT,
      caseId: 'case-1',
      fact: {
        fact_key: 'ai_suggested_amount',
        provenance: 'ai_suggested',
        value_number: 420,
      },
    });

    const stored = db.historical_case_facts as unknown as HistoricalCaseFact[];
    expect(stored.map((fact) => fact.provenance)).toEqual([
      'customer_stated',
      'operator_entered',
      'ai_suggested',
    ]);
    expect(stored[0]?.value_text).toBeNull();
    expect(stored[1]?.value_number).toBe(400);
  });

  it('replaces a recorded fact with its own provenance intact', async () => {
    const db = makeDb({
      historical_case_facts: [
        {
          id: 'fact-existing',
          account_id: ACCOUNT,
          case_id: 'case-1',
          fact_key: 'crew_count',
          value_source: 'captured',
          value_text: null,
          value_number: null,
          value_integer: 1,
          value_boolean: null,
          provenance: 'operator_entered',
          source_message_id: null,
          source_media_id: null,
          observed_at: null,
          recorded_by_user_id: null,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    });

    const fact = await recordHistoricalCaseFact(db.client, {
      accountId: ACCOUNT,
      caseId: 'case-1',
      fact: {
        fact_key: 'crew_count',
        provenance: 'operator_entered',
        value_integer: 3,
      },
    });

    expect(fact.value_integer).toBe(3);
  });

  it('loads facts for exactly one case', async () => {
    const db = makeDb({
      historical_case_facts: [
        {
          id: 'fact-a',
          account_id: ACCOUNT,
          case_id: 'case-1',
          fact_key: 'crew_count',
          value_source: 'captured',
          value_text: null,
          value_number: null,
          value_integer: 2,
          value_boolean: null,
          provenance: 'operator_entered',
          source_message_id: null,
          source_media_id: null,
          observed_at: null,
          recorded_by_user_id: null,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    });

    const facts = await getHistoricalCaseFacts(db.client, {
      accountId: ACCOUNT,
      caseId: 'case-1',
    });

    expect(facts).toHaveLength(1);
    expect(facts[0]?.fact_key).toBe('crew_count');
  });
});

describe('classification through the repository', () => {
  it('stores the tier, the rule version and a snapshot', async () => {
    const db = makeDb({
      historical_cases: [
        existingCase({ completed_at: '2026-02-01T10:00:00.000Z' }),
      ],
      enquiries: [
        {
          id: ENQUIRY,
          account_id: ACCOUNT,
          conversation_id: CONVERSATION,
          workflow_state: 'completed',
        },
      ],
      historical_case_facts: [
        {
          id: 'fact-final',
          account_id: ACCOUNT,
          case_id: 'case-1',
          fact_key: 'final_amount_collected',
          value_source: 'captured',
          value_text: null,
          value_number: 380,
          value_integer: null,
          value_boolean: null,
          provenance: 'confirmed_outcome',
          source_message_id: null,
          source_media_id: null,
          observed_at: null,
          recorded_by_user_id: null,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    });

    const result = await classifyHistoricalCase(db.client, {
      accountId: ACCOUNT,
      caseId: 'case-1',
    });

    expect(result.classification.tier).toBe('A');
    expect(result.case.evidence_rule_version).toBe(
      HISTORICAL_CASE_RULE_VERSION
    );
    expect(result.case.evidence_classified_at).not.toBeNull();
    expect(db.historical_case_snapshots).toHaveLength(1);
    expect(db.historical_case_snapshots[0]?.snapshot_kind).toBe(
      'evidence_classification'
    );
  });

  it('writes an explicit unclassified result rather than a silent absence', async () => {
    const db = makeDb({ historical_cases: [existingCase()] });

    const result = await classifyHistoricalCase(db.client, {
      accountId: ACCOUNT,
      caseId: 'case-1',
    });

    expect(result.classification.tier).toBeNull();
    expect(result.case.evidence_classified_at).not.toBeNull();
    expect(result.case.evidence_rule_version).toBe(
      HISTORICAL_CASE_RULE_VERSION
    );
  });

  it('fails when the case is not in the account', async () => {
    const db = makeDb();

    await expect(
      classifyHistoricalCase(db.client, {
        accountId: ACCOUNT,
        caseId: 'missing',
      })
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('cannot promote an AI-only case past tier E', async () => {
    const db = makeDb({
      historical_cases: [
        existingCase({ completed_at: '2026-02-01T10:00:00.000Z' }),
      ],
      historical_case_facts: [
        {
          id: 'fact-ai',
          account_id: ACCOUNT,
          case_id: 'case-1',
          fact_key: 'ai_suggested_amount',
          value_source: 'captured',
          value_text: null,
          value_number: 420,
          value_integer: null,
          value_boolean: null,
          provenance: 'ai_suggested',
          source_message_id: null,
          source_media_id: null,
          observed_at: null,
          recorded_by_user_id: null,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    });

    const result = await classifyHistoricalCase(db.client, {
      accountId: ACCOUNT,
      caseId: 'case-1',
    });

    expect(result.classification.tier).toBe('E');
  });
});

describe('learning eligibility', () => {
  it('includes a case for training with an explicit basis', async () => {
    const db = makeDb({ historical_cases: [existingCase()] });

    const updated = await setHistoricalCaseLearningEligibility(db.client, {
      accountId: ACCOUNT,
      caseId: 'case-1',
      eligibility: 'included',
      reason: null,
      basis: 'operator',
    });

    expect(updated.learning_eligibility).toBe('included');
    expect(updated.learning_eligibility_basis).toBe('operator');
  });

  it('keeps the case and its history when it is excluded', async () => {
    const db = makeDb({ historical_cases: [existingCase()] });

    const updated = await setHistoricalCaseLearningEligibility(db.client, {
      accountId: ACCOUNT,
      caseId: 'case-1',
      eligibility: 'excluded',
      reason: 'privacy_deletion',
      basis: 'operator',
    });

    expect(updated.learning_exclusion_reason).toBe('privacy_deletion');
    expect(db.historical_cases).toHaveLength(1);
  });

  it('refuses to exclude without a reason', async () => {
    const db = makeDb({ historical_cases: [existingCase()] });

    await expect(
      setHistoricalCaseLearningEligibility(db.client, {
        accountId: ACCOUNT,
        caseId: 'case-1',
        eligibility: 'excluded',
        reason: null,
        basis: 'operator',
      })
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('records a completion timestamp separately from the enquiry state', async () => {
    const db = makeDb({ historical_cases: [existingCase()] });

    const updated = await setHistoricalCaseCompleted(db.client, {
      accountId: ACCOUNT,
      caseId: 'case-1',
      completedAt: '2026-02-02T09:30:00.000Z',
    });

    expect(updated.completed_at).toBe('2026-02-02T09:30:00.000Z');
  });
});

describe('bounded list reads', () => {
  it('reads only operator-included cases for training', async () => {
    const db = makeDb({
      historical_cases: [
        existingCase({ id: 'case-1' }),
        existingCase({
          id: 'case-2',
          learning_eligibility: 'included',
          learning_eligibility_basis: 'operator',
        }),
      ],
    });

    const cases = await listTrainingEligibleCases(db.client, {
      accountId: ACCOUNT,
    });

    expect(cases.map((entry: HistoricalCase) => entry.id)).toEqual(['case-2']);
    const call = callsFor(db, 'historical_cases')[0];
    expect(call?.filters).toContainEqual(['learning_eligibility', 'included']);
  });

  it('reads a wider population for retrieval than for training', async () => {
    const db = makeDb({
      historical_cases: [
        existingCase({
          id: 'case-pending',
          evidence_quality_tier: 'B',
          evidence_rule_version: 'evidence-tier-v1',
          evidence_classified_at: '2026-01-02T00:00:00.000Z',
        }),
        existingCase({
          id: 'case-included',
          evidence_quality_tier: 'A',
          evidence_rule_version: 'evidence-tier-v1',
          evidence_classified_at: '2026-01-02T00:00:00.000Z',
          learning_eligibility: 'included',
          learning_eligibility_basis: 'operator',
        }),
        existingCase({
          id: 'case-excluded',
          evidence_quality_tier: 'A',
          evidence_rule_version: 'evidence-tier-v1',
          evidence_classified_at: '2026-01-02T00:00:00.000Z',
          learning_eligibility: 'excluded',
          learning_exclusion_reason: 'test_data',
          learning_eligibility_basis: 'operator',
        }),
      ],
    });

    const training = await listTrainingEligibleCases(db.client, {
      accountId: ACCOUNT,
    });
    const retrieval = await listRetrievalCases(db.client, {
      accountId: ACCOUNT,
    });

    expect(training.map((entry: HistoricalCase) => entry.id)).toEqual([
      'case-included',
    ]);
    expect(retrieval.map((entry: HistoricalCase) => entry.id)).toEqual([
      'case-pending',
      'case-included',
    ]);
  });

  it('applies a bounded limit and clamps an oversized request', async () => {
    const db = makeDb({ historical_cases: [existingCase()] });

    await listRetrievalCases(db.client, { accountId: ACCOUNT, limit: 5 });
    expect(callsFor(db, 'historical_cases')[0]?.limit).toBe(5);

    await listRetrievalCases(db.client, {
      accountId: ACCOUNT,
      limit: HISTORICAL_CASE_LIST_MAX_LIMIT * 10,
    });
    expect(callsFor(db, 'historical_cases')[1]?.limit).toBe(
      HISTORICAL_CASE_LIST_MAX_LIMIT
    );
  });

  it('always filters by account', async () => {
    const db = makeDb();

    await listTrainingEligibleCases(db.client, { accountId: OTHER_ACCOUNT });
    await listRetrievalCases(db.client, { accountId: OTHER_ACCOUNT });

    for (const call of callsFor(db, 'historical_cases')) {
      expect(call.filters).toContainEqual(['account_id', OTHER_ACCOUNT]);
    }
  });
});

describe('snapshots', () => {
  it('appends an immutable classification record', async () => {
    const db = makeDb();

    const snapshot = await appendHistoricalCaseSnapshot(db.client, {
      accountId: ACCOUNT,
      caseId: 'case-1',
      snapshotKind: 'evidence_classification',
      payload: { evidence_quality_tier: 'E' },
      sourceVersion: HISTORICAL_CASE_RULE_VERSION,
    });

    expect(snapshot.snapshot_kind).toBe('evidence_classification');
    expect(snapshot.payload).toEqual({ evidence_quality_tier: 'E' });
    expect(db.historical_case_snapshots).toHaveLength(1);
  });

  it('refuses an oversized payload', async () => {
    const db = makeDb();

    await expect(
      appendHistoricalCaseSnapshot(db.client, {
        accountId: ACCOUNT,
        caseId: 'case-1',
        snapshotKind: 'outcome',
        payload: { notes: 'x'.repeat(20_000) },
        sourceVersion: 'v1',
      })
    ).rejects.toThrow(/exceeds/);
  });
});
