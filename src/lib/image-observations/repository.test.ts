/**
 * Repository tests for canonical image observations.
 *
 * These assert the guarantees that make the canonical record trustworthy
 * and safe, and they assert them against a fake that reproduces
 * migration 054's constraints — so a repository function that stopped
 * scoping by account, stopped verifying traceability, or stopped checking
 * idempotency fails here rather than in production.
 */

import { describe, expect, it } from 'vitest';

import {
  IMAGE_ANALYSIS_SCHEMA_VERSION,
  VISION_PROMPT_VERSION,
} from '@/lib/ai/image-analysis';
import type {
  AnalyzeImagesOutput,
  AnalyzedImageRef,
} from '@/lib/ai/tools/analyze-images';

import {
  ImageObservationError,
  projectCanonicalImageAnalysis,
  type ImageAnalysisMediaCandidate,
} from './model';
import {
  getAnalysisForMedia,
  listImageAnalysisRunsForCase,
  loadImageAnalysisAggregate,
  recordImageAnalysis,
  recordFailedImageAnalysis,
  supersedeImageAnalysisRun,
} from './repository';
import { makeFakeObservationDb, type FakeSeed } from './test-support';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const OTHER_ACCOUNT = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = 'aaaaaaaa-1111-4111-8111-111111111111';
const OTHER_CONVERSATION = 'bbbbbbbb-1111-4111-8111-111111111111';
const CASE = 'cccccccc-1111-4111-8111-111111111111';
const MEDIA = (account: string, name: string) => `account-${account}/inbound/${name}`;

const OBSERVATION = {
  observation_id: 'obs-1',
  kind: 'furniture' as const,
  label: 'three-seat sofa',
  confidence: 0.82,
  basis: 'observed' as const,
  approximate_count: { value: 1, confidence: 0.9 },
  volume_range: null,
  dismantling: 'indicated' as const,
  heavy_handling: 'unknown' as const,
  hazards: [],
  notes: null,
};

function mediaUrl(account: string, name: string): string {
  return `https://project.supabase.co/storage/v1/object/public/chat-media/${MEDIA(
    account,
    name
  )}`;
}

interface SeedOptions {
  accountId?: string;
  conversationId?: string;
  messages?: Array<{
    id: string;
    name: string;
    conversationId?: string;
    /** Which account's folder the stored reference lives in. */
    mediaOwner?: string;
  }>;
  runs?: Record<string, unknown>[];
  runImages?: Record<string, unknown>[];
  observations?: Record<string, unknown>[];
  sources?: Record<string, unknown>[];
}

function seed(options: SeedOptions = {}): FakeSeed {
  const accountId = options.accountId ?? ACCOUNT;
  const conversationId = options.conversationId ?? CONVERSATION;
  const messages = (options.messages ?? [{ id: 'm1', name: 'a.jpg' }]).map(
    (message) => ({
      id: message.id,
      conversation_id: message.conversationId ?? conversationId,
      sender_type: 'customer',
      content_type: 'image',
      // `mediaOwner` lets a test place the stored reference in another
      // account's folder, which is how the cross-account path is reached
      // from a canonical message row rather than a forged argument.
      media_url: mediaUrl(message.mediaOwner ?? accountId, message.name),
      media_type: 'image/jpeg',
      created_at: '2026-05-01T10:00:00.000Z',
    })
  );
  return {
    conversations: [
      { id: conversationId, account_id: accountId },
      { id: OTHER_CONVERSATION, account_id: OTHER_ACCOUNT },
    ],
    messages,
    runs: options.runs,
    runImages: options.runImages,
    observations: options.observations,
    sources: options.sources,
  };
}

function fakeFor(seedOptions: SeedOptions = {}) {
  const base = seed(seedOptions);
  const fake = makeFakeObservationDb(base);
  return { fake, seed: base };
}

