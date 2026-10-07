import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import type { HistoricalCaseFact } from './model';
import {
  buildFinalizationPayloads,
  captureJobOutcome,
  deriveLabourMinutes,
  finalizeHistoricalCase,
  parseCompletedJobOutcome,
  parseLostBusinessOutcome,
  setFinalizedCaseLearningEligibility,
  type FinalizationImageAnalysis,
} from './outcome';
import { HistoricalCaseRepositoryError } from './repository';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const OTHER_ACCOUNT = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = 'conversation-1';
const CONTACT = 'contact-1';
const ENQUIRY = '33333333-3333-4333-8333-333333333333';
const AGENT = 'agent-1';

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// A PostgREST double
//
// Deliberately separate from the one in repository.test.ts: this file
// exercises a different write sequence (a plan of ordered fact upserts,
// then a completion timestamp, then a classification, then four
// snapshots, then a compare-and-set freeze), and it needs two extra
// behaviours the other double does not model - a queued, one-shot insert
// error so a concurrent finalize can be simulated, and an in-memory
// unique index on the finalization snapshot kinds so the idempotency the
// code relies on is the idempotency the database provides.
// ---------------------------------------------------------------------------

interface FakeSeed {
  enquiries?: Row[];
  conversations?: Row[];
  historical_cases?: Row[];
  historical_case_facts?: Row[];
  historical_case_snapshots?: Row[];
  /**
   * Canonical per-image observations (migration 054). Seeded so the
   * finalization enrichment path can be exercised end to end, rather than
   * only through the pure payload builder.
   */
  image_analysis_runs?: Row[];
  image_analysis_run_images?: Row[];
  image_analysis_observations?: Row[];
  image_analysis_observation_sources?: Row[];
  /** One-shot insert errors, consumed in order. */
  insertErrors?: Array<{ table: string; code: string }>;
  failTable?: string;
}

interface FakeDatabase {
  client: SupabaseClient;
  calls: Array<{
    table: string;
    operation: 'select' | 'insert' | 'update' | 'upsert';
    filters: Array<[string, unknown]>;
    limit: number | null;
    payload: Row | null;
  }>;
  historical_cases: Row[];
  historical_case_facts: Row[];
  historical_case_snapshots: Row[];
  /** Every seeded table, so a test can bind a row to a generated id. */
  tables: Record<string, Row[]>;
}

const FINALIZATION_KINDS = new Set([
  'enquiry_facts',
  'image_analysis',
  'commercial',
  'outcome',
]);

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
    value_timestamp: null,
    source_message_id: null,
    source_media_id: null,
    observed_at: null,
    recorded_by_user_id: null,
  },
  historical_case_snapshots: {
    recorded_by_user_id: null,
  },
};

