/**
 * A strict in-memory Supabase double for the image-observation tests.
 *
 * It reproduces the constraints migration 054 relies on — request-identity
 * uniqueness, one current run per media set, account scoping on every
 * query, the source-traceability guard, and observation immutability — so
 * a repository function that stops checking any of them fails here rather
 * than in production.
 *
 * The media guard is the important one to model faithfully. It re-derives
 * the object path from the message row's own `media_url`, exactly as the
 * `guard_image_analysis_run_image_write` trigger does, because "no
 * arbitrary URL/path supplied by the caller" is only a real guarantee if
 * something actually enforces it.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

type Row = Record<string, unknown>;

export interface RecordedCall {
  table: string;
  operation: 'select' | 'insert' | 'update' | 'delete';
  filters: Array<[string, unknown]>;
  /**
   * Exclusion filters, recorded separately from `filters` because they are
   * a different assertion: `eq` says which rows are wanted, `neq` says
   * which are excluded. Collapsing them would let a test pass against a
   * fake that silently ignored an exclusion the production query relies
   * on — which is exactly how a "withheld row must not be superseded"
   * guard could look covered while doing nothing.
   */
  notEquals: Array<[string, unknown]>;
  payload: Row | null;
}

export interface FakeImageObservationDb {
  client: SupabaseClient;
  calls: RecordedCall[];
  rows(table: string): Row[];
  /** Fail every read from `table`, to exercise the error paths. */
  failTable(table: string): void;
}

export interface FakeSeed {
  conversations?: Row[];
  messages?: Row[];
  /** Existing analysis rows, for adoption / idempotency tests. */
  runs?: Row[];
  runImages?: Row[];
  observations?: Row[];
  sources?: Row[];
}

const OBJECT_PREFIX = '/storage/v1/object/public/chat-media/';

function objectPathFrom(mediaUrl: unknown): string | null {
  if (typeof mediaUrl !== 'string' || !mediaUrl.startsWith('https://')) {
    return null;
  }
  const index = mediaUrl.indexOf(OBJECT_PREFIX);
  if (index === -1) return null;
  return mediaUrl.slice(index + OBJECT_PREFIX.length);
}