function analyzedImage(
  ordinal: number,
  messageId: string,
  name: string,
  accountId = ACCOUNT
): AnalyzedImageRef {
  return {
    ordinal,
    source_message_id: messageId,
    source_media_id: MEDIA(accountId, name),
    mime_type: 'image/jpeg',
    byte_length: 2048,
    direction: 'inbound',
    content_type: 'image',
    created_at: '2026-05-01T10:00:00.000Z',
  };
}

function toolOutput(overrides: Partial<AnalyzeImagesOutput> = {}): AnalyzeImagesOutput {
  return {
    conversation_id: CONVERSATION,
    enquiry_id: null,
    analyzer_id: 'configured_vision_model',
    images: [analyzedImage(1, 'm1', 'a.jpg')],
    duplicate_media_references: [],
    observations: [
      { ...OBSERVATION, sources: [{ ordinal: 1, source_message_id: 'm1', source_media_id: MEDIA(ACCOUNT, 'a.jpg') }] },
    ],
    ambiguous_items: [],
    image_quality: [],
    estimated_volume_range: null,
    need_more_photos: false,
    follow_up_questions: [],
    notes: [],
    supplied_context: null,
    uncertainty: {
      has_ambiguous_items: false,
      has_image_quality_issues: false,
      volume_range_observed: false,
      lowest_observation_confidence: 0.82,
      visual_deduplication: 'identical_media_object_only',
      possible_duplicate_photos: false,
    },
    guarantees: {
      price_calculated: false,
      weight_estimated: false,
      hidden_details_inferred: false,
    },
    limits: {
      max_images: 6,
      max_bytes_per_image: 5 * 1024 * 1024,
      max_total_bytes: 15 * 1024 * 1024,
      supported_mime_types: ['image/jpeg'],
    },
    context_window: {
      image_limit: 3,
      selected_images: 1,
      has_earlier_images: false,
    },
    freshness: { source: 'wacrm', retrieved_at: '2026-05-01T10:01:00.000Z' },
    ...overrides,
  };
}

function candidates(
  ids: string[],
  accountId = ACCOUNT
): ImageAnalysisMediaCandidate[] {
  return ids.map((id) => ({
    message_id: id,
    created_at: '2026-05-01T10:00:00.000Z',
    sender_type: 'customer',
    content_type: 'image',
    media_url: mediaUrl(accountId, id === 'm1' ? 'a.jpg' : `${id}.jpg`),
    media_type: 'image/jpeg',
  }));
}

function analysisFor(output: AnalyzeImagesOutput, accountId = ACCOUNT) {
  return projectCanonicalImageAnalysis({
    conversation_id: output.conversation_id,
    enquiry_id: output.enquiry_id,
    analyzer_id: output.analyzer_id,
    provider: 'openai',
    model: 'gpt-5.4-mini',
    analysis_schema_version: IMAGE_ANALYSIS_SCHEMA_VERSION,
    prompt_version: VISION_PROMPT_VERSION,
    correlation_id: 'run-1',
    images: output.images.map((image) => ({
      source: {
        ordinal: image.ordinal,
        source_message_id: image.source_message_id,
        source_media_id: image.source_media_id,
      },
      mime_type: image.mime_type,
      byte_length: image.byte_length,
      bytes: new Uint8Array(0),
    })),
    candidates: candidates(output.images.map((image) => image.source_message_id), accountId),
    result: {
      observations: output.observations,
      ambiguous_items: output.ambiguous_items,
      image_quality: output.image_quality,
      estimated_volume_range: output.estimated_volume_range,
      need_more_photos: output.need_more_photos,
      follow_up_questions: output.follow_up_questions,
      notes: output.notes,
    },
  });
}

async function record(output = toolOutput()) {
  const { fake } = fakeFor();
  const result = await recordImageAnalysis(fake.client, {
    accountId: ACCOUNT,
    analysis: analysisFor(output),
  });
  return { fake, result };
}