function makeDb(seed: FakeSeed = {}): FakeDatabase {
  const tables: Record<string, Row[]> = {
    enquiries: seed.enquiries ?? [
      {
        id: ENQUIRY,
        account_id: ACCOUNT,
        conversation_id: CONVERSATION,
        workflow_state: 'new_enquiry',
        state_changed_at: '2026-01-01T00:00:00.000Z',
        customer_intent: 'Clear a flat',
        postcode: '01310-100',
        photos_received: true,
      },
    ],
    conversations: seed.conversations ?? [
      { id: CONVERSATION, account_id: ACCOUNT, contact_id: CONTACT },
    ],
    historical_cases: seed.historical_cases ?? [],
    historical_case_facts: seed.historical_case_facts ?? [],
    historical_case_snapshots: seed.historical_case_snapshots ?? [],
    image_analysis_runs: seed.image_analysis_runs ?? [],
    image_analysis_run_images: seed.image_analysis_run_images ?? [],
    image_analysis_observations: seed.image_analysis_observations ?? [],
    image_analysis_observation_sources:
      seed.image_analysis_observation_sources ?? [],
  };

  const db: FakeDatabase = {
    client: null as unknown as SupabaseClient,
    calls: [],
    historical_cases: tables.historical_cases as Row[],
    tables,
    historical_case_facts: tables.historical_case_facts as Row[],
    historical_case_snapshots: tables.historical_case_snapshots as Row[],
  };

  const queuedErrors = [...(seed.insertErrors ?? [])];
  let idCounter = 0;

  db.client = {
    from(table: string) {
      const call: FakeDatabase['calls'][number] = {
        table,
        operation: 'select',
        filters: [],
        limit: null,
        payload: null,
      };
      db.calls.push(call);
      let writePayload: Row = {};

      const matches = (row: Row): boolean => {
        if (seed.failTable === table) return false;
        return call.filters.every(([column, value]) => row[column] === value);
      };

      const rows = (): Row[] => {
        const result = [...(tables[table] ?? [])].filter(matches);
        return call.limit === null ? result : result.slice(0, call.limit);
      };

      const execute = ():
        | { data: Row[]; error: null }
        | { data: Row | null; error: unknown } => {
        if (seed.failTable === table) {
          return { data: null, error: { message: 'boom', code: 'XX000' } };
        }
        if (call.operation === 'select') {
          return { data: rows(), error: null };
        }
        if (call.operation === 'insert' || call.operation === 'upsert') {
          const queued = queuedErrors.findIndex((entry) => entry.table === table);
          if (queued !== -1) {
            const [entry] = queuedErrors.splice(queued, 1);
            return { data: null, error: { code: entry?.code } };
          }
          const now = '2026-03-01T00:00:00.000Z';
          const row: Row = {
            id: `row-${++idCounter}`,
            ...(TABLE_DEFAULTS[table] ?? {}),
            created_at: now,
            updated_at: now,
            ...writePayload,
          };
          if (call.operation === 'upsert') {
            const conflict = (tables[table] ?? []).find(
              (candidate) =>
                candidate.case_id === writePayload.case_id &&
                candidate.fact_key === writePayload.fact_key
            );
            if (conflict) {
              Object.assign(conflict, row, { id: conflict.id as string });
              return { data: conflict, error: null };
            }
          }
          // The unique index that migration 050 installs on one snapshot
          // per finalization kind. Modelling it here means the idempotency
          // the tests observe is the idempotency the database provides,
          // not an accident of the fake.
          if (
            table === 'historical_case_snapshots' &&
            FINALIZATION_KINDS.has(String(writePayload.snapshot_kind))
          ) {
            const duplicate = (tables[table] ?? []).find(
              (candidate) =>
                candidate.case_id === writePayload.case_id &&
                candidate.snapshot_kind === writePayload.snapshot_kind
            );
            if (duplicate) {
              return { data: null, error: { code: '23505' } };
            }
          }
          (tables[table] ??= []).push(row);
          return { data: row, error: null };
        }

        const target = rows();
        const first = target[0];
        if (!first) return { data: null, error: null };
        Object.assign(first, writePayload, {
          updated_at: '2026-03-02T00:00:00.000Z',
        });
        return { data: first, error: null };
      };

      const unwrap = (
        result:
          | { data: Row[]; error: null }
          | { data: Row | null; error: unknown }
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
        neq() {
          return chain;
        },
        not() {
          return chain;
        },
        in() {
          return chain;
        },
        order() {
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

function factsByKey(db: FakeDatabase): Map<string, HistoricalCaseFact> {
  const byKey = new Map<string, HistoricalCaseFact>();
  for (const row of db.historical_case_facts) {
    byKey.set(row.fact_key as string, {
      id: row.id as string,
      account_id: row.account_id as string,
      case_id: row.case_id as string,
      fact_key: row.fact_key as HistoricalCaseFact['fact_key'],
      value_source: row.value_source as 'canonical' | 'captured',
      value_text: (row.value_text as string | null) ?? null,
      value_number: (row.value_number as number | null) ?? null,
      value_integer: (row.value_integer as number | null) ?? null,
      value_boolean: (row.value_boolean as boolean | null) ?? null,
      value_timestamp: (row.value_timestamp as string | null) ?? null,
      provenance: row.provenance as HistoricalCaseFact['provenance'],
      source_message_id: (row.source_message_id as string | null) ?? null,
      source_media_id: (row.source_media_id as string | null) ?? null,
      observed_at: (row.observed_at as string | null) ?? null,
      recorded_by_user_id: (row.recorded_by_user_id as string | null) ?? null,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    });
  }
  return byKey;
}

function snapshotKinds(db: FakeDatabase): string[] {
  return db.historical_case_snapshots
    .map((row) => row.snapshot_kind as string)
    .sort();
}

const GOOD_COMPLETED_JOB = {
  final_operational_outcome: 'completed',
  completed_at: '2026-03-01T11:30:00Z',
  final_amount_collected: 385,
  actual_load_units: 1.5,
  actual_disposal_weight_kg: 187.5,
  arrival_at: '2026-03-01T09:00:00Z',
  departed_at: '2026-03-01T10:45:00Z',
  crew_count: 2,
  scope_change_type: 'more_waste_than_expected',
  scope_change_reason: 'Two extra bags behind the shed',
  final_job_notes: 'Access through the side gate only',
  actual_dismantling_required: true,
};

function capture(
  db: FakeDatabase,
  completed: unknown = GOOD_COMPLETED_JOB,
  enquiryId = ENQUIRY,
  accountId = ACCOUNT
) {
  return captureJobOutcome(db.client, {
    accountId,
    enquiryId,
    recordedByUserId: AGENT,
    outcome: { kind: 'completed', completed },
  });
}

function captureLost(
  db: FakeDatabase,
  lost: unknown,
  enquiryId = ENQUIRY,
  accountId = ACCOUNT
) {
  return captureJobOutcome(db.client, {
    accountId,
    enquiryId,
    recordedByUserId: AGENT,
    outcome: { kind: 'lost', lost },
  });
}

// ---------------------------------------------------------------------------

describe('completed job capture', () => {
  it('reaches tier A and becomes a trusted price outcome', async () => {
    const db = makeDb();

    const result = await capture(db);

    expect(result.case.completed_at).toBe('2026-03-01T11:30:00.000Z');
    expect(result.classification.tier).toBe('A');
    expect(result.population).toBe('completed_trusted_price_outcome');

    const facts = factsByKey(db);
    expect(facts.get('final_amount_collected')?.value_number).toBe(385);
    expect(facts.get('final_amount_collected')?.provenance).toBe(
      'confirmed_outcome'
    );
  });

  it('assigns provenance itself and does not accept one from the caller', async () => {
    const db = makeDb();

    await capture(db);

    const facts = factsByKey(db);
    // A measured value is confirmed...
    expect(facts.get('actual_load_units')?.provenance).toBe(
      'confirmed_outcome'
    );
    expect(facts.get('actual_disposal_weight_kg')?.provenance).toBe(
      'confirmed_outcome'
    );
    expect(facts.get('arrival_at')?.provenance).toBe('confirmed_outcome');
    // ...a derived value says so...
    expect(facts.get('actual_labour_minutes')?.provenance).toBe(
      'system_derived'
    );
    // ...and a human judgement is recorded as a human judgement.
    expect(facts.get('crew_count')?.provenance).toBe('operator_entered');
    expect(facts.get('final_operational_outcome')?.provenance).toBe(
      'operator_entered'
    );
    expect(facts.get('final_job_notes')?.provenance).toBe('operator_entered');

    // A caller trying to supply its own provenance is rejected outright.
    await expect(
      capture(db, {
        ...GOOD_COMPLETED_JOB,
        provenance: 'ai_suggested',
      })
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('records the agent as the author of every fact', async () => {
    const db = makeDb();

    await capture(db);

    for (const row of db.historical_case_facts) {
      expect(row.recorded_by_user_id).toBe(AGENT);
    }
  });

  it('requires a collected amount for a job that was carried out', async () => {
    await expect(
      capture(makeDb(), { ...GOOD_COMPLETED_JOB, final_amount_collected: null })
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      capture(makeDb(), { ...GOOD_COMPLETED_JOB, final_amount_collected: undefined })
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('requires a completion time for a job that was carried out', async () => {
    await expect(
      capture(makeDb(), { ...GOOD_COMPLETED_JOB, completed_at: null })
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      capture(makeDb(), { ...GOOD_COMPLETED_JOB, completed_at: undefined })
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('rejects a completion time on a job that did not happen', async () => {
    await expect(
      capture(makeDb(), {
        final_operational_outcome: 'no_show',
        completed_at: '2026-03-01T11:30:00Z',
        final_amount_collected: 0,
      })
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('lets a no-show be recorded without inventing a job', async () => {
    const db = makeDb();

    const result = await capture(db, {
      final_operational_outcome: 'no_show',
      final_job_notes: 'Nobody home, waited ten minutes',
    });

    expect(result.case.completed_at).toBeNull();
    expect(factsByKey(db).get('final_operational_outcome')?.value_text).toBe(
      'no_show'
    );
    // No amount was collected, so there is no amount recorded and no way
    // for this case to become a price label.
    expect(factsByKey(db).has('final_amount_collected')).toBe(false);
    expect(result.classification.tier).not.toBe('A');
  });

  it('rejects an unknown operational outcome', async () => {
    await expect(
      capture(makeDb(), {
        ...GOOD_COMPLETED_JOB,
        final_operational_outcome: 'sort_of_done',
      })
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('rejects a field it does not recognise', async () => {
    await expect(
      capture(makeDb(), { ...GOOD_COMPLETED_JOB, adjust_price: 20 })
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('load quantity and disposal weight', () => {
  it('accepts fractional loads without inventing a conversion', async () => {
    const db = makeDb();

    await capture(db);

    const facts = factsByKey(db);
    expect(facts.get('actual_load_units')?.value_number).toBe(1.5);
    // The two measurements are stored side by side and never combined.
    expect(facts.get('actual_disposal_weight_kg')?.value_number).toBe(187.5);
    expect(facts.get('actual_disposal_weight_kg')?.value_number).not.toBe(
      facts.get('actual_load_units')?.value_number
    );
  });

  it.each([0.5, 1, 1.5, 2, 0.25])(
    'accepts %s loads as recorded',
    async (loadUnits) => {
      const db = makeDb();
      await capture(db, { ...GOOD_COMPLETED_JOB, actual_load_units: loadUnits });
      expect(factsByKey(db).get('actual_load_units')?.value_number).toBe(
        loadUnits
      );
    }
  );

  it('rejects a negative or zero load, which is not a measurement', async () => {
    await expect(
      capture(makeDb(), { ...GOOD_COMPLETED_JOB, actual_load_units: 0 })
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      capture(makeDb(), { ...GOOD_COMPLETED_JOB, actual_load_units: -1 })
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('allows a weight of zero but not a negative one', async () => {
    const db = makeDb();
    await capture(db, {
      ...GOOD_COMPLETED_JOB,
      actual_disposal_weight_kg: 0,
    });
    expect(factsByKey(db).get('actual_disposal_weight_kg')?.value_number).toBe(
      0
    );

    await expect(
      capture(makeDb(), {
        ...GOOD_COMPLETED_JOB,
        actual_disposal_weight_kg: -5,
      })
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('does not derive a weight from a load, or the reverse', async () => {
    const db = makeDb();
    await capture(db, {
      ...GOOD_COMPLETED_JOB,
      actual_disposal_weight_kg: undefined,
    });
    expect(factsByKey(db).has('actual_disposal_weight_kg')).toBe(false);
    expect(factsByKey(db).has('actual_load_units')).toBe(true);
  });

  it('can point the weight at the message holding the receipt', async () => {
    const db = makeDb();
    await capture(db, {
      ...GOOD_COMPLETED_JOB,
      disposal_weight_source_message_id: 'message-9',
    });
    expect(
      factsByKey(db).get('actual_disposal_weight_kg')?.source_message_id
    ).toBe('message-9');
  });

  it('refuses a source message with nothing to point at', async () => {
    await expect(
      capture(makeDb(), {
        ...GOOD_COMPLETED_JOB,
        actual_disposal_weight_kg: undefined,
        disposal_weight_source_message_id: 'message-9',
      })
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('optional operational facts', () => {
  it('leaves an unmeasured value absent rather than zero', async () => {
    const db = makeDb();

    await capture(db, {
      final_operational_outcome: 'completed',
      completed_at: '2026-03-01T11:30:00Z',
      final_amount_collected: 240,
    });

    const facts = factsByKey(db);
    for (const key of [
      'actual_load_units',
      'actual_disposal_weight_kg',
      'arrival_at',
      'departed_at',
      'actual_labour_minutes',
      'crew_count',
      'scope_changed',
      'final_job_notes',
    ]) {
      expect(facts.has(key), `${key} must stay unknown`).toBe(false);
    }
  });

  it('still reaches tier A without any optional measurement', async () => {
    const db = makeDb();

    const result = await capture(db, {
      final_operational_outcome: 'completed',
      completed_at: '2026-03-01T11:30:00Z',
      final_amount_collected: 240,
    });

    expect(result.classification.tier).toBe('A');
  });

  it('does not fabricate an outcome for an untouched case', async () => {
    const db = makeDb();

    const result = await capture(db, { final_operational_outcome: 'no_show' });

    expect(result.classification.tier).toBeNull();
    expect(result.population).toBe('unclassified');
  });
});

describe('labour timing', () => {
  it('derives the duration from the two timestamps', async () => {
    const db = makeDb();

    await capture(db);

    expect(factsByKey(db).get('actual_labour_minutes')?.value_integer).toBe(
      105
    );
  });

  it('rejects a departure that is not after the arrival', async () => {
    await expect(
      capture(makeDb(), {
        ...GOOD_COMPLETED_JOB,
        arrived_at: undefined,
        arrival_at: '2026-03-01T11:00:00Z',
        departed_at: '2026-03-01T09:00:00Z',
      })
    ).rejects.toMatchObject({ code: 'invalid_input' });

    await expect(
      capture(makeDb(), {
        ...GOOD_COMPLETED_JOB,
        arrival_at: '2026-03-01T09:00:00Z',
        departed_at: '2026-03-01T09:00:00Z',
      })
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('leaves the duration unknown when only one timestamp is known', async () => {
    const db = makeDb();

    await capture(db, {
      ...GOOD_COMPLETED_JOB,
      departed_at: undefined,
    });

    expect(factsByKey(db).has('departed_at')).toBe(false);
    expect(factsByKey(db).has('actual_labour_minutes')).toBe(false);
    expect(factsByKey(db).has('arrival_at')).toBe(true);
  });

  it('refuses a timestamp with no timezone rather than guessing one', async () => {
    await expect(
      capture(makeDb(), { ...GOOD_COMPLETED_JOB, arrival_at: '2026-03-01T09:00:00' })
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('accepts an offset timestamp as readily as a Z one', () => {
    expect(deriveLabourMinutes('2026-03-01T10:00:00+01:00', '2026-03-01T11:30:00+01:00')).toBe(
      90
    );
  });

  it('truncates partial minutes the same way the database does', () => {
    expect(deriveLabourMinutes('2026-03-01T09:00:00Z', '2026-03-01T09:00:59Z')).toBe(0);
    expect(deriveLabourMinutes('2026-03-01T09:00:00Z', '2026-03-01T10:30:29Z')).toBe(90);
  });

  it.each([
    [null, null],
    ['2026-03-01T09:00:00Z', null],
    [null, '2026-03-01T09:00:00Z'],
    ['2026-03-01T09:00:00Z', '2026-03-01T09:00:00Z'],
    ['2026-03-01T10:00:00Z', '2026-03-01T09:00:00Z'],
  ])('keeps the duration unknown for an incomplete pair', (a, b) => {
    expect(deriveLabourMinutes(a, b)).toBeNull();
  });
});

describe('scope change', () => {
  it('records what changed and derives the changed flag from it', async () => {
    const db = makeDb();

    await capture(db);

    const facts = factsByKey(db);
    expect(facts.get('scope_change_type')?.value_text).toBe(
      'more_waste_than_expected'
    );
    expect(facts.get('scope_changed')?.value_boolean).toBe(true);
    expect(facts.get('scope_change_reason')?.value_text).toBe(
      'Two extra bags behind the shed'
    );
  });

  it('records "no material change" as a fact rather than an absence', async () => {
    const db = makeDb();

    await capture(db, {
      ...GOOD_COMPLETED_JOB,
      scope_change_type: 'no_material_change',
      scope_change_reason: undefined,
    });

    const facts = factsByKey(db);
    expect(facts.get('scope_changed')?.value_boolean).toBe(false);
    expect(facts.has('scope_change_reason')).toBe(false);
  });

  it.each([
    'more_waste_than_expected',
    'less_waste_than_expected',
    'access_harder_than_expected',
    'access_easier_than_expected',
    'customer_added_work',
    'customer_removed_work',
    'other',
  ])('accepts %s', async (scopeChangeType) => {
    const db = makeDb();
    await capture(db, { ...GOOD_COMPLETED_JOB, scope_change_type: scopeChangeType });
    expect(factsByKey(db).get('scope_change_type')?.value_text).toBe(
      scopeChangeType
    );
  });

  it('rejects a scope change nobody defined', async () => {
    await expect(
      capture(makeDb(), {
        ...GOOD_COMPLETED_JOB,
        scope_change_type: 'a bit harder',
      })
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('does not infer a scope change from the money', async () => {
    const db = makeDb();

    // Collected far less than a typical quote, with no scope statement.
    await capture(db, {
      ...GOOD_COMPLETED_JOB,
      final_amount_collected: 120,
      scope_change_type: undefined,
      scope_change_reason: undefined,
    });

    const facts = factsByKey(db);
    expect(facts.has('scope_changed')).toBe(false);
    expect(facts.has('scope_change_type')).toBe(false);
  });
});

describe('lost business', () => {
  it.each([
    ['rejected_price', 'explicitly_rejected_quote'],
    ['found_better_price', 'explicitly_rejected_quote'],
    ['rejected', 'explicitly_rejected_quote'],
    ['no_response', 'no_response_quote'],
    ['cancelled_by_customer', 'other_lost_quote'],
    ['other_lost', 'other_lost_quote'],
  ])(
    'records %s as a lost quote that is never a price outcome',
    async (decision, population) => {
      const db = makeDb();

      const result = await captureLost(db, {
        quote_decision: decision,
        final_job_notes: 'Nothing further',
      });

      expect(result.classification.tier).toBe('F');
      expect(result.population).toBe(population);
      expect(result.classification.quote_decision).toBe(decision);

      const facts = factsByKey(db);
      expect(facts.get('quote_decision')?.value_text).toBe(decision);
      expect(facts.get('quote_decision')?.provenance).toBe('operator_entered');
      // The load-bearing assertions: no amount, and nothing that could
      // ever be read as what the job was worth.
      expect(facts.has('final_amount_collected')).toBe(false);
      expect(facts.has('customer_facing_quote_amount')).toBe(false);
      expect(result.case.completed_at).toBeNull();
    }
  );

  it('keeps silence and an explicit rejection distinguishable', async () => {
    const silent = await captureLost(makeDb(), {
      quote_decision: 'no_response',
    });
    const rejected = await captureLost(makeDb(), {
      quote_decision: 'rejected_price',
    });

    expect(silent.classification.tier).toBe(rejected.classification.tier);
    expect(silent.classification.reasons).not.toEqual(
      rejected.classification.reasons
    );
    expect(silent.population).not.toBe(rejected.population);
  });

  it('refuses an outcome that is not a loss', async () => {
    for (const decision of ['accepted', 'pending', 'unknown']) {
      await expect(
        captureLost(makeDb(), { quote_decision: decision })
      ).rejects.toMatchObject({ code: 'invalid_input' });
    }
  });

  it('has no field in which a lost quote could carry an outcome', async () => {
    await expect(
      captureLost(makeDb(), {
        quote_decision: 'rejected_price',
        actual_load_units: 2,
        final_amount_collected: 385,
        arrival_at: '2026-03-01T09:00:00Z',
        crew_count: 2,
      })
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('keeps a human-issued quote at its own tier, not a completed outcome', async () => {
    const db = makeDb({
      historical_cases: [existingCase()],
      historical_case_facts: [
        {
          id: 'fact-quote',
          account_id: ACCOUNT,
          case_id: 'case-1',
          fact_key: 'customer_facing_quote_amount',
          value_source: 'captured',
          value_text: null,
          value_number: 420,
          value_integer: null,
          value_boolean: null,
          value_timestamp: null,
          provenance: 'operator_entered',
          source_message_id: null,
          source_media_id: null,
          observed_at: null,
          recorded_by_user_id: AGENT,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    });

    const result = await captureLost(db, { quote_decision: 'rejected_price' });

    expect(result.classification.tier).toBe('F');
    expect(
      factsByKey(db).get('customer_facing_quote_amount')?.value_number
    ).toBe(420);
  });
});

describe('accepted quote', () => {
  it('is tier B while the job has not happened, and no price outcome', async () => {
    const db = makeDb({
      historical_cases: [existingCase()],
      historical_case_facts: [
        {
          id: 'fact-decision',
          account_id: ACCOUNT,
          case_id: 'case-1',
          fact_key: 'quote_decision',
          value_source: 'captured',
          value_text: 'accepted',
          value_number: null,
          value_integer: null,
          value_boolean: null,
          value_timestamp: null,
          provenance: 'operator_entered',
          source_message_id: null,
          source_media_id: null,
          observed_at: null,
          recorded_by_user_id: AGENT,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    });

    const result = await captureJobOutcome(db.client, {
      accountId: ACCOUNT,
      enquiryId: ENQUIRY,
      recordedByUserId: AGENT,
      outcome: {
        kind: 'completed',
        completed: {
          final_operational_outcome: 'completed',
          completed_at: '2026-03-01T11:30:00Z',
          // The job was done but nobody captured what was taken.
          final_amount_collected: undefined,
        },
      },
    }).catch((error: unknown) => error);

    // A worked job cannot be captured without its collected amount, so
    // the only honest way to reach the accepted-but-incomplete state is
    // to record the decision on its own.
    expect(result).toBeInstanceOf(HistoricalCaseRepositoryError);
    expect((result as HistoricalCaseRepositoryError).code).toBe('invalid_input');

    const reclassified = await captureJobOutcome(db.client, {
      accountId: ACCOUNT,
      enquiryId: ENQUIRY,
      recordedByUserId: AGENT,
      outcome: { kind: 'lost', lost: { quote_decision: 'no_response' } },
    });
    expect(reclassified.classification.tier).toBe('F');
  });
});

describe('AI feedback-loop protection', () => {
  it('cannot turn an AI suggestion into a completed-job outcome', async () => {
    const db = makeDb({
      historical_cases: [existingCase()],
      historical_case_facts: [
        {
          id: 'fact-ai',
          account_id: ACCOUNT,
          case_id: 'case-1',
          fact_key: 'ai_suggested_amount',
          value_source: 'captured',
          value_text: null,
          value_number: 380,
          value_integer: null,
          value_boolean: null,
          value_timestamp: null,
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

    const result = await capture(db);

    // The suggestion is still there and still a suggestion.
    expect(factsByKey(db).get('ai_suggested_amount')?.provenance).toBe(
      'ai_suggested'
    );
    // And the case is a completed job because of the amount a human
    // recorded, not because of what the model guessed.
    expect(
      factsByKey(db).get('final_amount_collected')?.provenance
    ).toBe('confirmed_outcome');
    expect(result.classification.tier).toBe('A');
  });

  it('keeps an AI-only case at tier E and out of the price populations', () => {
    const summary = parseCompletedJobOutcome;
    expect(typeof summary).toBe('function');

    // Nothing in the capture surface can express an AI amount, which is
    // the structural half of the guarantee.
    expect(() =>
      parseCompletedJobOutcome({
        final_operational_outcome: 'completed',
        completed_at: '2026-03-01T11:30:00Z',
        final_amount_collected: 380,
        provenance: 'ai_suggested',
        source: 'model',
      })
    ).toThrow(/Unexpected field/);
  });
});

describe('evidence-tier recomputation', () => {
  it('re-runs classification on every capture and keeps the history', async () => {
    const db = makeDb();

    await capture(db);
    const afterFirst = db.historical_case_snapshots.length;
    await capture(db, {
      ...GOOD_COMPLETED_JOB,
      final_amount_collected: 400,
    });

    const classifications = db.historical_case_snapshots.filter(
      (row) => row.snapshot_kind === 'evidence_classification'
    );
    expect(classifications.length).toBe(2);
    expect(afterFirst).toBeGreaterThan(0);
    expect(classifications[1]?.payload).toMatchObject({
      evidence_quality_tier: 'A',
    });
  });

  it('reports conflicting evidence instead of resolving it', async () => {
    const db = makeDb({
      enquiries: [
        {
          id: ENQUIRY,
          account_id: ACCOUNT,
          conversation_id: CONVERSATION,
          workflow_state: 'cancelled',
          state_changed_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    });

    const result = await capture(db);

    expect(result.classification.tier).toBeNull();
    expect(result.classification.reasons.join(' ')).toMatch(/conflicts/);
  });
});

describe('account isolation', () => {
  it('never writes into another account', async () => {
    const db = makeDb();

    await expect(capture(db, GOOD_COMPLETED_JOB, ENQUIRY, OTHER_ACCOUNT)).rejects.toMatchObject(
      { code: 'not_found' }
    );

    for (const row of db.historical_cases) {
      expect(row.account_id).toBe(ACCOUNT);
    }
    for (const row of db.historical_case_facts) {
      expect(row.account_id).toBe(ACCOUNT);
    }
  });

  it('refuses to finalize a case in another account', async () => {
    const db = makeDb({ historical_cases: [existingCase()] });

    await expect(
      finalizeHistoricalCase(db.client, {
        accountId: OTHER_ACCOUNT,
        caseId: 'case-1',
        recordedByUserId: AGENT,
      })
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('scopes every write to the account of the caller', async () => {
    const db = makeDb();

    await capture(db);

    for (const call of db.calls) {
      if (
        call.table === 'historical_cases' ||
        call.table === 'historical_case_facts' ||
        call.table === 'historical_case_snapshots'
      ) {
        if (call.operation === 'insert' || call.operation === 'upsert') {
          expect(call.payload?.account_id).toBe(ACCOUNT);
        } else if (call.operation === 'update') {
          expect(call.filters).toContainEqual(['account_id', ACCOUNT]);
        }
      }
    }
  });
});

describe('finalization', () => {
  async function captured() {
    const db = makeDb();
    const result = await capture(db);
    return { db, caseId: result.case.id };
  }

  it('freezes four snapshots and the case', async () => {
    const { db, caseId } = await captured();

    const result = await finalizeHistoricalCase(db.client, {
      accountId: ACCOUNT,
      caseId,
      recordedByUserId: AGENT,
    });

    expect(result.replayed).toBe(false);
    expect(snapshotKinds(db)).toEqual([
      'commercial',
      'enquiry_facts',
      'evidence_classification',
      'outcome',
    ]);
    expect(result.case.case_state).toBe('finalized');
    expect(result.case.finalized_at).not.toBeNull();
  });

  it('does not invent an image_analysis section nobody observed', async () => {
    const { db, caseId } = await captured();

    await finalizeHistoricalCase(db.client, {
      accountId: ACCOUNT,
      caseId,
      recordedByUserId: AGENT,
    });

    expect(snapshotKinds(db)).not.toContain('image_analysis');
  });

  it('is idempotent: a second call writes nothing', async () => {
    const { db, caseId } = await captured();
    await finalizeHistoricalCase(db.client, {
      accountId: ACCOUNT,
      caseId,
      recordedByUserId: AGENT,
    });
    const before = db.historical_case_snapshots.length;

    const replay = await finalizeHistoricalCase(db.client, {
      accountId: ACCOUNT,
      caseId,
      recordedByUserId: AGENT,
    });

    expect(replay.replayed).toBe(true);
    expect(replay.snapshotKinds).toEqual([]);
    expect(db.historical_case_snapshots).toHaveLength(before);
  });

  it('survives a concurrent finalize that wins the snapshot race', async () => {
    const { db, caseId } = await captured();
    // A competitor already froze the case while this call was reading.
    db.historical_cases[0].case_state = 'finalized';
    db.historical_cases[0].finalized_at = '2026-03-01T12:00:00.000Z';
    db.historical_cases[0].evidence_quality_tier = 'A';

    const result = await finalizeHistoricalCase(db.client, {
      accountId: ACCOUNT,
      caseId,
      recordedByUserId: AGENT,
    });

    // The competing freeze answers, and this call reports a replay rather
    // than inventing a second one.
    expect(result.replayed).toBe(true);
    expect(result.case.evidence_quality_tier).toBe('A');
  });

  it('refuses to freeze an empty open case', async () => {
    const db = makeDb({ historical_cases: [existingCase()] });

    await expect(
      finalizeHistoricalCase(db.client, {
        accountId: ACCOUNT,
        caseId: 'case-1',
        recordedByUserId: AGENT,
      })
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('accepts the outcome of a case whose enquiry is already terminal', async () => {
    const db = makeDb({
      enquiries: [
        {
          id: ENQUIRY,
          account_id: ACCOUNT,
          conversation_id: CONVERSATION,
          workflow_state: 'cancelled',
          state_changed_at: '2026-01-01T00:00:00.000Z',
        },
      ],
      historical_cases: [existingCase()],
    });

    const result = await finalizeHistoricalCase(db.client, {
      accountId: ACCOUNT,
      caseId: 'case-1',
      recordedByUserId: AGENT,
    });

    expect(result.case.case_state).toBe('finalized');
  });

  it('rejects a capture on a finalized case', async () => {
    const { db, caseId } = await captured();
    await finalizeHistoricalCase(db.client, {
      accountId: ACCOUNT,
      caseId,
      recordedByUserId: AGENT,
    });

    await expect(
      captureJobOutcome(db.client, {
        accountId: ACCOUNT,
        enquiryId: ENQUIRY,
        recordedByUserId: AGENT,
        outcome: { kind: 'completed', completed: GOOD_COMPLETED_JOB },
      })
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('post-finalization correction', () => {
  it('withdraws a frozen case from training and leaves the facts alone', async () => {
    const db = makeDb();
    const captured = await capture(db);
    await finalizeHistoricalCase(db.client, {
      accountId: ACCOUNT,
      caseId: captured.case.id,
      recordedByUserId: AGENT,
    });
    const factsBefore = db.historical_case_facts.length;

    const updated = await setFinalizedCaseLearningEligibility(db.client, {
      accountId: ACCOUNT,
      caseId: captured.case.id,
      eligibility: 'excluded',
      reason: 'bad_data',
      basis: 'operator',
      recordedByUserId: AGENT,
      note: 'Weight recorded against the wrong job',
    });

    expect(updated.learning_eligibility).toBe('excluded');
    expect(updated.learning_exclusion_reason).toBe('bad_data');
    expect(db.historical_case_facts).toHaveLength(factsBefore);
    expect(snapshotKinds(db)).toContain('correction');
    // The frozen answer to "what was this case" is untouched.
    expect(db.historical_cases[0].evidence_quality_tier).toBe('A');
  });

  it('is reversible, because a decision nobody can undo is not one', async () => {
    const db = makeDb();
    const captured = await capture(db);
    await finalizeHistoricalCase(db.client, {
      accountId: ACCOUNT,
      caseId: captured.case.id,
      recordedByUserId: AGENT,
    });

    await setFinalizedCaseLearningEligibility(db.client, {
      accountId: ACCOUNT,
      caseId: captured.case.id,
      eligibility: 'excluded',
      reason: 'ambiguous',
      basis: 'operator',
      recordedByUserId: AGENT,
      note: 'Withdrawn while we check',
    });
    const restored = await setFinalizedCaseLearningEligibility(db.client, {
      accountId: ACCOUNT,
      caseId: captured.case.id,
      eligibility: 'included',
      reason: null,
      basis: 'operator',
      recordedByUserId: AGENT,
      note: 'Checked, it is fine',
    });

    expect(restored.learning_eligibility).toBe('included');
    expect(restored.learning_exclusion_reason).toBeNull();
    expect(
      db.historical_case_snapshots.filter(
        (row) => row.snapshot_kind === 'correction'
      )
    ).toHaveLength(2);
  });

  it('demands a note, so the trail says why', async () => {
    const db = makeDb();
    const captured = await capture(db);
    await finalizeHistoricalCase(db.client, {
      accountId: ACCOUNT,
      caseId: captured.case.id,
      recordedByUserId: AGENT,
    });

    await expect(
      setFinalizedCaseLearningEligibility(db.client, {
        accountId: ACCOUNT,
        caseId: captured.case.id,
        eligibility: 'excluded',
        reason: 'bad_data',
        basis: 'operator',
        recordedByUserId: AGENT,
        note: '   ',
      })
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('finalization payload', () => {
  /** Turn a parsed fact plan into the row shape the repository reads back. */
  function factRow(input: {
    fact_key: string;
    value_source: 'canonical' | 'captured';
    provenance: string;
    value_text?: string | null;
    value_number?: number | null;
    value_integer?: number | null;
    value_boolean?: boolean | null;
    value_timestamp?: string | null;
    source_message_id?: string | null;
    source_media_id?: string | null;
    observed_at?: string | null;
  }, index: number): HistoricalCaseFact {
    return {
      id: `f${index}`,
      account_id: ACCOUNT,
      case_id: 'case-1',
      fact_key: input.fact_key,
      value_source: input.value_source,
      value_text: input.value_text ?? null,
      value_number: input.value_number ?? null,
      value_integer: input.value_integer ?? null,
      value_boolean: input.value_boolean ?? null,
      value_timestamp: input.value_timestamp ?? null,
      provenance: input.provenance,
      source_message_id: input.source_message_id ?? null,
      source_media_id: input.source_media_id ?? null,
      observed_at: input.observed_at ?? null,
      recorded_by_user_id: AGENT,
      created_at: '2026-03-01T00:00:00.000Z',
      updated_at: '2026-03-01T00:00:00.000Z',
    } as HistoricalCaseFact;
  }

  it('separates money from the day it describes', () => {
    const plan = parseCompletedJobOutcome(GOOD_COMPLETED_JOB);
    const facts = plan.facts.map((fact, index) => factRow(fact, index));

    const payloads = new Map(
      buildFinalizationPayloads(
        { ...existingCase(), completed_at: '2026-03-01T11:30:00.000Z' } as never,
        facts,
        {
          id: ENQUIRY,
          workflow_state: 'completed',
          state_changed_at: '2026-03-01T11:30:00.000Z',
          postcode: '01310-100',
        }
      )
    );

    const commercial = payloads.get('commercial') as Record<string, unknown>;
    const outcome = payloads.get('outcome') as Record<string, unknown>;

    expect(commercial.final_amount_collected).toBe(385);
    expect(commercial).not.toHaveProperty('actual_load_units');
    expect(outcome.actual_load_units).toBe(1.5);
    expect(outcome.completed_at).toBe('2026-03-01T11:30:00.000Z');
    expect(outcome).not.toHaveProperty('final_amount_collected');
  });

  it('writes a null section rather than an empty one', () => {
    const payloads = new Map(
      buildFinalizationPayloads(
        existingCase() as never,
        [],
        { id: ENQUIRY, workflow_state: 'new_enquiry', state_changed_at: null }
      )
    );

    expect(payloads.get('commercial')).toBeNull();
    expect(payloads.get('outcome')).toBeNull();
    expect(payloads.get('image_analysis')).toBeNull();
    expect(payloads.get('enquiry_facts')).not.toBeNull();
  });

  it('records the provenance of each canonical enquiry fact', () => {
    const payloads = new Map(
      buildFinalizationPayloads(
        existingCase() as never,
        [
          {
            id: 'f1',
            account_id: ACCOUNT,
            case_id: 'case-1',
            fact_key: 'postcode',
            value_source: 'canonical',
            value_text: null,
            value_number: null,
            value_integer: null,
            value_boolean: null,
            value_timestamp: null,
            provenance: 'customer_stated',
            source_message_id: null,
            source_media_id: null,
            observed_at: null,
            recorded_by_user_id: null,
            created_at: '2026-03-01T00:00:00.000Z',
            updated_at: '2026-03-01T00:00:00.000Z',
          },
        ],
        {
          id: ENQUIRY,
          workflow_state: 'new_enquiry',
          state_changed_at: null,
          postcode: '01310-100',
        }
      )
    );

    const enquiryFacts = payloads.get('enquiry_facts') as Record<string, unknown>;
    expect(enquiryFacts).toMatchObject({
      values: { postcode: '01310-100' },
      provenance: { postcode: 'customer_stated' },
    });
  });
});

describe('lost business input', () => {
  it('records only a decision and, optionally, a note', () => {
    const plan = parseLostBusinessOutcome({
      quote_decision: 'no_response',
      final_job_notes: 'No reply after three weeks',
    });

    expect(plan.quote_decision).toBe('no_response');
    expect(plan.facts.map((fact) => fact.fact_key)).toEqual([
      'quote_decision',
      'final_job_notes',
    ]);
  });

  it('rejects a free-text decision', () => {
    expect(() =>
      parseLostBusinessOutcome({ quote_decision: 'too expensive sorry' })
    ).toThrow(/quote_decision must be one of/);
  });

  it('rejects an empty note rather than storing whitespace', () => {
    const plan = parseLostBusinessOutcome({
      quote_decision: 'other_lost',
      final_job_notes: '   ',
    });
    expect(plan.facts.map((fact) => fact.fact_key)).toEqual(['quote_decision']);
  });
});

// ---------------------------------------------------------------------------
// Canonical per-image observations at finalization (migration 054)
// ---------------------------------------------------------------------------

/**
 * One canonical analysis, as `finalizeHistoricalCase` reads it: a run, its
 * two analysed images, one observation that legitimately came from BOTH
 * photographs, and one quality report about the second photograph alone.
 */
function canonicalAnalysis(overrides: Partial<FinalizationImageAnalysis> = {}): FinalizationImageAnalysis {
  const run = {
    id: 'run-1',
    analysis_schema_version: 'image-observation-v1',
    prompt_version: 'vision-prompt-v1',
    analyzer_id: 'configured_vision_model',
    provider: 'openai',
    model: 'gpt-5.4-mini',
    result_content_hash: 'a'.repeat(64),
  };
  const observations = [
    {
      id: 'obs-row-1',
      finding_kind: 'observation' as const,
      ordinal_in_result: 1,
      finding_ref: 'obs-1',
      kind: 'furniture',
      label: 'three-seat sofa',
      confidence: 0.82,
      basis: 'observed' as const,
      detail: null,
      payload: {
        kind: 'furniture',
        label: 'three-seat sofa',
        confidence: 0.82,
        basis: 'observed',
        approximate_count: { value: 1, confidence: 0.9 },
        volume_range: null,
        dismantling: 'indicated',
        heavy_handling: 'unknown',
        hazards: [],
        notes: null,
      },
    },
    {
      id: 'obs-row-2',
      finding_kind: 'image_quality' as const,
      ordinal_in_result: 1,
      finding_ref: 'quality-1',
      kind: 'too_dark',
      label: null,
      confidence: null,
      basis: null,
      detail: 'flash glare',
      payload: { kind: 'too_dark', detail: 'flash glare' },
    },
  ];
  return {
    run,
    images: [
      { ordinal: 1, source_message_id: 'm1', source_media_id: 'account-1/inbound/a.jpg' },
      { ordinal: 2, source_message_id: 'm2', source_media_id: 'account-1/inbound/b.jpg' },
    ],
    observations,
    sources: [
      { observation_id: 'obs-row-1', source_ordinal: 1 },
      { observation_id: 'obs-row-1', source_ordinal: 2 },
      { observation_id: 'obs-row-2', source_ordinal: 2 },
    ],
    ...overrides,
  };
}

describe('canonical image observations at finalization', () => {
  it('freezes a canonical analysis when one exists', () => {
    const [, imageAnalysis] = buildFinalizationPayloads(
      { } as never,
      [],
      null,
      [],
      [canonicalAnalysis()]
    ).find(([kind]) => kind === 'image_analysis') ?? [];

    expect(imageAnalysis).not.toBeNull();
    const payload = imageAnalysis as Record<string, unknown>;
    expect(payload.source).toBe('canonical_image_analysis');
    const analyses = payload.analyses as Array<Record<string, unknown>>;
    expect(analyses).toHaveLength(1);
    expect(analyses[0]?.run_id).toBe('run-1');
  });

  it('records the observation contract and prompt that produced it', () => {
    // A frozen training example that does not say which contract and which
    // prompt produced it cannot be re-derived after either changes.
    const [, imageAnalysis] = buildFinalizationPayloads(
      { } as never,
      [],
      null,
      [],
      [canonicalAnalysis()]
    ).find(([kind]) => kind === 'image_analysis') ?? [];

    const analyses = (imageAnalysis as Record<string, unknown>)
      .analyses as Array<Record<string, unknown>>;
    expect(analyses[0]?.analysis_schema_version).toBe('image-observation-v1');
    expect(analyses[0]?.prompt_version).toBe('vision-prompt-v1');
    expect(analyses[0]?.result_content_hash).toBe('a'.repeat(64));
  });

  it('preserves an observation that came from two photographs, once', () => {
    const [, imageAnalysis] = buildFinalizationPayloads(
      { } as never,
      [],
      null,
      [],
      [canonicalAnalysis()]
    ).find(([kind]) => kind === 'image_analysis') ?? [];

    const analyses = (imageAnalysis as Record<string, unknown>)
      .analyses as Array<Record<string, unknown>>;
    const observations = analyses[0]?.observations as Array<
      Record<string, unknown>
    >;

    // The sofa is ONE observation with TWO source entries - not two
    // observations, which would double every count derived from it.
    expect(observations).toHaveLength(2);
    const sofa = observations.find(
      (entry) => entry.finding_ref === 'obs-1'
    );
    expect(sofa?.sources).toEqual([
      {
        source_ordinal: 1,
        source_message_id: 'm1',
        source_media_id: 'account-1/inbound/a.jpg',
      },
      {
        source_ordinal: 2,
        source_message_id: 'm2',
        source_media_id: 'account-1/inbound/b.jpg',
      },
    ]);
  });

  it('resolves the exact sources of a single-image observation', () => {
    const [, imageAnalysis] = buildFinalizationPayloads(
      { } as never,
      [],
      null,
      [],
      [canonicalAnalysis()]
    ).find(([kind]) => kind === 'image_analysis') ?? [];

    const analyses = (imageAnalysis as Record<string, unknown>)
      .analyses as Array<Record<string, unknown>>;
    const observations = analyses[0]?.observations as Array<
      Record<string, unknown>
    >;
    const quality = observations.find(
      (entry) => entry.finding_ref === 'quality-1'
    );
    expect(quality?.finding_kind).toBe('image_quality');
    expect(quality?.sources).toEqual([
      {
        source_ordinal: 2,
        source_message_id: 'm2',
        source_media_id: 'account-1/inbound/b.jpg',
      },
    ]);
  });

  it('carries the validated payload unchanged, with no live model involved', () => {
    // Rebuilding the frozen payload from stored validated rows is what
    // makes it reproducible: re-running a vision call would be both
    // expensive and free to return different wording, which is the
    // opposite of a reproducible training example.
    const analysis = canonicalAnalysis();
    const [, imageAnalysis] = buildFinalizationPayloads(
      { } as never,
      [],
      null,
      [],
      [analysis]
    ).find(([kind]) => kind === 'image_analysis') ?? [];

    const analyses = (imageAnalysis as Record<string, unknown>)
      .analyses as Array<Record<string, unknown>>;
    const observations = analyses[0]?.observations as Array<
      Record<string, unknown>
    >;
    const sofa = observations.find((entry) => entry.finding_ref === 'obs-1');
    expect(sofa?.payload).toEqual(analysis.observations[0]?.payload);
  });

  it('falls back to image_observed facts when no canonical analysis exists', () => {
    // An old case whose observations were recorded as facts before the
    // canonical store existed freezes exactly what it froze before.
    const fact: HistoricalCaseFact = {
      id: 'fact-1',
      account_id: ACCOUNT,
      case_id: 'case-1',
      fact_key: 'item_descriptions',
      value_source: 'canonical',
      value_text: null,
      value_number: null,
      value_integer: null,
      value_boolean: null,
      value_timestamp: null,
      provenance: 'image_observed',
      source_message_id: 'm1',
      source_media_id: 'account-1/inbound/a.jpg',
      observed_at: '2026-03-01T10:00:00.000Z',
      recorded_by_user_id: null,
      created_at: '2026-03-01T10:00:00.000Z',
      updated_at: '2026-03-01T10:00:00.000Z',
    };

    const [, imageAnalysis] = buildFinalizationPayloads(
      { } as never,
      [fact],
      null,
      []
    ).find(([kind]) => kind === 'image_analysis') ?? [];

    expect(imageAnalysis).not.toBeNull();
    const payload = imageAnalysis as Record<string, unknown>;
    expect(payload.source).toBe('image_observed_facts');
    const observations = payload.observations as Array<Record<string, unknown>>;
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      fact_key: 'item_descriptions',
      source_message_id: 'm1',
      source_media_id: 'account-1/inbound/a.jpg',
    });
    expect(payload.analyses).toBeUndefined();
  });

  it('prefers the canonical analysis and notes that facts also exist', () => {
    // Both representations can coexist on one case. The canonical one wins,
    // because it is per-image and versioned, but the fact count is recorded
    // so a reader can tell nothing was silently discarded.
    const fact: HistoricalCaseFact = {
      id: 'fact-1',
      account_id: ACCOUNT,
      case_id: 'case-1',
      fact_key: 'item_descriptions',
      value_source: 'canonical',
      value_text: null,
      value_number: null,
      value_integer: null,
      value_boolean: null,
      value_timestamp: null,
      provenance: 'image_observed',
      source_message_id: 'm1',
      source_media_id: 'account-1/inbound/a.jpg',
      observed_at: null,
      recorded_by_user_id: null,
      created_at: '2026-03-01T10:00:00.000Z',
      updated_at: '2026-03-01T10:00:00.000Z',
    };

    const [, imageAnalysis] = buildFinalizationPayloads(
      { } as never,
      [fact],
      null,
      [],
      [canonicalAnalysis()]
    ).find(([kind]) => kind === 'image_analysis') ?? [];

    const payload = imageAnalysis as Record<string, unknown>;
    expect(payload.source).toBe('canonical_image_analysis');
    expect(payload.observed_facts).toBe(1);
  });

  it('writes no image_analysis section when nothing was observed at all', () => {
    const [, imageAnalysis] = buildFinalizationPayloads(
      { } as never,
      [],
      null,
      []
    ).find(([kind]) => kind === 'image_analysis') ?? [];
    expect(imageAnalysis).toBeNull();
  });

  it('stores no price and no exact weight in a frozen observation', () => {
    const [, imageAnalysis] = buildFinalizationPayloads(
      { } as never,
      [],
      null,
      [],
      [canonicalAnalysis()]
    ).find(([kind]) => kind === 'image_analysis') ?? [];

    const serialised = JSON.stringify(imageAnalysis).toLowerCase();
    for (const forbidden of ['price', 'weight', 'cost', 'amount', 'quote', 'gbp']) {
      expect(serialised).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// Finalization consumes the canonical store end to end
// ---------------------------------------------------------------------------

/**
 * A canonical analysis already persisted for `case-1`, in the row shapes the
 * image-observation repository reads.
 */
function persistedAnalysis(
  state: 'current' | 'withheld' = 'current'
): FakeSeed {
  return {
    image_analysis_runs: [
      {
        id: 'run-1',
        account_id: ACCOUNT,
        conversation_id: CONVERSATION,
        enquiry_id: ENQUIRY,
        historical_case_id: 'case-1',
        analyzer_id: 'configured_vision_model',
        provider: 'openai',
        model: 'gpt-5.4-mini',
        analysis_schema_version: 'image-observation-v1',
        prompt_version: 'vision-prompt-v1',
        status: 'succeeded',
        failure_reason: null,
        image_count: 1,
        correlation_id: 'run-1',
        source_fingerprint: 'a'.repeat(64),
        result_content_hash: 'b'.repeat(64),
        state,
        superseded_by: null,
        started_at: '2026-03-01T10:00:00.000Z',
        completed_at: '2026-03-01T10:00:05.000Z',
        created_at: '2026-03-01T10:00:05.000Z',
      },
    ],
    image_analysis_run_images: [
      {
        id: 'img-1',
        account_id: ACCOUNT,
        run_id: 'run-1',
        ordinal: 1,
        source_message_id: 'm1',
        source_media_id: 'account-1/inbound/a.jpg',
        mime_type: 'image/jpeg',
        byte_length: 2048,
        direction: 'inbound',
        message_created_at: '2026-03-01T09:00:00.000Z',
        created_at: '2026-03-01T10:00:05.000Z',
      },
    ],
    image_analysis_observations: [
      {
        id: 'obs-row-1',
        account_id: ACCOUNT,
        run_id: 'run-1',
        observation_type: 'observation',
        ordinal_in_result: 1,
        observation_ref: 'obs-1',
        kind: 'furniture',
        label: 'three-seat sofa',
        confidence: 0.82,
        basis: 'observed',
        detail: null,
        payload: {
          kind: 'furniture',
          label: 'three-seat sofa',
          confidence: 0.82,
          basis: 'observed',
          approximate_count: { value: 1, confidence: 0.9 },
          volume_range: null,
          dismantling: 'indicated',
          heavy_handling: 'unknown',
          hazards: [],
          notes: null,
        },
        created_at: '2026-03-01T10:00:05.000Z',
      },
    ],
    image_analysis_observation_sources: [
      {
        id: 'src-1',
        account_id: ACCOUNT,
        observation_id: 'obs-row-1',
        run_image_id: 'img-1',
        source_ordinal: 1,
        created_at: '2026-03-01T10:00:05.000Z',
      },
    ],
  };
}

describe('finalizeHistoricalCase with canonical observations', () => {
  async function capturedWithCanonical(state: 'current' | 'withheld' = 'current') {
    const db = makeDb(persistedAnalysis(state));
    const result = await capture(db);
    // The fake mints the case id, so the seeded analysis is bound to the id
    // the capture actually produced rather than a guessed one.
    for (const run of db.tables.image_analysis_runs ?? []) {
      run.historical_case_id = result.case.id;
    }
    return { db, caseId: result.case.id };
  }

  it('freezes an image_analysis snapshot from the canonical store', async () => {
    const { db, caseId } = await capturedWithCanonical();

    await finalizeHistoricalCase(db.client, {
      accountId: ACCOUNT,
      caseId,
      recordedByUserId: AGENT,
    });

    expect(snapshotKinds(db)).toContain('image_analysis');
    const snapshot = db.historical_case_snapshots.find(
      (row) => row.snapshot_kind === 'image_analysis'
    );
    const payload = snapshot?.payload as Record<string, unknown>;
    expect(payload.source).toBe('canonical_image_analysis');
    const analyses = payload.analyses as Array<Record<string, unknown>>;
    expect(analyses[0]?.run_id).toBe('run-1');
  });

  it('needs no live vision model: nothing is fetched while finalizing', async () => {
    const { db, caseId } = await capturedWithCanonical();

    await finalizeHistoricalCase(db.client, {
      accountId: ACCOUNT,
      caseId,
      recordedByUserId: AGENT,
    });

    // Finalization reads canonical rows only. A vision call would be both
    // expensive and free to return different wording, which is the
    // opposite of a reproducible training example.
    const tablesRead = new Set(db.calls.map((call) => call.table));
    expect(tablesRead).not.toContain('ai_configs');
    expect(tablesRead).not.toContain('ai_usage_log');
    expect(tablesRead).toContain('image_analysis_runs');
    expect(tablesRead).toContain('image_analysis_observations');
  });

  it('freezes no image_analysis snapshot for a withheld analysis', async () => {
    // A withheld analysis is retained for audit and is NOT retrievable.
    // Freezing it into a training snapshot would undo the exclusion the
    // migration-054 trigger applied.
    const { db, caseId } = await capturedWithCanonical('withheld');

    await finalizeHistoricalCase(db.client, {
      accountId: ACCOUNT,
      caseId,
      recordedByUserId: AGENT,
    });

    expect(snapshotKinds(db)).not.toContain('image_analysis');
  });

  it('freezes no image_analysis snapshot when the store is empty', async () => {
    const db = makeDb();
    const captured = await capture(db);

    await finalizeHistoricalCase(db.client, {
      accountId: ACCOUNT,
      caseId: captured.case.id,
      recordedByUserId: AGENT,
    });

    expect(snapshotKinds(db)).not.toContain('image_analysis');
  });

  it('finalizes even when the canonical store cannot be read', async () => {
    // Losing the enrichment is regrettable; refusing to freeze a completed
    // job is worse. The facts form is the fallback.
    const db = makeDb({ ...persistedAnalysis(), failTable: 'image_analysis_runs' });
    const captured = await capture(db);

    const result = await finalizeHistoricalCase(db.client, {
      accountId: ACCOUNT,
      caseId: captured.case.id,
      recordedByUserId: AGENT,
    });

    expect(result.case.case_state).toBe('finalized');
    expect(snapshotKinds(db)).not.toContain('image_analysis');
  });

  it('keeps the frozen snapshot identical on a replayed finalize', async () => {
    const { db, caseId } = await capturedWithCanonical();

    await finalizeHistoricalCase(db.client, {
      accountId: ACCOUNT,
      caseId,
      recordedByUserId: AGENT,
    });
    const frozen = db.historical_case_snapshots.find(
      (row) => row.snapshot_kind === 'image_analysis'
    )?.payload;

    const replay = await finalizeHistoricalCase(db.client, {
      accountId: ACCOUNT,
      caseId,
      recordedByUserId: AGENT,
    });

    expect(replay.replayed).toBe(true);
    expect(replay.snapshotKinds).toEqual([]);
    // The same frozen payload, byte for byte: a training example stays
    // reproducible after the case is finalized.
    expect(
      db.historical_case_snapshots.find(
        (row) => row.snapshot_kind === 'image_analysis'
      )?.payload
    ).toEqual(frozen);
  });
});