export function makeFakeObservationDb(seed: FakeSeed = {}): FakeImageObservationDb {
  const tables: Record<string, Row[]> = {
    conversations: seed.conversations ? [...seed.conversations] : [],
    messages: seed.messages ? [...seed.messages] : [],
    image_analysis_runs: seed.runs ? [...seed.runs] : [],
    image_analysis_run_images: seed.runImages ? [...seed.runImages] : [],
    image_analysis_observations: seed.observations ? [...seed.observations] : [],
    image_analysis_observation_sources: seed.sources ? [...seed.sources] : [],
  };
  const failing = new Set<string>();
  const calls: RecordedCall[] = [];
  let idCounter = 0;

  const nextId = (prefix: string): string => `${prefix}-${++idCounter}`;

  const client = {
    from(table: string) {
      const call: RecordedCall = {
        table,
        operation: 'select',
        filters: [],
        notEquals: [],
        payload: null,
      };
      calls.push(call);
      let insertPayload: Row | Row[] | null = null;
      let updatePatch: Row | null = null;

      const rows = (): Row[] => tables[table] ?? [];

      const matches = (row: Row): boolean =>
        call.filters.every(([column, value]) => {
          if (Array.isArray(value)) return value.includes(row[column]);
          return row[column] === value;
        }) &&
        call.notEquals.every(([column, value]) => row[column] !== value);

      const selectRows = (): Row[] => rows().filter(matches);

      const execute = (): { data: unknown; error: unknown } => {
        if (failing.has(table)) {
          return { data: null, error: { message: 'boom', code: 'XX000' } };
        }
        if (call.operation === 'select') {
          return { data: selectRows(), error: null };
        }
        if (call.operation === 'update') {
          // The patched rows must actually be WRITTEN BACK. Returning
          // patched copies while leaving the table untouched would make
          // every update assertion pass against a fake that silently
          // discards the mutation — so a later read would still see the
          // old value and the lifecycle tests would prove nothing.
          const current = rows();
          const updated: Row[] = [];
          for (let index = 0; index < current.length; index += 1) {
            const row = current[index] as Row;
            if (!matches(row)) continue;
            const patched = { ...row, ...(updatePatch as Row) };
            current[index] = patched;
            updated.push(patched);
          }
          return { data: updated, error: null };
        }
        if (call.operation === 'delete') {
          const doomed = rows().filter(matches);
          tables[table] = rows().filter((row) => !matches(row));
          for (const row of doomed) {
            cascadeDelete(tables, table, row);
          }
          return { data: doomed.length, error: null };
        }

        // INSERT
        const payloads = (
          Array.isArray(insertPayload) ? insertPayload : [insertPayload]
        ) as Row[];
        const inserted: Row[] = [];
        for (const payload of payloads) {
          const failure = guardWrite(table, payload, tables);
          if (failure) return { data: null, error: { code: failure } };
          const now = '2026-07-01T00:00:00.000Z';
          const idKey = `${table.replace('image_analysis_', 'ia_')}-id`;
          const row: Row = {
            id: payload.id ?? nextId(idKey),
            created_at: now,
            ...tableDefaults(table),
            ...payload,
          };
          rows().push(row);
          inserted.push(row);
        }
        return { data: inserted, error: null };
      };

      const chain = {
        select() {
          return chain;
        },
        insert(payload: Row | Row[]) {
          call.operation = 'insert';
          insertPayload = payload;
          // Recorded on the call as well, so a test can assert what a
          // write carried. An insert has no `eq` filter to inspect, so
          // without this a scoping assertion over inserts would have
          // nothing to look at.
          call.payload = Array.isArray(payload) ? payload[0] ?? null : payload;
          return chain;
        },
        update(patch: Row) {
          call.operation = 'update';
          updatePatch = patch;
          call.payload = patch;
          return chain;
        },
        delete() {
          call.operation = 'delete';
          return chain;
        },
        eq(column: string, value: unknown) {
          call.filters.push([column, value]);
          return chain;
        },
        in(column: string, values: readonly unknown[]) {
          call.filters.push([column, [...values]]);
          return chain;
        },
        neq(column: string, value: unknown) {
          call.notEquals.push([column, value]);
          return chain;
        },
        order() {
          return chain;
        },
        limit() {
          return chain;
        },
        maybeSingle() {
          return Promise.resolve(first(execute()));
        },
        single() {
          return Promise.resolve(first(execute()));
        },
        then(
          onFulfilled: (value: unknown) => unknown,
          onRejected?: (reason: unknown) => unknown
        ) {
          return Promise.resolve(execute()).then(onFulfilled, onRejected);
        },
      };
      return chain;
    },
  } as unknown as SupabaseClient;

  return {
    client,
    calls,
    rows: (table) => (tables[table] ?? []).map((row) => ({ ...row })),
    failTable: (table) => {
      failing.add(table);
    },
  };
}

/**
 * The `ON DELETE CASCADE` chain, reproduced.
 *
 * Removing a run removes its images, which removes their observation
 * sources, which — through `prune_image_analysis_orphans` — removes any
 * observation left with no surviving photograph. Modelling it here is
 * what makes the rollback tests and the privacy tests mean something:
 * a fake that ignored cascades would let a test pass while production
 * left derived memory behind.
 */
function cascadeDelete(
  tables: Record<string, Row[]>,
  table: string,
  row: Row
): void {
  const drop = (name: string, predicate: (candidate: Row) => boolean): void => {
    const current = tables[name] ?? [];
    const keep = current.filter((candidate) => !predicate(candidate));
    for (const removed of current.filter(predicate)) {
      cascadeDelete(tables, name, removed);
    }
    tables[name] = keep;
  };

  if (table === 'image_analysis_runs') {
    drop('image_analysis_run_images', (image) => image.run_id === row.id);
    return;
  }
  if (table === 'image_analysis_run_images') {
    drop('image_analysis_observation_sources', (source) => source.run_image_id === row.id);
    drop('image_analysis_observations', (observation) =>
      !currentLinks(tables).some((source) => source.observation_id === observation.id)
    );
    return;
  }
  if (table === 'image_analysis_observation_sources') {
    drop('image_analysis_observations', (observation) =>
      observation.id === row.observation_id &&
      !currentLinks(tables).some((source) => source.observation_id === observation.id)
    );
    drop('image_analysis_runs', (run) =>
      run.status === 'succeeded' &&
      run.id === owningRunId(tables, row.observation_id) &&
      !(tables.image_analysis_observations ?? []).some(
        (observation) => observation.run_id === run.id
      )
    );
  }
}

function currentLinks(tables: Record<string, Row[]>): Row[] {
  return tables.image_analysis_observation_sources ?? [];
}

