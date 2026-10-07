/**
 * Service tests for canonical image-observation persistence, and the
 * read-tool integrity assertions that go with them.
 *
 * Two things are being proved here, and the second matters as much as
 * the first:
 *
 *   1. An EXPLICIT call persists a validated analysis correctly.
 *   2. `analyze_images` itself persists NOTHING, and stays a read tool.
 *
 * The second is not incidental. The temptation when adding persistence
 * to an analysis flow is to write it inside the tool, because the tool is
 * where the validated result already is. That would silently convert a
 * read tool into a writer, put a database write on a path whose entire
 * safety argument is that it has none, and make the read-tool audit
 * trail — one metadata-only row, no input, no output, no media
 * reference — a description of something that does write. So the
 * contract is asserted directly rather than left to inspection.
 */

import { describe, expect, it } from 'vitest';

import {
  IMAGE_ANALYSIS_SCHEMA_VERSION,
  VISION_PROMPT_VERSION,
  createFakeImageAnalyzer,
  type AnalysisMediaLoader,
} from '@/lib/ai/image-analysis';
import { AI_TOOL_REGISTRY } from '@/lib/ai/tools';
import { createAnalyzeImagesTool } from '@/lib/ai/tools/analyze-images';
import {
  fakeToolDatabase,
  toolContext,
} from '@/lib/ai/tools/test-support';

import {
  imageAnalysisFailureReason,
  imageAnalysisFailureStatus,
  type ImageAnalysisMediaCandidate,
} from './model';
import {
  recordImageAnalysisFailure,
  recordValidatedImageAnalysis,
  supersedeImageAnalysisRun,
} from './service';
import { makeFakeObservationDb } from './test-support';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const OTHER_ACCOUNT = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = 'aaaaaaaa-1111-4111-8111-111111111111';
const OTHER_CONVERSATION = 'bbbbbbbb-1111-4111-8111-111111111111';
const FOLDER = `account-${ACCOUNT}`;

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

const alwaysLoader: AnalysisMediaLoader = {
  id: 'test_loader',
  read: async () => ({ bytes: JPEG, declared_mime_type: 'image/jpeg' }),
};

const SOFA_RESULT = {
  observations: [
    {
      kind: 'furniture',
      label: 'three-seat sofa',
      confidence: 0.82,
      source_indexes: [1],
    },
  ],
  need_more_photos: false,
};

function mediaUrl(name: string): string {
  return `https://project.supabase.co/storage/v1/object/public/chat-media/${FOLDER}/inbound/${name}`;
}

function toolFixture(messageNames: string[] = ['a.jpg']) {
  const messages = messageNames.map((name, index) => ({
    id: `m${index + 1}`,
    conversation_id: CONVERSATION,
    sender_type: 'customer',
    content_type: 'image',
    content_text: null,
    media_url: mediaUrl(name),
    media_type: 'image/jpeg',
    status: 'delivered',
    created_at: `2026-05-0${index + 1}T10:00:00.000Z`,
    reply_to_message_id: null,
    interactive_reply_id: null,
    ai_generated: false,
  }));
  return fakeToolDatabase({
    contacts: [],
    conversations: [
      {
        id: CONVERSATION,
        account_id: ACCOUNT,
        contact_id: 'contact-1',
        status: 'open',
        created_at: '2026-05-01T09:00:00.000Z',
        updated_at: '2026-05-01T10:00:00.000Z',
      },
    ],
    enquiries: [],
    messages,
  });
}

/** A real validated tool output, produced by the real tool. */
async function analyze(
  messageNames: string[] = ['a.jpg'],
  result: unknown = SOFA_RESULT
) {
  const fake = toolFixture(messageNames);
  const tool = createAnalyzeImagesTool({
    analyzer: createFakeImageAnalyzer({ respond: () => result }),
    mediaLoader: alwaysLoader,
  });
  const outcome = await tool.execute(
    toolContext(fake.db, ACCOUNT),
    { conversation_id: CONVERSATION }
  );
  if (!outcome.ok) {
    throw new Error(`the fixture analysis failed: ${outcome.error.message}`);
  }
  return { fake, output: outcome.data };
}

