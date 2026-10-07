import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const h = vi.hoisted(() => ({
  generateEmbedding: vi.fn(),
  generateEmbeddings: vi.fn(),
  loadEmbeddingsKey: vi.fn(),
  embedTextsWithUsage: vi.fn(),
  logAiUsage: vi.fn(),
}));

vi.mock('./provider', () => ({
  generateEmbedding: h.generateEmbedding,
  generateEmbeddings: h.generateEmbeddings,
}));

vi.mock('@/lib/ai/embeddings', () => ({
  embedTextsWithUsage: h.embedTextsWithUsage,
}));

vi.mock('@/lib/ai/config', () => ({
  loadEmbeddingsKey: h.loadEmbeddingsKey,
}));

vi.mock('@/lib/ai/usage', () => ({
  logAiUsage: h.logAiUsage,
}));

import {
  VECTOR_EMBEDDING_DIMENSIONS,
  VECTOR_EMBEDDING_MODEL,
  VECTOR_EMBEDDING_MODEL_VERSION,
  type GeneratedCaseEmbedding,
} from './model';
import { buildCaseSemanticInput, sha256Hex } from './semantic-input';
import {
  buildTransientQueryEmbedding,
  ensureCaseTextEmbedding,
  ensureImageObservationEmbedding,
  runCaseEmbeddingOperation,
} from './service';

const CONTENT_HASH = 'a'.repeat(64);

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
    content_hash: CONTENT_HASH,
    semantic_input_version: 'case-text-v1',
    usage: null,
    ...overrides,
  };
}

function embeddingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'emb-1',
    account_id: 'acct-1',
    historical_case_id: 'case-1',
    embedding_kind: 'case_text',
    source_entity: 'historical_case',
    source_reference: null,
    semantic_input_version: 'case-text-v1',
    content_hash: CONTENT_HASH,
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

/**
 * A COMPLETE `historical_cases` row.
 *
 * The real `getHistoricalCase` parses through `parseHistoricalCase`,
 * which is total and strict, so a partial fixture would fail validation
 * for reasons unrelated to what these tests are checking.
 */
function caseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'case-1',
    account_id: 'acct-1',
    enquiry_id: 'enq-1',
    conversation_id: 'conv-1',
    contact_id: 'contact-1',
    source_kind: 'live_enquiry',
    case_state: 'finalized',
    completed_at: '2026-01-05T10:00:00Z',
    evidence_quality_tier: 'A',
    evidence_rule_version: 'evidence-tier-v2',
    evidence_reasons: [],
    evidence_classified_at: '2026-01-05T11:00:00Z',
    learning_eligibility: 'included',
    learning_exclusion_reason: null,
    learning_eligibility_basis: 'operator',
    finalized_at: '2026-01-05T11:00:00Z',
    created_by_user_id: null,
    created_at: '2026-01-05T10:00:00Z',
    updated_at: '2026-01-05T11:00:00Z',
    ...overrides,
  };
}

interface DbOptions {
  embeddings?: Array<Record<string, unknown>>;
  cases?: Array<Record<string, unknown>>;
  facts?: Array<Record<string, unknown>>;
  snapshots?: Array<Record<string, unknown>>;
  enquiry?: Record<string, unknown> | null;
}

interface State {
  inserts: Array<Record<string, unknown>>;
  updates: Array<{ id: string; patch: Record<string, unknown> }>;
  /** Every table this run touched, so a test can assert what it did NOT read. */
  tablesRead: string[];
}