/**
 * The run an orphaned observation belonged to.
 *
 * Read through the observation row itself rather than the (already
 * removed) source link, which is why the observation table is consulted
 * before the row is dropped. Returns `null` when the observation is
 * already gone, in which case there is no run to prune.
 */
function owningRunId(tables: Record<string, Row[]>, observationId: unknown): string | null {
  const observation = (tables.image_analysis_observations ?? []).find(
    (row) => row.id === observationId
  );
  return observation ? String(observation.run_id) : null;
}

/**
 * Reproduce the migration's write guards.
 *
 * Returns a Postgres error code when the write must be refused, so a test
 * can assert that a repository function turned a guard failure into the
 * right DOMAIN error rather than swallowing it.
 */
function guardWrite(
  table: string,
  payload: Row,
  tables: Record<string, Row[]>
): string | null {
  if (table === 'image_analysis_runs') {
    // Tenant scope: the conversation must belong to the account. The
    // composite foreign key in migration 054 proves this on a real
    // database; here it is modelled so a repository function that stopped
    // checking ownership fails in a test rather than in production.
    const conversation = (tables.conversations ?? []).find(
      (row) =>
        row.id === payload.conversation_id && row.account_id === payload.account_id
    );
    if (!conversation) return '23503';

    // Both uniqueness indexes are PARTIAL on a non-null fingerprint, so a
    // failure row - which has no request identity to speak of - does not
    // conflict with anything. Modelling that matters: without it, two
    // unrelated failures would look like a duplicate request and a
    // failure-lifecycle test would pass for the wrong reason.
    if (payload.source_fingerprint === null ||
        payload.source_fingerprint === undefined) {
      return null;
    }

    const identity = [
      'account_id',
      'conversation_id',
      'source_fingerprint',
      'analyzer_id',
      'provider',
      'model',
      'analysis_schema_version',
      'prompt_version',
    ];
    const duplicate = (tables.image_analysis_runs ?? []).some((row) =>
      identity.every((key) => row[key] === payload[key])
    );
    if (duplicate) return '23505';

    if (payload.state === 'current') {
      const conflicting = (tables.image_analysis_runs ?? []).some(
        (row) =>
          row.account_id === payload.account_id &&
          row.conversation_id === payload.conversation_id &&
          row.source_fingerprint === payload.source_fingerprint &&
          row.state === 'current'
      );
      if (conflicting) return '23505';
    }
    return null;
  }

  if (table === 'image_analysis_run_images') {
    // Traceability: the message must exist, belong to the account's
    // conversation, be part of the run's conversation, and its own
    // media_url must resolve to the recorded object path.
    const message = (tables.messages ?? []).find(
      (row) => row.id === payload.source_message_id
    );
    if (!message) return '23503';
    const conversation = (tables.conversations ?? []).find(
      (row) =>
        row.id === message.conversation_id && row.account_id === payload.account_id
    );
    if (!conversation) return '23503';
    const run = (tables.image_analysis_runs ?? []).find(
      (row) => row.id === payload.run_id && row.account_id === payload.account_id
    );
    if (!run) return '23503';
    if (run.conversation_id !== message.conversation_id) return '23514';
    const derived = objectPathFrom(message.media_url);
    if (derived === null) return '23514';
    if (derived !== payload.source_media_id) return '23514';
    return null;
  }

  if (table === 'image_analysis_observations') {
    const run = (tables.image_analysis_runs ?? []).find(
      (row) => row.id === payload.run_id && row.account_id === payload.account_id
    );
    if (!run) return '23503';
    if (run.status !== 'succeeded') return '23514';
    return null;
  }

  if (table === 'image_analysis_observation_sources') {
    const observation = (tables.image_analysis_observations ?? []).find(
      (row) => row.id === payload.observation_id
    );
    if (!observation) return '23503';
    const image = (tables.image_analysis_run_images ?? []).find(
      (row) => row.id === payload.run_image_id
    );
    if (!image) return '23503';
    if (image.run_id !== observation.run_id) return '23514';
    if (image.ordinal !== payload.source_ordinal) return '23514';
    return null;
  }

  return null;
}

function tableDefaults(table: string): Row {
  if (table === 'image_analysis_runs') {
    return {
      state: 'current',
      superseded_by: null,
      updated_at: '2026-07-01T00:00:00.000Z',
    };
  }
  return {};
}

function first(result: { data: unknown; error: unknown }): {
  data: unknown;
  error: unknown;
} {
  if (result.error) return result;
  const rows = (result.data as unknown[]) ?? [];
  return { data: rows[0] ?? null, error: null };
}