/** The canonical `messages` rows the analysed media came from. */
function candidatesFor(messageNames: string[]): ImageAnalysisMediaCandidate[] {
  return messageNames.map((name, index) => ({
    message_id: `m${index + 1}`,
    created_at: `2026-05-0${index + 1}T10:00:00.000Z`,
    sender_type: 'customer',
    content_type: 'image',
    media_url: mediaUrl(name),
    media_type: 'image/jpeg',
  }));
}

function observationDb(messageNames: string[] = ['a.jpg']) {
  const accountId = ACCOUNT;
  return makeFakeObservationDb({
    conversations: [
      { id: CONVERSATION, account_id: ACCOUNT },
      { id: OTHER_CONVERSATION, account_id: OTHER_ACCOUNT },
    ],
    messages: messageNames.map((name, index) => ({
      id: `m${index + 1}`,
      conversation_id: CONVERSATION,
      media_url: mediaUrl(name),
      media_type: 'image/jpeg',
      created_at: `2026-05-0${index + 1}T10:00:00.000Z`,
    })),
  });
}

describe('analyze_images read-tool integrity', () => {
  it('is registered as a read tool with no side effects', () => {
    const tool = AI_TOOL_REGISTRY.analyze_images;
    expect(tool.access).toBe('read');
    expect(tool.side_effects).toBe('none');
    // A read tool carries no approval gate and no idempotency key: there
    // is nothing to approve and nothing it may change.
    expect(tool).not.toHaveProperty('approval');
  });

  it('persists nothing implicitly: no write reaches any table', async () => {
    const { fake } = await analyze();

    // The tool layer's own fake records every operation, so an
    // unexpected INSERT anywhere would be visible here. This is the
    // assertion that keeps persistence an EXPLICIT second step.
    const writes = fake.calls.filter(
      (call) => call.operation !== 'select'
    );
    expect(writes).toEqual([]);
  });

  it('touches none of the canonical observation tables', async () => {
    const { fake } = await analyze();
    const touched = fake.calls.map((call) => call.table);
    for (const forbidden of [
      'image_analysis_runs',
      'image_analysis_run_images',
      'image_analysis_observations',
      'image_analysis_observation_sources',
      'case_embeddings',
      'historical_cases',
      'historical_case_snapshots',
    ]) {
      expect(touched).not.toContain(forbidden);
    }
  });

  it('reads only canonical records, account-scoped', async () => {
    const { fake } = await analyze();
    const eq = (
      call: (typeof fake.calls)[number],
      column: string,
      value: string
    ): boolean =>
      call.filters.some(
        (filter) =>
          filter.kind === 'eq' &&
          filter.column === column &&
          filter.value === value
      );

    for (const call of fake.calls) {
      if (call.operation !== 'select') continue;
      if (call.table === 'conversations') {
        // The conversation is proven to belong to the account, and its id
        // is only forwarded afterwards.
        expect(eq(call, 'account_id', ACCOUNT)).toBe(true);
        expect(eq(call, 'id', CONVERSATION)).toBe(true);
      } else if (call.table === 'enquiries') {
        expect(eq(call, 'account_id', ACCOUNT)).toBe(true);
        expect(eq(call, 'conversation_id', CONVERSATION)).toBe(true);
      } else if (call.table === 'messages') {
        // `messages` has no `account_id` column (migration 017 reaches it
        // through its parent conversation), so the boundary is the
        // already-verified conversation rather than a repeated filter.
        expect(eq(call, 'conversation_id', CONVERSATION)).toBe(true);
      } else {
        throw new Error(`unexpected read from ${call.table}`);
      }
    }
  });
});