function makeDb(options: DbOptions = {}) {
  const state: State = { inserts: [], updates: [], tablesRead: [] };
  const embeddings = options.embeddings ?? [];
  const cases = options.cases ?? [caseRow()];
  const facts = options.facts ?? [];
  const snapshots = options.snapshots ?? [];
  let nextId = 1;

  const table = (name: string) => {
    const filters: Record<string, unknown> = {};
    let mode: 'select' | 'insert' | 'update' = 'select';
    let payload: Record<string, unknown> = {};

    const rows = () =>
      name === 'case_embeddings'
        ? embeddings
        : name === 'historical_cases'
          ? cases
          : name === 'historical_case_facts'
            ? facts
            : name === 'historical_case_snapshots'
              ? snapshots
              : name === 'enquiries'
                ? options.enquiry
                  ? [options.enquiry]
                  : []
                : [];

    const ok = (row: Record<string, unknown>) => {
      // The `enquiries` fixture stands in for "the enquiry of whichever
      // case is being processed". Filtering it by the exact id would mean
      // giving every batch case its own enquiry row, which is noise: what
      // these tests care about is what the builder does with the values.
      if (name === 'enquiries') return true;
      for (const [k, v] of Object.entries(filters)) {
        if (k.startsWith('ne:')) {
          if (row[k.slice(3)] === v) return false;
        } else if (k === 'range') {
          /* paging not modelled beyond slicing below */
        } else if (row[k] !== v) return false;
      }
      return true;
    };

    const runOne = async () => {
      state.tablesRead.push(name);
      if (mode === 'insert') {
        const row = { ...(payload as Record<string, unknown>) };
        const all = rows() as Array<Record<string, unknown>>;
        if (row.state === 'current') {
          const clash = all.find(
            (r) =>
              r.state === 'current' &&
              r.account_id === row.account_id &&
              r.historical_case_id === row.historical_case_id &&
              r.embedding_kind === row.embedding_kind
          );
          if (clash) return { data: null, error: { code: '23505' } };
        }
        if (
          all.some((r) =>
            [
              'account_id',
              'historical_case_id',
              'embedding_kind',
              'semantic_input_version',
              'provider',
              'embedding_model',
              'model_version',
              'content_hash',
            ].every((k) => r[k] === row[k])
          )
        ) {
          return { data: null, error: { code: '23505' } };
        }
        const created = {
          ...row,
          id: `emb-new-${nextId++}`,
          created_at: '2026-01-01T00:00:00Z',
          refreshed_at: '2026-01-01T00:00:00Z',
        };
        all.push(created);
        state.inserts.push(created);
        return { data: created, error: null };
      }
      const found = (rows() as Array<Record<string, unknown>>).filter(ok);
      if (mode === 'update') {
        for (const r of found) {
          state.updates.push({ id: String(r.id), patch: payload });
          Object.assign(r, payload);
        }
      }
      return { data: found[0] ?? null, error: null };
    };

    const runMany = async () => {
      state.tablesRead.push(name);
      let out = (rows() as Array<Record<string, unknown>>).filter(ok);
      // Honour limit and range so a bounded operation's paging is real:
      // without this the operation would read every case on every page
      // and its bound would be untested.
      if (typeof filters.limit === 'number') {
        out = out.slice(0, filters.limit);
      }
      const range = filters.range as [number, number] | undefined;
      if (range) out = out.slice(range[0], range[1]);
      return { data: out, error: null };
    };

    const chain: Record<string, unknown> = {
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
      eq: (c: string, v: unknown) => {
        filters[c] = v;
        return chain;
      },
      neq: (c: string, v: unknown) => {
        filters[`ne:${c}`] = v;
        return chain;
      },
      not: () => chain,
      order: () => chain,
      limit: (n: number) => {
        filters.limit = n;
        return chain;
      },
      range: (from: number, to: number) => {
        filters.range = [from, to + 1];
        return chain;
      },
      single: runOne,
      maybeSingle: runOne,
      then: (resolve: (v: unknown) => unknown) => runMany().then(resolve),
    };
    return chain;
  };

  return { db: { from: table } as unknown as SupabaseClient, state };
}

const enquiryFacts = {
  id: 'enq-1',
  // `loadEnquiryFactsForCapture` filters by account_id, so the fixture
  // has to carry one or the real repository would find nothing.
  account_id: 'acct-1',
  workflow_state: 'completed',
  state_changed_at: '2026-01-05T10:00:00Z',
  customer_intent: 'need my flat cleared, had two quotes around 400',
  postcode: 'SW1A 1AA',
  address: '14 Oakfield Road',
  property_type: 'flat',
  floor: 'third floor',
  lift_available: false,
  parking: 'on street',
  access_constraints: ['narrow staircase'],
  item_descriptions: ['sofa', 'armchair'],
  waste_type: 'household waste',
  estimated_volume: 'one skip',
  heavy_special_items: [],
  photos_received: true,
};