describe('recordImageAnalysis', () => {
  it('records one image and its observation', async () => {
    const { fake, result } = await record();

    expect(result.created).toBe(true);
    expect(result.run.status).toBe('succeeded');
    expect(result.run.image_count).toBe(1);
    expect(result.run.analysis_schema_version).toBe(
      IMAGE_ANALYSIS_SCHEMA_VERSION
    );
    expect(result.run.prompt_version).toBe(VISION_PROMPT_VERSION);
    expect(result.run.state).toBe('current');

    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toMatchObject({
      ordinal: 1,
      source_message_id: 'm1',
      source_media_id: MEDIA(ACCOUNT, 'a.jpg'),
      mime_type: 'image/jpeg',
      byte_length: 2048,
      direction: 'inbound',
    });

    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({
      finding_kind: 'observation',
      finding_ref: 'obs-1',
      kind: 'furniture',
      label: 'three-seat sofa',
      confidence: 0.82,
      basis: 'observed',
    });

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.source_ordinal).toBe(1);
  });

  it('records several images and keeps each observation traceable to its own', async () => {
    const output = toolOutput({
      images: [
        analyzedImage(1, 'm1', 'a.jpg'),
        analyzedImage(2, 'm2', 'b.jpg'),
      ],
      observations: [
        {
          ...OBSERVATION,
          sources: [{ ordinal: 1, source_message_id: 'm1', source_media_id: MEDIA(ACCOUNT, 'a.jpg') }],
        },
        {
          ...OBSERVATION,
          observation_id: 'obs-2',
          label: 'garden waste',
          kind: 'garden_waste' as const,
          sources: [{ ordinal: 2, source_message_id: 'm2', source_media_id: MEDIA(ACCOUNT, 'b.jpg') }],
        },
      ],
    });
    const { fake } = fakeFor({
      messages: [
        { id: 'm1', name: 'a.jpg' },
        { id: 'm2', name: 'b.jpg' },
      ],
    });
    const result = await recordImageAnalysis(fake.client, {
      accountId: ACCOUNT,
      analysis: analysisFor(output),
    });

    expect(result.images.map((image) => image.ordinal)).toEqual([1, 2]);
    expect(result.observations).toHaveLength(2);
    // Each observation points at exactly its own photograph: this is the
    // question objective 04 could not previously ask.
    const byObservation = new Map(
      result.sources.map((source) => [source.observation_id, source.source_ordinal])
    );
    expect(
      result.observations.map(
        (observation) => byObservation.get(observation.id)
      )
    ).toEqual([1, 2]);
  });

  it('records an observation with several sources once, with one link per image', async () => {
    const output = toolOutput({
      images: [
        analyzedImage(1, 'm1', 'a.jpg'),
        analyzedImage(2, 'm2', 'b.jpg'),
      ],
      observations: [
        {
          ...OBSERVATION,
          // "The same sofa appears in photos 1 and 2" — one observation,
          // two photographs. Storing it twice would double every count
          // derived from it.
          sources: [
            { ordinal: 1, source_message_id: 'm1', source_media_id: MEDIA(ACCOUNT, 'a.jpg') },
            { ordinal: 2, source_message_id: 'm2', source_media_id: MEDIA(ACCOUNT, 'b.jpg') },
          ],
        },
      ],
    });
    const { fake } = fakeFor({
      messages: [
        { id: 'm1', name: 'a.jpg' },
        { id: 'm2', name: 'b.jpg' },
      ],
    });
    const result = await recordImageAnalysis(fake.client, {
      accountId: ACCOUNT,
      analysis: analysisFor(output),
    });

    expect(result.observations).toHaveLength(1);
    expect(result.sources).toHaveLength(2);
    expect(result.sources.map((source) => source.source_ordinal).sort()).toEqual([
      1, 2,
    ]);
    expect(
      result.sources.every(
        (source) => source.observation_id === result.observations[0]?.id
      )
    ).toBe(true);
  });

  it('records ambiguity and image-quality findings alongside observations', async () => {
    const output = toolOutput({
      ambiguous_items: [
        {
          description: 'an unidentifiable white object',
          confidence: 0.3,
          sources: [{ ordinal: 1, source_message_id: 'm1', source_media_id: MEDIA(ACCOUNT, 'a.jpg') }],
        },
      ],
      image_quality: [
        {
          kind: 'too_dark' as const,
          detail: 'flash glare',
          sources: [{ ordinal: 1, source_message_id: 'm1', source_media_id: MEDIA(ACCOUNT, 'a.jpg') }],
        },
      ],
      need_more_photos: true,
      follow_up_questions: ['What is the white object?'],
    });
    const { result } = await record(output);

    expect(result.observations.map((row) => row.finding_kind)).toEqual([
      'observation',
      'ambiguous_item',
      'image_quality',
    ]);
    expect(result.observations[1]).toMatchObject({
      kind: null,
      label: 'an unidentifiable white object',
      confidence: 0.3,
      basis: null,
      detail: null,
    });
    expect(result.observations[2]).toMatchObject({
      kind: 'too_dark',
      label: null,
      confidence: null,
      detail: 'flash glare',
    });
  });

  it('stores no raw provider output and no call metadata', async () => {
    const { fake } = await record();

    // The run row carries version metadata and lifecycle only. There is
    // no column in which provider output could live, and none of the
    // provider wire-format keys appears in what was written.
    const run = fake.rows('image_analysis_runs')[0] ?? {};
    expect(Object.keys(run).sort()).toEqual(
      [
        'account_id',
        'analysis_schema_version',
        'analyzer_id',
        'completed_at',
        'conversation_id',
        'correlation_id',
        'created_at',
        'enquiry_id',
        'failure_reason',
        'historical_case_id',
        'id',
        'image_count',
        'model',
        'prompt_version',
        'provider',
        'result_content_hash',
        'source_fingerprint',
        'started_at',
        'state',
        'status',
        'superseded_by',
        'updated_at',
      ].sort()
    );

    // The tool's CALL metadata describes the invocation, not the
    // analysis, and `ai_tool_call_audit` already owns it.
    const observationPayload = JSON.stringify(
      fake.rows('image_analysis_observations')
    );
    for (const absent of [
      'limits',
      'context_window',
      'freshness',
      'guarantees',
      'uncertainty',
      'supplied_context',
      'duplicate_media_references',
    ]) {
      expect(observationPayload).not.toContain(absent);
    }
  });

  it('stores no price and no exact weight', async () => {
    const { fake } = await record();
    const serialised = JSON.stringify([
      fake.rows('image_analysis_runs'),
      fake.rows('image_analysis_observations'),
      fake.rows('image_analysis_run_images'),
    ]);
    for (const forbidden of [
      'price',
      'cost',
      'charge',
      'amount',
      'quote',
      'weight',
      'gbp',
      'currency',
      '£',
    ]) {
      expect(serialised.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('never stores a signed URL or a query string on a media reference', async () => {
    const { fake } = await record();
    for (const image of fake.rows('image_analysis_run_images')) {
      expect(String(image.source_media_id)).not.toContain('?');
      expect(String(image.source_media_id)).not.toContain('#');
      expect(String(image.source_media_id)).not.toContain('://');
      expect(String(image.source_media_id)).not.toContain('token=');
    }
  });
});

describe('traceability', () => {
  it('rejects a conversation this account does not own', async () => {
    const { fake } = fakeFor();
    await expect(
      recordImageAnalysis(fake.client, {
        accountId: OTHER_ACCOUNT,
        analysis: analysisFor(toolOutput()),
      })
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rejects a message from another conversation', async () => {
    const { fake } = fakeFor({
      messages: [{ id: 'm1', name: 'a.jpg', conversationId: OTHER_CONVERSATION }],
    });
    await expect(
      recordImageAnalysis(fake.client, {
        accountId: ACCOUNT,
        analysis: analysisFor(toolOutput()),
      })
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rejects a source message that does not exist', async () => {
    const { fake } = fakeFor({ messages: [] });
    await expect(
      recordImageAnalysis(fake.client, {
        accountId: ACCOUNT,
        analysis: analysisFor(toolOutput()),
      })
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rejects a caller-supplied media reference that is not the message own object', async () => {
    const output = toolOutput({
      images: [analyzedImage(1, 'm1', 'not-the-same.jpg')],
    });
    const { fake } = fakeFor();
    await expect(
      recordImageAnalysis(fake.client, {
        accountId: ACCOUNT,
        analysis: analysisFor(output),
      })
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it("rejects a source message whose media lives in another account's folder", async () => {
    // The message row itself points at the other account's storage folder.
    // This is the case a caller cannot fake its way past: the object path
    // is derived from the message, and the derived path belongs to
    // somebody else.
    const { fake } = fakeFor({
      messages: [{ id: 'm1', name: 'a.jpg', mediaOwner: OTHER_ACCOUNT }],
    });

    await expect(
      recordImageAnalysis(fake.client, {
        accountId: ACCOUNT,
        analysis: analysisFor(toolOutput()),
      })
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('scopes every read and write by account', async () => {
    const { fake } = await record();
    const analysisCalls = fake.calls.filter(
      (call) => call.table.startsWith('image_analysis')
    );
    expect(analysisCalls.length).toBeGreaterThan(0);
    for (const call of analysisCalls) {
      // Reads and updates filter by account; inserts carry it in the
      // payload. Either way the account comes from the trusted argument,
      // never from the caller.
      if (call.operation === 'insert') {
        // An insert has no `eq` filter, so its account is asserted from
        // the payload it carries.
        expect(call.payload?.account_id).toBe(ACCOUNT);
      } else {
        // Reads, updates and the rollback delete all filter by account.
        expect(call.filters).toContainEqual(['account_id', ACCOUNT]);
      }
    }
  });
});

describe('idempotency and versioning', () => {
  it('adopts the existing run for the same source, model and schema', async () => {
    const output = toolOutput();
    const { fake } = fakeFor();
    const first = await recordImageAnalysis(fake.client, {
      accountId: ACCOUNT,
      analysis: analysisFor(output),
    });
    const second = await recordImageAnalysis(fake.client, {
      accountId: ACCOUNT,
      analysis: analysisFor(output),
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.run.id).toBe(first.run.id);
    expect(fake.rows('image_analysis_runs')).toHaveLength(1);
    expect(fake.rows('image_analysis_observations')).toHaveLength(1);
  });

  it('creates a distinct run when the model changes', async () => {
    const { fake } = fakeFor();
    const base = analysisFor(toolOutput());
    await recordImageAnalysis(fake.client, { accountId: ACCOUNT, analysis: base });
    const other = { ...base, model: 'claude-haiku-4-5-20251001' };
    const second = await recordImageAnalysis(fake.client, {
      accountId: ACCOUNT,
      analysis: other,
    });

    expect(second.created).toBe(true);
    expect(second.run.model).toBe('claude-haiku-4-5-20251001');
    expect(fake.rows('image_analysis_runs')).toHaveLength(2);
  });

  it('creates a distinct run when the observation schema version changes', async () => {
    const { fake } = fakeFor();
    const base = analysisFor(toolOutput());
    await recordImageAnalysis(fake.client, { accountId: ACCOUNT, analysis: base });
    const second = await recordImageAnalysis(fake.client, {
      accountId: ACCOUNT,
      analysis: {
        ...base,
        analysis_schema_version: 'image-observation-v2',
      },
    });
    expect(second.created).toBe(true);
    expect(fake.rows('image_analysis_runs')).toHaveLength(2);
  });

  it('creates a distinct run when the prompt version changes', async () => {
    const { fake } = fakeFor();
    const base = analysisFor(toolOutput());
    await recordImageAnalysis(fake.client, { accountId: ACCOUNT, analysis: base });
    const second = await recordImageAnalysis(fake.client, {
      accountId: ACCOUNT,
      analysis: { ...base, prompt_version: 'vision-prompt-v2' },
    });
    expect(second.created).toBe(true);
  });

  it('records a deterministic source fingerprint on the run', async () => {
    const { result } = await record();
    expect(result.run.source_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result.run.result_content_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('failure lifecycle', () => {
  it('records a failure with a closed reason and no result hash', async () => {
    const { fake } = fakeFor();
    const run = await recordFailedImageAnalysis(fake.client, {
      accountId: ACCOUNT,
      conversationId: CONVERSATION,
      analyzerId: 'configured_vision_model',
      provider: 'openai',
      model: 'gpt-5.4-mini',
      analysisSchemaVersion: IMAGE_ANALYSIS_SCHEMA_VERSION,
      promptVersion: VISION_PROMPT_VERSION,
      status: 'provider_unavailable',
      failureReason: 'account_not_configured',
      imageCount: 0,
    });

    expect(run.status).toBe('provider_unavailable');
    expect(run.failure_reason).toBe('account_not_configured');
    expect(run.result_content_hash).toBeNull();
    expect(run.source_fingerprint).toBeNull();
    expect(fake.rows('image_analysis_observations')).toHaveLength(0);
  });

  it('keeps a provider message out of the durable failure row', async () => {
    const { fake } = fakeFor();
    await recordFailedImageAnalysis(fake.client, {
      accountId: ACCOUNT,
      conversationId: CONVERSATION,
      analyzerId: 'configured_vision_model',
      provider: 'openai',
      model: 'gpt-5.4-mini',
      analysisSchemaVersion: IMAGE_ANALYSIS_SCHEMA_VERSION,
      promptVersion: VISION_PROMPT_VERSION,
      status: 'provider_unavailable',
      failureReason: 'provider_error',
    });
    const stored = JSON.stringify(fake.rows('image_analysis_runs'));
    expect(stored).not.toContain('OpenAI');
    expect(stored).not.toContain('sk-');
  });

  it('rejects a conversation this account does not own', async () => {
    const { fake } = fakeFor();
    await expect(
      recordFailedImageAnalysis(fake.client, {
        accountId: OTHER_ACCOUNT,
        conversationId: CONVERSATION,
        analyzerId: 'configured_vision_model',
        provider: 'openai',
        model: 'gpt-5.4-mini',
        analysisSchemaVersion: IMAGE_ANALYSIS_SCHEMA_VERSION,
        promptVersion: VISION_PROMPT_VERSION,
        status: 'timed_out',
        failureReason: 'provider_timeout',
      })
    ).rejects.toBeInstanceOf(ImageObservationError);
  });
});

describe('supersession', () => {
  it('marks a run superseded and names its replacement', async () => {
    const { fake } = fakeFor();
    const base = analysisFor(toolOutput());
    const first = await recordImageAnalysis(fake.client, {
      accountId: ACCOUNT,
      analysis: base,
    });
    const second = await recordImageAnalysis(fake.client, {
      accountId: ACCOUNT,
      analysis: { ...base, model: 'claude-haiku-4-5-20251001' },
    });

    const retired = await supersedeImageAnalysisRun(fake.client, {
      accountId: ACCOUNT,
      runId: first.run.id,
      supersededByRunId: second.run.id,
    });
    expect(retired?.state).toBe('superseded');
    expect(retired?.superseded_by).toBe(second.run.id);
    // History is retained: the retired run is still readable, so a case
    // derived from it stays explainable.
    const aggregate = await loadImageAnalysisAggregate(fake.client, {
      accountId: ACCOUNT,
      runId: first.run.id,
    });
    expect(aggregate.run.state).toBe('superseded');
  });

  it('refuses to supersede a run from another account', async () => {
    const { fake } = await record();
    const retired = await supersedeImageAnalysisRun(fake.client, {
      accountId: OTHER_ACCOUNT,
      runId: fake.rows('image_analysis_runs')[0]?.id as string,
      supersededByRunId: 'other',
    });
    expect(retired).toBeNull();
    expect(fake.rows('image_analysis_runs')[0]?.state).toBe('current');
  });
});

describe('reads', () => {
  it('returns the current analysis for one photograph', async () => {
    const { fake, result } = await record();
    const aggregate = await getAnalysisForMedia(fake.client, {
      accountId: ACCOUNT,
      messageId: 'm1',
    });
    expect(aggregate?.run.id).toBe(result.run.id);
    expect(aggregate?.images[0]?.source_media_id).toBe(MEDIA(ACCOUNT, 'a.jpg'));
    expect(aggregate?.observations).toHaveLength(1);
    expect(aggregate?.sources[0]?.source_media_id).toBe(MEDIA(ACCOUNT, 'a.jpg'));
  });

  it('returns null for a photograph that was never analysed', async () => {
    const { fake } = await record();
    expect(
      await getAnalysisForMedia(fake.client, {
        accountId: ACCOUNT,
        messageId: 'unknown-message',
      })
    ).toBeNull();
  });

  it('returns null for another account, so a tenant cannot be probed', async () => {
    const { fake } = await record();
    expect(
      await getAnalysisForMedia(fake.client, {
        accountId: OTHER_ACCOUNT,
        messageId: 'm1',
      })
    ).toBeNull();
  });

  it('does not return a withheld run', async () => {
    const { fake, result } = await record();
    fake.rows('image_analysis_runs');
    // Apply the exclusion the migration-054 trigger would apply.
    const db = makeFakeObservationDb({
      ...seed(),
      runs: [
        {
          ...result.run,
          state: 'withheld',
        },
      ],
      runImages: fake.rows('image_analysis_run_images'),
      observations: fake.rows('image_analysis_observations'),
      sources: fake.rows('image_analysis_observation_sources'),
    });
    expect(
      await getAnalysisForMedia(db.client, {
        accountId: ACCOUNT,
        messageId: 'm1',
      })
    ).toBeNull();
  });

  it('lists a case analyses, and refuses another account case', async () => {
    const { fake } = fakeFor();
    const base = { ...analysisFor(toolOutput()), historical_case_id: CASE };
    await recordImageAnalysis(fake.client, { accountId: ACCOUNT, analysis: base });

    const runs = await listImageAnalysisRunsForCase(fake.client, {
      accountId: ACCOUNT,
      caseId: CASE,
    });
    expect(runs).toHaveLength(1);

    expect(
      await listImageAnalysisRunsForCase(fake.client, {
        accountId: OTHER_ACCOUNT,
        caseId: CASE,
      })
    ).toHaveLength(0);
  });

  it('throws not_found for a run this account does not own', async () => {
    const { fake, result } = await record();
    await expect(
      loadImageAnalysisAggregate(fake.client, {
        accountId: OTHER_ACCOUNT,
        runId: result.run.id,
      })
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('rollback', () => {
  it('leaves no partial aggregate when the observation write fails', async () => {
    const { fake } = fakeFor();
    const base = analysisFor(toolOutput());
    // Make the observation table unavailable after the run and images are
    // written, so the rollback path is the one exercised.
    fake.failTable('image_analysis_observations');

    await expect(
      recordImageAnalysis(fake.client, { accountId: ACCOUNT, analysis: base })
    ).rejects.toBeInstanceOf(ImageObservationError);

    // The run and its images are removed: a run with no observations
    // would be a record of an analysis that did not happen, and a later
    // read would treat it as one.
    expect(fake.rows('image_analysis_runs')).toHaveLength(0);
    expect(fake.rows('image_analysis_run_images')).toHaveLength(0);
  });
});
describe('privacy and deletion', () => {
  it('removes derived observations when the source message is deleted', async () => {
    const { fake } = await record();

    // Deleting the photograph cascades its run image away, which cascades
    // its source link, which prunes the observation that has no surviving
    // source and then the successful run that has no observations. Without
    // that chain, learning memory would survive the photograph it
    // describes.
    await fake.client
      .from('image_analysis_runs')
      .delete()
      .eq('account_id', ACCOUNT)
      .eq('id', fake.rows('image_analysis_runs')[0]?.id as string);

    expect(fake.rows('image_analysis_run_images')).toHaveLength(0);
    expect(fake.rows('image_analysis_observations')).toHaveLength(0);
    expect(fake.rows('image_analysis_observation_sources')).toHaveLength(0);
  });

  it('leaves no orphan retrievable analysis after its sources are gone', async () => {
    const { fake } = await record();
    await fake.client
      .from('image_analysis_runs')
      .delete()
      .eq('account_id', ACCOUNT)
      .eq('id', fake.rows('image_analysis_runs')[0]?.id as string);

    // The per-image read must now report nothing: a retrievable analysis
    // of a photograph WACRM no longer holds is exactly the orphan this
    // guard exists to prevent.
    expect(
      await getAnalysisForMedia(fake.client, {
        accountId: ACCOUNT,
        messageId: 'm1',
      })
    ).toBeNull();
  });

  it('never returns a withheld analysis to a consumer', async () => {
    const { fake } = await record();
    const runId = fake.rows('image_analysis_runs')[0]?.id as string;

    // The state the migration-054 exclusion trigger applies. A withheld
    // analysis is retained for audit and must not be retrievable.
    await fake.client
      .from('image_analysis_runs')
      .update({ state: 'withheld' })
      .eq('account_id', ACCOUNT)
      .eq('id', runId);

    expect(
      await getAnalysisForMedia(fake.client, {
        accountId: ACCOUNT,
        messageId: 'm1',
      })
    ).toBeNull();
  });

  it('still lets an audit read see a withheld run', async () => {
    const CASE = 'cccccccc-1111-4111-8111-111111111111';
    const { fake } = fakeFor();
    const recorded = await recordImageAnalysis(fake.client, {
      accountId: ACCOUNT,
      analysis: { ...analysisFor(toolOutput()), historical_case_id: CASE },
    });
    await fake.client
      .from('image_analysis_runs')
      .update({ state: 'withheld' })
      .eq('account_id', ACCOUNT)
      .eq('id', recorded.run.id);

    // Retention and retrievability are different questions. Hiding a
    // withheld row from the audit read would make the operator's own
    // privacy decision invisible to them, and would make an accidental
    // exclusion impossible to investigate.
    const runs = await listImageAnalysisRunsForCase(fake.client, {
      accountId: ACCOUNT,
      caseId: CASE,
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.state).toBe('withheld');

    // While the retrieval-facing read reports nothing.
    expect(
      await getAnalysisForMedia(fake.client, {
        accountId: ACCOUNT,
        messageId: 'm1',
      })
    ).toBeNull();
  });

  it('refuses to supersede a withheld run', async () => {
    const { fake } = await record();
    const runId = fake.rows('image_analysis_runs')[0]?.id as string;
    await fake.client
      .from('image_analysis_runs')
      .update({ state: 'withheld' })
      .eq('account_id', ACCOUNT)
      .eq('id', runId);

    // An analysis withheld by a privacy exclusion must not be quietly
    // moved into an ordinary state.
    const retired = await supersedeImageAnalysisRun(fake.client, {
      accountId: ACCOUNT,
      runId,
      supersededByRunId: 'replacement',
    });
    expect(retired).toBeNull();
    expect(fake.rows('image_analysis_runs')[0]?.state).toBe('withheld');
  });
});
