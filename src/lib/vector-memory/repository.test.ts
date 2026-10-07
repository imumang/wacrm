import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  VECTOR_EMBEDDING_DIMENSIONS,
  VECTOR_EMBEDDING_MODEL,
  VECTOR_EMBEDDING_MODEL_VERSION,
  type GeneratedCaseEmbedding,
} from './model';
import {
  CaseEmbeddingRepositoryError,
  countEmbeddingCoverage,
  findCaseEmbeddingByIdentity,
  listCurrentEmbeddings,
  listEmbeddingEligibleCases,
  loadCurrentEmbedding,
  markEmbeddingStale,
  storeCaseEmbedding,
} from './repository';

/**
 * A deliberately strict fake.
 *
 * It reproduces the constraints migration 053 relies on — account
 * scoping on every query, one current row per (case, kind), identity
 * uniqueness — so a repository function that stops filtering by account
 * or stops checking identity fails here rather than in production.
 */

interface Row extends Record<string, unknown> {
  id: string;
  account_id: string;
  historical_case_id: string;
  embedding_kind: string;
  state: string;
  content_hash: string;
  semantic_input_version: string;
}

interface State {
  rows: Row[];
  inserts: Row[];
  updates: Array<{ id: string; patch: Record<string, unknown> }>;
  queries: Array<{ table: string; filters: Record<string, unknown> }>;
  caseRows: Array<Record<string, unknown>>;
  snapshotRows: Array<Record<string, unknown>>;
  nextId: number;
}

const IDENTITY_KEYS = [
  'account_id',
  'historical_case_id',
  'embedding_kind',
  'semantic_input_version',
  'provider',
  'embedding_model',
  'model_version',
  'content_hash',
] as const;

function makeDb(
  options: {
    currentRow?: Row;
    caseRows?: Array<Record<string, unknown>>;
    snapshotRows?: Array<Record<string, unknown>>;
  } = {}
) {
  const state: State = {
    rows: options.currentRow ? [options.currentRow] : [],
    inserts: [],
    updates: [],
    queries: [],
    caseRows: options.caseRows ?? [],
    snapshotRows: options.snapshotRows ?? [],
    nextId: 1,
  };

  const table = (name: string) => {
    const filters: Record<string, unknown> = {};
    let mode: 'select' | 'insert' | 'update' = 'select';
    let payload: Record<string, unknown> = {};
    const log = () =>
      state.queries.push({ table: name, filters: { ...filters } });

    const source = () => {
      if (name === 'historical_cases') return state.caseRows as unknown as Row[];
      if (name === 'historical_case_snapshots')
        return state.snapshotRows as unknown as Row[];
      return state.rows;
    };

    const applyFilters = (row: Row): boolean => {
      for (const [k, v] of Object.entries(filters)) {
        if (k.startsWith('ne:')) {
          if (row[k.slice(3)] === v) return false;
        } else if (k === 'range') {
          // Paging is not exercised for the embedding table.
        } else if (row[k] !== v) return false;
      }
      return true;
    };

    const runMany = async (): Promise<{ data: unknown; error: unknown }> => {
      log();
      return { data: source().filter(applyFilters), error: null };
    };

    const run = async (): Promise<{ data: unknown; error: unknown }> => {
      if (mode === 'insert') {
        const row = { ...(payload as Row) };
        const all = source();
        // Identity uniqueness (idx_case_embeddings_identity_unique).
        if (
          all.some((r) => IDENTITY_KEYS.every((k) => r[k] === row[k]))
        ) {
          return { data: null, error: { code: '23505' } };
        }
        // One current per (account, case, kind)
        // (idx_case_embeddings_one_current).
        if (
          row.state === 'current' &&
          all.some(
            (r) =>
              r.state === 'current' &&
              r.account_id === row.account_id &&
              r.historical_case_id === row.historical_case_id &&
              r.embedding_kind === row.embedding_kind
          )
        ) {
          return { data: null, error: { code: '23505' } };
        }
        const created = {
          ...row,
          id: `emb-${state.nextId++}`,
          created_at: '2026-01-01T00:00:00Z',
          refreshed_at: '2026-01-01T00:00:00Z',
        } as Row;
        all.push(created);
        state.inserts.push(created);
        return { data: created, error: null };
      }

      log();

      if (mode === 'update') {
        const found = source().filter((r) => applyFilters(r));
        for (const r of found) {
          state.updates.push({ id: r.id, patch: payload });
          Object.assign(r, payload);
        }
        return { data: found[0] ?? null, error: null };
      }

      return { data: source().find(applyFilters) ?? null, error: null };
    };

    // `select` must NOT reset a pending insert/update: the Supabase
    // client chains .insert().select().single().
    const chain = {
      select: () => chain,
      insert: (row: Record<string, unknown>) => {
        mode = 'insert';
        payload = row;
        return chain;
      },
      update: (patch: Record<string, unknown>) => {
        mode = 'update';
        payload = patch;
        return chain;
      },
      eq: (column: string, value: unknown) => {
        filters[column] = value;
        return chain;
      },
      neq: (column: string, value: unknown) => {
        filters[`ne:${column}`] = value;
        return chain;
      },
      order: () => chain,
      limit: () => chain,
      range: (from: number, to: number) => {
        filters.range = [from, to];
        return chain;
      },
      single: run,
      maybeSingle: run,
      // A list read is awaited directly; a single read uses
      // .single()/.maybeSingle(). Modelling the difference matters, since
      // mapping over a single object would fail loudly rather than
      // silently returning one row.
      then: (resolve: (value: unknown) => unknown) => runMany().then(resolve),
    };
    return chain;
  };

  return { db: { from: table } as unknown as SupabaseClient, state };
}