describe('recordValidatedImageAnalysis', () => {
  it('persists a validated analysis on an explicit call', async () => {
    const { output } = await analyze();
    const db = observationDb();

    const result = await recordValidatedImageAnalysis(db.client, {
      accountId: ACCOUNT,
      output,
      provider: 'openai',
      model: 'gpt-5.4-mini',
      candidates: candidatesFor(['a.jpg']),
    });

    expect(result.created).toBe(true);
    expect(result.run.status).toBe('succeeded');
    expect(result.run.analysis_schema_version).toBe(
      IMAGE_ANALYSIS_SCHEMA_VERSION
    );
    expect(result.run.prompt_version).toBe(VISION_PROMPT_VERSION);
    expect(result.images).toHaveLength(1);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]?.finding_ref).toBe('obs-1');
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.source_media_id).toBe(`${FOLDER}/inbound/a.jpg`);
  });

  it('persists several images independently', async () => {
    const { output } = await analyze(
      ['a.jpg', 'b.jpg'],
      {
        observations: [
          {
            kind: 'furniture',
            label: 'three-seat sofa',
            confidence: 0.82,
            source_indexes: [1],
          },
          {
            kind: 'garden_waste',
            label: 'garden waste',
            confidence: 0.7,
            source_indexes: [2],
          },
        ],
        need_more_photos: false,
      }
    );
    const db = observationDb(['a.jpg', 'b.jpg']);

    const result = await recordValidatedImageAnalysis(db.client, {
      accountId: ACCOUNT,
      output,
      provider: 'openai',
      model: 'gpt-5.4-mini',
      candidates: candidatesFor(['a.jpg', 'b.jpg']),
    });

    expect(result.images.map((image) => image.ordinal)).toEqual([1, 2]);
    expect(result.observations).toHaveLength(2);
    // Each observation is attributable to exactly its own photograph.
    const ordinalByObservation = new Map(
      result.sources.map((source) => [
        source.observation_id,
        source.source_ordinal,
      ])
    );
    expect(
      result.observations.map((row) => ordinalByObservation.get(row.id))
    ).toEqual([1, 2]);
  });

  it('stores an observation spanning two photographs once, with two links', async () => {
    const { output } = await analyze(
      ['a.jpg', 'b.jpg'],
      {
        observations: [
          {
            kind: 'furniture',
            label: 'three-seat sofa',
            confidence: 0.82,
            source_indexes: [1, 2],
          },
        ],
        need_more_photos: false,
      }
    );
    const db = observationDb(['a.jpg', 'b.jpg']);

    const result = await recordValidatedImageAnalysis(db.client, {
      accountId: ACCOUNT,
      output,
      provider: 'openai',
      model: 'gpt-5.4-mini',
      candidates: candidatesFor(['a.jpg', 'b.jpg']),
    });

    expect(result.observations).toHaveLength(1);
    expect(result.sources).toHaveLength(2);
    expect(result.sources.map((source) => source.source_ordinal).sort()).toEqual(
      [1, 2]
    );
  });

  it('refuses to persist anything the strict validator rejected', async () => {
    // A provider that smuggles a price is rejected by the tool, so there
    // is no validated output to persist at all. There is deliberately no
    // path from raw provider output into the store.
    await expect(
      analyze(['a.jpg'], {
        observations: [
          {
            kind: 'furniture',
            label: 'three-seat sofa',
            confidence: 0.82,
            price: 120,
            source_indexes: [1],
          },
        ],
        need_more_photos: false,
      })
    ).rejects.toThrow(/invalid result/);
  });

  it('refuses to persist a smuggled exact weight', async () => {
    await expect(
      analyze(['a.jpg'], {
        observations: [
          {
            kind: 'furniture',
            label: 'three-seat sofa',
            confidence: 0.82,
            weight_kg: 40,
            source_indexes: [1],
          },
        ],
        need_more_photos: false,
      })
    ).rejects.toThrow(/invalid result/);
  });

  it('refuses to persist a result referencing an un-analysed image', async () => {
    await expect(
      analyze(['a.jpg'], {
        observations: [
          {
            kind: 'furniture',
            label: 'three-seat sofa',
            confidence: 0.82,
            source_indexes: [3],
          },
        ],
        need_more_photos: false,
      })
    ).rejects.toThrow(/invalid result/);
  });

  it('is idempotent for the same source, model and schema', async () => {
    const { output } = await analyze();
    const db = observationDb();
    const args = {
      accountId: ACCOUNT,
      output,
      provider: 'openai',
      model: 'gpt-5.4-mini',
      candidates: candidatesFor(['a.jpg']),
    };

    const first = await recordValidatedImageAnalysis(db.client, args);
    const second = await recordValidatedImageAnalysis(db.client, args);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.run.id).toBe(first.run.id);
    expect(db.rows('image_analysis_runs')).toHaveLength(1);
    expect(db.rows('image_analysis_observations')).toHaveLength(1);
  });

  it('creates a distinct run when the model changes', async () => {
    const { output } = await analyze();
    const db = observationDb();
    const base = {
      accountId: ACCOUNT,
      output,
      provider: 'openai',
      candidates: candidatesFor(['a.jpg']),
    };

    const first = await recordValidatedImageAnalysis(db.client, {
      ...base,
      model: 'gpt-5.4-mini',
    });
    const second = await recordValidatedImageAnalysis(db.client, {
      ...base,
      model: 'claude-haiku-4-5-20251001',
    });

    expect(second.created).toBe(true);
    expect(second.run.id).not.toBe(first.run.id);
    expect(second.run.model).toBe('claude-haiku-4-5-20251001');
    expect(db.rows('image_analysis_runs')).toHaveLength(2);
  });

  it('lets a superseded run be retired in favour of the newer one', async () => {
    const { output } = await analyze();
    const db = observationDb();
    const base = {
      accountId: ACCOUNT,
      output,
      provider: 'openai',
      candidates: candidatesFor(['a.jpg']),
    };
    const first = await recordValidatedImageAnalysis(db.client, {
      ...base,
      model: 'gpt-5.4-mini',
    });
    const second = await recordValidatedImageAnalysis(db.client, {
      ...base,
      model: 'claude-haiku-4-5-20251001',
    });

    const retired = await supersedeImageAnalysisRun(db.client, {
      accountId: ACCOUNT,
      runId: first.run.id,
      supersededByRunId: second.run.id,
    });
    expect(retired?.state).toBe('superseded');
    expect(retired?.superseded_by).toBe(second.run.id);
  });

  it('rejects an analysis whose conversation this account does not own', async () => {
    const { output } = await analyze();
    const db = observationDb();
    await expect(
      recordValidatedImageAnalysis(db.client, {
        accountId: OTHER_ACCOUNT,
        output,
        provider: 'openai',
        model: 'gpt-5.4-mini',
        candidates: candidatesFor(['a.jpg']),
      })
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('recordImageAnalysisFailure', () => {
  it('records an unavailable analysis with a closed reason and no result', async () => {
    const db = observationDb();
    const reason = imageAnalysisFailureReason({
      code: 'unavailable',
      message: 'Image analysis is not configured for this deployment',
    });

    const run = await recordImageAnalysisFailure(db.client, {
      accountId: ACCOUNT,
      conversationId: CONVERSATION,
      analyzerId: 'configured_vision_model',
      provider: 'openai',
      model: 'gpt-5.4-mini',
      failureReason: reason,
      status: imageAnalysisFailureStatus(reason),
    });

    expect(run.status).toBe('provider_unavailable');
    expect(run.failure_reason).toBe('account_not_configured');
    expect(run.result_content_hash).toBeNull();
    expect(db.rows('image_analysis_observations')).toHaveLength(0);
  });

  it('records a timeout and a cancellation as their own statuses', async () => {
    const db = observationDb();
    for (const [message, status] of [
      ['Image analysis timed out', 'timed_out'],
      ['Tool execution was cancelled', 'cancelled'],
    ] as const) {
      const reason = imageAnalysisFailureReason({
        code: 'unavailable',
        message,
      });
      const run = await recordImageAnalysisFailure(db.client, {
        accountId: ACCOUNT,
        conversationId: CONVERSATION,
        analyzerId: 'configured_vision_model',
        provider: 'openai',
        model: 'gpt-5.4-mini',
        failureReason: reason,
        status: imageAnalysisFailureStatus(reason),
      });
      expect(run.status).toBe(status);
    }
  });
});