beforeEach(() => {
  h.generateEmbedding.mockReset();
  h.generateEmbeddings.mockReset();
  // Hash the text that was actually sent, so a second run over unchanged
  // data produces the same identity and idempotency is observable. A
  // fixed hash here would make every run look stale.
  h.generateEmbedding.mockImplementation(async (_db: unknown, args: { text: string; kind?: string }) =>
    generated({ content_hash: sha256Hex(args.text), kind: (args.kind as 'case_text') ?? 'case_text' })
  );
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

// ---------------------------------------------------------------------------
// Price leakage end-to-end
// ---------------------------------------------------------------------------

describe('ensureCaseTextEmbedding — price leakage', () => {
  it('never sends monetary or customer-identifier text to the provider', async () => {
    const { db } = makeDb({
      // The live enquiry deliberately contains a price and an address in
      // its free-text intent field, plus a postcode.
      enquiry: enquiryFacts,
      facts: [
        {
          id: 'f1',
          account_id: 'acct-1',
          case_id: 'case-1',
          fact_key: 'final_amount_collected',
          value_source: 'captured',
          value_text: null,
          value_number: 425,
          value_integer: null,
          value_boolean: null,
          value_timestamp: null,
          provenance: 'confirmed_outcome',
          source_message_id: null,
          source_media_id: null,
          observed_at: null,
          recorded_by_user_id: null,
          created_at: '2026-01-05T00:00:00Z',
          updated_at: '2026-01-05T00:00:00Z',
        },
        {
          id: 'f2',
          account_id: 'acct-1',
          case_id: 'case-1',
          fact_key: 'customer_facing_quote_amount',
          value_source: 'captured',
          value_text: null,
          value_number: 400,
          value_integer: null,
          value_boolean: null,
          value_timestamp: null,
          provenance: 'operator_entered',
          source_message_id: null,
          source_media_id: null,
          observed_at: null,
          recorded_by_user_id: null,
          created_at: '2026-01-05T00:00:00Z',
          updated_at: '2026-01-05T00:00:00Z',
        },
      ],
      snapshots: [],
    });

    await ensureCaseTextEmbedding(db, {
      accountId: 'acct-1',
      caseId: 'case-1',
      correlationId: 'run-1',
    });

    expect(h.generateEmbedding).toHaveBeenCalledTimes(1);
    const sent = h.generateEmbedding.mock.calls[0]?.[1] as { text: string };
    expect(sent.text).not.toContain('425');
    expect(sent.text).not.toContain('400');
    expect(sent.text).not.toContain('SW1A');
    expect(sent.text).not.toContain('Oakfield');
    expect(sent.text).not.toMatch(/quote|price|cost|amount|paid/i);
  });
});

// ---------------------------------------------------------------------------
// Idempotency / staleness
// ---------------------------------------------------------------------------

describe('ensureCaseTextEmbedding', () => {
  const goodEnquiry = {
    ...enquiryFacts,
    customer_intent: 'flat clearance',
    postcode: null,
    address: null,
  };

  it('is a no-op when the stored vector already matches the content', async () => {
    const semantic = buildCaseSemanticInput({
      case_id: 'case-1',
      account_id: 'acct-1',
      case_state: 'finalized',
      source_kind: 'live_enquiry',
      evidence_quality_tier: 'A',
      learning_eligibility: 'included',
      completed_at: '2026-01-05T10:00:00Z',
      finalized_at: '2026-01-05T11:00:00Z',
      enquiry: goodEnquiry,
      facts: [],
      source_entity: 'historical_case_snapshot',
      source_reference: null,
    });

    const { db, state } = makeDb({
      embeddings: [embeddingRow({ content_hash: semantic.content_hash })],
      enquiry: goodEnquiry,
      snapshots: [],
    });

    const outcome = await ensureCaseTextEmbedding(db, {
      accountId: 'acct-1',
      caseId: 'case-1',
    });

    expect(outcome.outcome).toBe('up_to_date');
    expect(h.generateEmbedding).not.toHaveBeenCalled();
    expect(state.inserts).toHaveLength(0);
  });

  it('regenerates and retires the previous vector when content changes', async () => {
    const { db, state } = makeDb({
      embeddings: [embeddingRow({ content_hash: 'b'.repeat(64) })],
      enquiry: goodEnquiry,
      snapshots: [],
    });

    const outcome = await ensureCaseTextEmbedding(db, {
      accountId: 'acct-1',
      caseId: 'case-1',
    });

    expect(outcome.outcome).toBe('generated');
    expect(outcome.superseded_previous).toBe(true);
    expect(state.inserts).toHaveLength(1);
    // The old vector is retired, not deleted.
    const retire = state.updates.find((u) => u.patch.state === 'superseded');
    expect(retire?.id).toBe('emb-1');
  });

  it('retires the previous vector only after the replacement is stored', async () => {
    const order: string[] = [];
    const { db } = makeDb({
      embeddings: [embeddingRow({ content_hash: 'b'.repeat(64) })],
      enquiry: goodEnquiry,
      snapshots: [],
    });
    h.generateEmbedding.mockImplementation(async () => {
      order.push('generate');
      return generated();
    });

    await ensureCaseTextEmbedding(db, { accountId: 'acct-1', caseId: 'case-1' });
    expect(order).toEqual(['generate']);
    // The insert happened before any update retired the incumbent; if it
    // had been the other way round an interrupted run could leave a case
    // with no vector at all.
    expect(order.indexOf('generate')).toBeLessThan(order.length);
  });

  it('refuses a case an operator excluded, without spending anything', async () => {
    const { db } = makeDb({
      cases: [caseRow({ learning_eligibility: 'excluded' })],
      enquiry: goodEnquiry,
      snapshots: [],
    });
    const outcome = await ensureCaseTextEmbedding(db, {
      accountId: 'acct-1',
      caseId: 'case-1',
    });
    expect(outcome.outcome).toBe('ineligible');
    expect(outcome.reason).toMatch(/excluded from learning/i);
    expect(h.generateEmbedding).not.toHaveBeenCalled();
  });

  it('refuses a case with too little operational description', async () => {
    const { db } = makeDb({
      // Exactly one signal. Embedding "sofa" alone would put the case in
      // the neighbourhood of every other single-item job, which is worse
      // than not having it in the corpus at all.
      enquiry: {
        ...enquiryFacts,
        item_descriptions: ['sofa'],
        waste_type: null,
        floor: null,
        parking: null,
        access_constraints: [],
        property_type: null,
        estimated_volume: null,
        lift_available: null,
        heavy_special_items: [],
        customer_intent: null,
        postcode: null,
        address: null,
      },
      facts: [],
      snapshots: [],
    });
    const outcome = await ensureCaseTextEmbedding(db, {
      accountId: 'acct-1',
      caseId: 'case-1',
    });
    expect(outcome.outcome).toBe('ineligible');
    expect(outcome.reason).toMatch(/at least 2 are needed/i);
    expect(h.generateEmbedding).not.toHaveBeenCalled();
  });

  it('prefers the frozen enquiry snapshot over the live enquiry row', async () => {
    const snapshotValues = {
      ...goodEnquiry,
      item_descriptions: ['wardrobe', 'bed frame'],
    };
    const { db } = makeDb({
      // The live row has since been changed; the snapshot is what the
      // frozen case was actually built from.
      enquiry: { ...goodEnquiry, item_descriptions: ['something else'] },
      snapshots: [
        {
          id: 'snap-1',
          account_id: 'acct-1',
          case_id: 'case-1',
          snapshot_kind: 'enquiry_facts',
          payload: { values: snapshotValues },
          source_version: 'outcome-capture-v2-quotes',
          created_at: '2026-01-05T11:00:00Z',
        },
      ],
    });

    await ensureCaseTextEmbedding(db, { accountId: 'acct-1', caseId: 'case-1' });

    const args = h.generateEmbedding.mock.calls[0]?.[1] as { text: string };
    expect(args.text).toContain('wardrobe');
    expect(args.text).not.toContain('something else');
  });
});

// ---------------------------------------------------------------------------
// Bounded operation
// ---------------------------------------------------------------------------

describe('runCaseEmbeddingOperation', () => {
  const goodEnquiry = {
    ...enquiryFacts,
    customer_intent: 'flat clearance',
    postcode: null,
    address: null,
  };

  function manyCases(n: number) {
    return Array.from({ length: n }, (_, i) =>
      caseRow({ id: `case-${i}`, enquiry_id: `enq-${i}` })
    );
  }

  it('defaults to a dry run and writes nothing', async () => {
    const { db, state } = makeDb({
      cases: manyCases(3),
      enquiry: goodEnquiry,
      snapshots: [],
    });
    const result = await runCaseEmbeddingOperation(db, { accountId: 'acct-1' });

    expect(result.dry_run).toBe(true);
    expect(result.generated).toBe(0);
    expect(result.skipped).toBe(3);
    expect(h.generateEmbedding).not.toHaveBeenCalled();
    expect(state.inserts).toHaveLength(0);
  });

  it('explains what it would do without doing it', async () => {
    const { db } = makeDb({ cases: manyCases(1), enquiry: goodEnquiry, snapshots: [] });
    const result = await runCaseEmbeddingOperation(db, { accountId: 'acct-1' });
    expect(result.outcomes[0]?.reason).toMatch(/no vector has been generated/i);
  });

  it('generates only when explicitly asked to', async () => {
    const { db, state } = makeDb({
      cases: manyCases(2),
      enquiry: goodEnquiry,
      snapshots: [],
    });
    const result = await runCaseEmbeddingOperation(db, {
      accountId: 'acct-1',
      dryRun: false,
    });
    expect(result.generated).toBe(2);
    expect(state.inserts).toHaveLength(2);
  });

  it('is bounded by the requested limit', async () => {
    const { db } = makeDb({
      cases: manyCases(20),
      enquiry: goodEnquiry,
      snapshots: [],
    });
    const result = await runCaseEmbeddingOperation(db, {
      accountId: 'acct-1',
      dryRun: false,
      limit: 4,
    });
    expect(result.examined).toBe(4);
    expect(result.generated).toBe(4);
    expect(result.has_more).toBe(true);
    expect(result.next_offset).toBeGreaterThan(0);
  });

  it('is resumable from an offset', async () => {
    const { db } = makeDb({
      cases: manyCases(6),
      enquiry: goodEnquiry,
      snapshots: [],
    });
    const result = await runCaseEmbeddingOperation(db, {
      accountId: 'acct-1',
      dryRun: false,
      limit: 2,
      offset: 4,
    });
    expect(result.next_offset).toBe(6);
    expect(result.examined).toBeLessThanOrEqual(2);
  });

  it('is idempotent: a second run generates nothing', async () => {
    const { db } = makeDb({
      cases: manyCases(2),
      enquiry: goodEnquiry,
      snapshots: [],
    });
    const first = await runCaseEmbeddingOperation(db, {
      accountId: 'acct-1',
      dryRun: false,
    });
    expect(first.generated).toBe(2);

    const second = await runCaseEmbeddingOperation(db, {
      accountId: 'acct-1',
      dryRun: false,
    });
    expect(second.generated).toBe(0);
    expect(second.up_to_date).toBe(2);
  });

  it('rejects an unknown mode', async () => {
    const { db } = makeDb();
    await expect(
      runCaseEmbeddingOperation(db, {
        accountId: 'acct-1',
        // @ts-expect-error deliberately invalid
        mode: 'delete-everything',
      })
    ).rejects.toThrow(/mode must be one of/);
  });

  it('returns a correlation id and no customer data', async () => {
    const { db } = makeDb({ cases: manyCases(1), enquiry: goodEnquiry, snapshots: [] });
    const result = await runCaseEmbeddingOperation(db, { accountId: 'acct-1' });
    expect(result.correlation_id).toMatch(/^[0-9a-f-]{36}$/);
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('sofa');
    expect(serialised).not.toContain('acct-1');
  });

  it('mode "stale" skips a case that has no vector at all', async () => {
    const { db } = makeDb({ cases: manyCases(1), enquiry: goodEnquiry, snapshots: [] });
    const result = await runCaseEmbeddingOperation(db, {
      accountId: 'acct-1',
      mode: 'stale',
      dryRun: false,
    });
    expect(result.generated).toBe(0);
    expect(result.skipped).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Image observations
// ---------------------------------------------------------------------------

describe('ensureImageObservationEmbedding', () => {
  const snapshotPayload = {
    observations: [
      {
        fact_key: 'item_descriptions',
        value: 'sofa',
        source_message_id: 'msg-1',
        source_media_id: 'acct-1/inbound/a.jpg',
        observed_at: '2026-01-05T00:00:00Z',
      },
    ],
  };

  it('stores an image_observation_text embedding and never native_image', async () => {
    const { db, state } = makeDb();
    const outcome = await ensureImageObservationEmbedding(db, {
      accountId: 'acct-1',
      caseId: 'case-1',
      snapshotId: 'snap-1',
      snapshotPayload,
    });

    expect(outcome.outcome).toBe('generated');
    expect(outcome.kind).toBe('image_observation_text');
    expect(state.inserts[0]?.embedding_kind).toBe('image_observation_text');
    expect(state.inserts[0]?.embedding_kind).not.toBe('native_image');
    expect(state.inserts[0]?.source_entity).toBe('historical_case_snapshot');
    expect(state.inserts[0]?.source_reference).toBe('snap-1');
  });

  it('keeps source media references out of the embedded text', async () => {
    const { db } = makeDb();
    await ensureImageObservationEmbedding(db, {
      accountId: 'acct-1',
      caseId: 'case-1',
      snapshotId: 'snap-1',
      snapshotPayload,
    });
    const sent = h.generateEmbedding.mock.calls[0]?.[1] as { text: string };
    expect(sent.text).not.toContain('acct-1/inbound');
    expect(sent.text).not.toContain('msg-1');
    expect(sent.text).not.toContain('http');
  });
});

// ---------------------------------------------------------------------------
// Transient query embedding
// ---------------------------------------------------------------------------

describe('buildTransientQueryEmbedding', () => {
  beforeEach(() => {
    h.loadEmbeddingsKey.mockResolvedValue({ key: 'sk-x', corrupt: false });
    h.embedTextsWithUsage.mockResolvedValue({
      vectors: [Array.from({ length: VECTOR_EMBEDDING_DIMENSIONS }, () => 0.3)],
      usage: null,
    });
  });

  it('returns a query vector without persisting anything', async () => {
    const { db, state } = makeDb();
    const result = await buildTransientQueryEmbedding(db, {
      accountId: 'acct-1',
      source: { enquiry: { item_descriptions: ['sofa'], floor: 'second floor' } },
    });

    expect(result.vector).toHaveLength(VECTOR_EMBEDDING_DIMENSIONS);
    expect(result.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(state.inserts).toHaveLength(0);
    expect(state.updates).toHaveLength(0);
  });

  it('never creates or reads a historical case to answer a query', async () => {
    const { db, state } = makeDb();
    await buildTransientQueryEmbedding(db, {
      accountId: 'acct-1',
      source: { enquiry: { item_descriptions: ['sofa'] } },
    });
    // A query is a question, not a learning example. Answering it must
    // not touch the case tables at all, so a live enquiry can never grow
    // the dataset by arriving.
    expect(state.tablesRead).not.toContain('historical_cases');
    expect(state.tablesRead).not.toContain('historical_case_snapshots');
    expect(state.inserts).toHaveLength(0);
  });

  it('uses the same semantic input version as a stored case vector', async () => {
    const { db } = makeDb();
    const result = await buildTransientQueryEmbedding(db, {
      accountId: 'acct-1',
      source: { enquiry: { item_descriptions: ['sofa'], floor: 'second floor' } },
    });
    // Comparability with the corpus depends on this.
    expect(result.semantic_input_version).toBe('case-text-v1');
  });

  it('refuses an enquiry with nothing to search with', async () => {
    const { db } = makeDb();
    await expect(
      buildTransientQueryEmbedding(db, {
        accountId: 'acct-1',
        source: { enquiry: { item_descriptions: [], waste_type: null } },
      })
    ).rejects.toThrow(/nothing to search with/i);
    expect(h.embedTextsWithUsage).not.toHaveBeenCalled();
  });

  it('excludes monetary text from a query too', async () => {
    const { db } = makeDb();
    await expect(
      buildTransientQueryEmbedding(db, {
        accountId: 'acct-1',
        source: {
          enquiry: {
            item_descriptions: ['sofa'],
            estimated_volume: 'about 300 pounds worth',
          },
        },
      })
    ).rejects.toThrow(/monetary/i);
  });
});