function storedRow(overrides: Partial<Row> = {}): Row {
  return {
    id: 'emb-1',
    account_id: 'acct-1',
    historical_case_id: 'case-1',
    embedding_kind: 'case_text',
    source_entity: 'historical_case',
    source_reference: null,
    semantic_input_version: 'case-text-v1',
    content_hash: 'a'.repeat(64),
    provider: 'openai',
    embedding_model: VECTOR_EMBEDDING_MODEL,
    model_version: VECTOR_EMBEDDING_MODEL_VERSION,
    dimensions: VECTOR_EMBEDDING_DIMENSIONS,
    state: 'current',
    superseded_by: null,
    created_at: '2026-01-01T00:00:00Z',
    refreshed_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function generated(
  overrides: Partial<GeneratedCaseEmbedding> = {}
): GeneratedCaseEmbedding {
  return {
    kind: 'case_text',
    vector: Array.from({ length: VECTOR_EMBEDDING_DIMENSIONS }, () => 0.1),
    provider: 'openai',
    embedding_model: VECTOR_EMBEDDING_MODEL,
    model_version: VECTOR_EMBEDDING_MODEL_VERSION,
    dimensions: VECTOR_EMBEDDING_DIMENSIONS,
    content_hash: 'a'.repeat(64),
    semantic_input_version: 'case-text-v1',
    usage: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Account isolation
// ---------------------------------------------------------------------------

describe('storeCaseEmbedding — account isolation', () => {
  it('scopes every read and write to the account', async () => {
    const { db, state } = makeDb();
    await storeCaseEmbedding(db, {
      accountId: 'acct-1',
      historicalCaseId: 'case-1',
      kind: 'case_text',
      sourceEntity: 'historical_case',
      sourceReference: null,
      generated: generated(),
    });

    for (const query of state.queries) {
      expect(query.filters.account_id).toBe('acct-1');
    }
    expect(state.inserts[0]?.account_id).toBe('acct-1');
  });

  it('never reads another account\'s row', async () => {
    const { db, state } = makeDb({
      currentRow: storedRow({ account_id: 'acct-other' }),
    });
    const result = await storeCaseEmbedding(db, {
      accountId: 'acct-1',
      historicalCaseId: 'case-1',
      kind: 'case_text',
      sourceEntity: 'historical_case',
      sourceReference: null,
      generated: generated(),
    });

    // Its own row was written; the other account's row was neither
    // adopted nor modified.
    expect(result.created).toBe(true);
    expect(result.embedding.account_id).toBe('acct-1');
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0]?.account_id).toBe('acct-1');
    const other = state.rows.find((r) => r.account_id === 'acct-other');
    expect(other?.id).toBe('emb-1');
    expect(other?.state).toBe('current');
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('storeCaseEmbedding — idempotency', () => {
  it('is a no-op when the same content under the same model is stored twice', async () => {
    const { db, state } = makeDb();
    const first = await storeCaseEmbedding(db, {
      accountId: 'acct-1',
      historicalCaseId: 'case-1',
      kind: 'case_text',
      sourceEntity: 'historical_case',
      sourceReference: null,
      generated: generated(),
    });
    const second = await storeCaseEmbedding(db, {
      accountId: 'acct-1',
      historicalCaseId: 'case-1',
      kind: 'case_text',
      sourceEntity: 'historical_case',
      sourceReference: null,
      generated: generated(),
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.embedding.id).toBe(first.embedding.id);
    expect(state.rows).toHaveLength(1);
  });

  it('deduplicates on content hash rather than on "has a current row"', async () => {
    const { db, state } = makeDb({ currentRow: storedRow() });
    const result = await storeCaseEmbedding(db, {
      accountId: 'acct-1',
      historicalCaseId: 'case-1',
      kind: 'case_text',
      sourceEntity: 'historical_case',
      sourceReference: null,
      generated: generated(),
    });
    expect(result.created).toBe(false);
    expect(state.inserts).toHaveLength(0);
  });

  it('adopts the winning row when a concurrent insert wins the race', async () => {
    const { db } = makeDb();
    const winner = storedRow({ id: 'emb-winner' });
    const race = makeDb();
    // Pre-seed so the unique index fires.
    race.state.rows.push(winner);
    const result = await storeCaseEmbedding(race.db, {
      accountId: 'acct-1',
      historicalCaseId: 'case-1',
      kind: 'case_text',
      sourceEntity: 'historical_case',
      sourceReference: null,
      generated: generated(),
    });
    expect(result.embedding.id).toBe('emb-winner');
    expect(result.created).toBe(false);
    expect(db).toBeDefined();
  });

  it('stores the vector as a pgvector literal, not a JSON array', async () => {
    const { db, state } = makeDb();
    await storeCaseEmbedding(db, {
      accountId: 'acct-1',
      historicalCaseId: 'case-1',
      kind: 'case_text',
      sourceEntity: 'historical_case',
      sourceReference: null,
      generated: generated({ vector: [0.1, 0.2] }),
    });
    expect(state.inserts[0]?.vector).toBe('[0.1,0.2]');
  });

  it('records the full compatibility group on the row', async () => {
    const { db, state } = makeDb();
    await storeCaseEmbedding(db, {
      accountId: 'acct-1',
      historicalCaseId: 'case-1',
      kind: 'case_text',
      sourceEntity: 'historical_case',
      sourceReference: null,
      generated: generated(),
    });
    const row = state.inserts[0]!;
    expect(row.provider).toBe('openai');
    expect(row.embedding_model).toBe(VECTOR_EMBEDDING_MODEL);
    expect(row.model_version).toBe(VECTOR_EMBEDDING_MODEL_VERSION);
    expect(row.dimensions).toBe(VECTOR_EMBEDDING_DIMENSIONS);
    expect(row.content_hash).toBe('a'.repeat(64));
    expect(row.semantic_input_version).toBe('case-text-v1');
  });
});

// ---------------------------------------------------------------------------
// Model / version separation
// ---------------------------------------------------------------------------

describe('storeCaseEmbedding — model/version separation', () => {
  it('refuses to read back a vector from an unregistered model', async () => {
    // The registry is a migration, not a runtime setting, so a vector
    // from a model WACRM does not know cannot even be parsed back out of
    // the store. This is the guarantee that a future model cannot be
    // smuggled in through a partial deploy.
    const { db } = makeDb({
      currentRow: storedRow({
        embedding_model: 'text-embedding-3-small',
        model_version: 'text-embedding-3-small-1536-v2',
        dimensions: 1024,
      }),
    });
    await expect(
      findCaseEmbeddingByIdentity(db, {
        accountId: 'acct-1',
        historicalCaseId: 'case-1',
        kind: 'case_text',
        semanticInputVersion: 'case-text-v1',
        provider: 'openai',
        embeddingModel: VECTOR_EMBEDDING_MODEL,
        modelVersion: 'text-embedding-3-small-1536-v2',
        contentHash: 'a'.repeat(64),
      })
    ).rejects.toThrow(/unregistered model/i);
  });

  it('distinguishes model versions during identity lookup', async () => {
    const { db } = makeDb({ currentRow: storedRow() });
    // The stored row is `text-embedding-3-small-1536-v1`. A lookup for a
    // different model version must NOT find it, so a re-embedding run
    // under a new model cannot mistake an old vector for a new one.
    expect(
      await findCaseEmbeddingByIdentity(db, {
        accountId: 'acct-1',
        historicalCaseId: 'case-1',
        kind: 'case_text',
        semanticInputVersion: 'case-text-v1',
        provider: 'openai',
        embeddingModel: VECTOR_EMBEDDING_MODEL,
        modelVersion: 'text-embedding-3-small-1536-v2',
        contentHash: 'a'.repeat(64),
      })
    ).toBeNull();
  });

  it('treats a different semantic input version as different content', async () => {
    const { db, state } = makeDb({ currentRow: storedRow() });
    await storeCaseEmbedding(db, {
      accountId: 'acct-1',
      historicalCaseId: 'case-1',
      kind: 'case_text',
      sourceEntity: 'historical_case',
      sourceReference: null,
      generated: generated({ semantic_input_version: 'case-text-v2' }),
    });
    expect(state.inserts).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

describe('storeCaseEmbedding — withheld handling', () => {
  it('refuses to re-activate a withheld embedding', async () => {
    const { db } = makeDb({ currentRow: storedRow({ state: 'withheld' }) });
    await expect(
      storeCaseEmbedding(db, {
        accountId: 'acct-1',
        historicalCaseId: 'case-1',
        kind: 'case_text',
        sourceEntity: 'historical_case',
        sourceReference: null,
        generated: generated(),
      })
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('markEmbeddingStale', () => {
  it('marks stale without naming a successor', async () => {
    const { db, state } = makeDb({ currentRow: storedRow() });
    await markEmbeddingStale(db, { accountId: 'acct-1', embeddingId: 'emb-1' });
    expect(state.updates[0]?.patch).toEqual({
      state: 'stale',
      superseded_by: null,
    });
  });

  it('marks superseded and names the replacement', async () => {
    const { db, state } = makeDb({ currentRow: storedRow() });
    await markEmbeddingStale(db, {
      accountId: 'acct-1',
      embeddingId: 'emb-1',
      supersededBy: 'emb-2',
    });
    expect(state.updates[0]?.patch).toEqual({
      state: 'superseded',
      superseded_by: 'emb-2',
    });
  });

  it('never retires a withheld embedding', async () => {
    const { db, state } = makeDb({ currentRow: storedRow() });
    await markEmbeddingStale(db, { accountId: 'acct-1', embeddingId: 'emb-1' });
    // The `neq('state','withheld')` guard is what enforces this.
    const updateQuery = state.queries.find((q) =>
      Object.keys(q.filters).some((k) => k === 'ne:state')
    );
    expect(updateQuery?.filters['ne:state']).toBe('withheld');
  });
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

describe('loadCurrentEmbedding', () => {
  it('returns the current vector scoped to the account', async () => {
    const { db, state } = makeDb({ currentRow: storedRow() });
    const entry = await loadCurrentEmbedding(db, {
      accountId: 'acct-1',
      historicalCaseId: 'case-1',
      kind: 'case_text',
    });
    expect(entry?.embedding.id).toBe('emb-1');
    const embeddingQuery = state.queries[0];
    expect(embeddingQuery?.filters).toMatchObject({
      account_id: 'acct-1',
      historical_case_id: 'case-1',
      embedding_kind: 'case_text',
      state: 'current',
    });
  });

  it('returns null when the case has no current vector', async () => {
    const { db } = makeDb();
    expect(
      await loadCurrentEmbedding(db, {
        accountId: 'acct-1',
        historicalCaseId: 'case-1',
        kind: 'case_text',
      })
    ).toBeNull();
  });
});

describe('findCaseEmbeddingByIdentity', () => {
  it('matches on the full identity tuple', async () => {
    const { db, state } = makeDb({ currentRow: storedRow() });
    const found = await findCaseEmbeddingByIdentity(db, {
      accountId: 'acct-1',
      historicalCaseId: 'case-1',
      kind: 'case_text',
      semanticInputVersion: 'case-text-v1',
      provider: 'openai',
      embeddingModel: VECTOR_EMBEDDING_MODEL,
      modelVersion: VECTOR_EMBEDDING_MODEL_VERSION,
      contentHash: 'a'.repeat(64),
    });
    expect(found?.id).toBe('emb-1');
    expect(state.queries[0]?.filters).toMatchObject({
      content_hash: 'a'.repeat(64),
      model_version: VECTOR_EMBEDDING_MODEL_VERSION,
    });
  });
});

describe('listCurrentEmbeddings', () => {
  it('filters to current rows only', async () => {
    const { db, state } = makeDb({ currentRow: storedRow() });
    await listCurrentEmbeddings(db, {
      accountId: 'acct-1',
      historicalCaseId: 'case-1',
    });
    expect(state.queries[0]?.filters.state).toBe('current');
  });
});

describe('listEmbeddingEligibleCases', () => {
  it('excludes cases an operator excluded', async () => {
    const { db, state } = makeDb();
    await listEmbeddingEligibleCases(db, {
      accountId: 'acct-1',
      pageSize: 10,
      offset: 0,
    });
    expect(state.queries[0]?.filters).toMatchObject({
      account_id: 'acct-1',
      'ne:learning_eligibility': 'excluded',
    });
  });
});

describe('countEmbeddingCoverage', () => {
  it('counts by kind and state for operator reporting', async () => {
    const db = {
      from: () => ({
        select: () => ({
          eq: () => ({
            then: (resolve: (v: unknown) => unknown) =>
              Promise.resolve({
                data: [
                  { embedding_kind: 'case_text', state: 'current' },
                  { embedding_kind: 'case_text', state: 'current' },
                  { embedding_kind: 'case_text', state: 'stale' },
                  { embedding_kind: 'image_observation_text', state: 'current' },
                ],
                error: null,
              }).then(resolve),
          }),
        }),
      }),
    } as unknown as SupabaseClient;
    expect(
      await countEmbeddingCoverage(db, { accountId: 'acct-1' })
    ).toEqual({
      'case_text:current': 2,
      'case_text:stale': 1,
      'image_observation_text:current': 1,
    });
  });
});

describe('CaseEmbeddingRepositoryError', () => {
  it('carries a classified code', () => {
    expect(new CaseEmbeddingRepositoryError('conflict', 'x').code).toBe(
      'conflict'
    );
  });
});
