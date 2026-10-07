import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { encrypt } from '@/lib/whatsapp/encryption';
import {
  IMAGE_ANALYSIS_LIMITS,
  createFakeImageAnalyzer,
  createStubImageAnalyzer,
  getConfiguredImageAnalyzer,
  type AnalysisMediaLoader,
  type ImageAnalyzer,
} from '@/lib/ai/image-analysis';

import { createAnalyzeImagesTool } from './analyze-images';
import {
  enquiryRow as enquiryRowFixture,
  fakeToolDatabase,
  toolContext,
} from './test-support';

const ACCOUNT = '3f1b2c40-1111-4222-8333-444455556666';
const FOLDER = `account-${ACCOUNT}`;
const OTHER_ACCOUNT = '99999999-9999-4999-8999-888888888888';
const CONVERSATION = 'conversation-1';
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

/** `account-<uuid>/…` is the exact convention the boundary matches. */
function mediaUrl(name: string, folder = `account-${ACCOUNT}`): string {
  return `https://project.supabase.co/storage/v1/object/public/chat-media/${folder}/inbound/${name}`;
}

function imageMessage(
  id: string,
  createdAt: string,
  name: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    conversation_id: CONVERSATION,
    sender_type: 'customer',
    content_type: 'image',
    content_text: null,
    media_url: mediaUrl(name),
    media_type: 'image/jpeg',
    status: 'delivered',
    created_at: createdAt,
    reply_to_message_id: null,
    interactive_reply_id: null,
    ai_generated: false,
    ...overrides,
  };
}

function textMessage(id: string, createdAt: string): Record<string, unknown> {
  return {
    id,
    conversation_id: CONVERSATION,
    sender_type: 'customer',
    content_type: 'text',
    content_text: 'Can you collect all of this?',
    media_url: null,
    media_type: null,
    status: 'delivered',
    created_at: createdAt,
    reply_to_message_id: null,
    interactive_reply_id: null,
    ai_generated: false,
  };
}

function seed(
  messages: Array<Record<string, unknown>>,
  options: {
    conversationOverrides?: Record<string, unknown>;
    enquiries?: Array<Record<string, unknown>>;
  } = {}
) {
  return fakeToolDatabase({
    contacts: [],
    conversations: [
      {
        id: CONVERSATION,
        account_id: ACCOUNT,
        contact_id: 'contact-1',
        status: 'open',
        created_at: '2026-09-01T09:00:00.000Z',
        updated_at: '2026-10-01T10:00:00.000Z',
        ...options.conversationOverrides,
      },
    ],
    enquiries: (options.enquiries ?? []).map((row) => ({
      created_by_user_id: 'user-1',
      customer_intent: null,
      postcode: null,
      address: null,
      ...row,
    })),
    messages,
  });
}

/** A canonical-shaped enquiry row, for the customer-stated context test. */
function enquiryRow(overrides: Record<string, unknown> = {}) {
  return {
    ...enquiryRowFixture({
      account_id: ACCOUNT,
      conversation_id: CONVERSATION,
      ...overrides,
    }),
  };
}

const alwaysLoader: AnalysisMediaLoader = {
  id: 'test_loader',
  read: async () => ({
    bytes: JPEG_BYTES,
    declared_mime_type: 'image/jpeg',
  }),
};

const SOFA_RESULT = {
  observations: [
    {
      kind: 'furniture',
      label: 'three-seat sofa',
      confidence: 0.82,
      approximate_count: { value: 1, confidence: 0.9 },
      source_indexes: [1],
    },
  ],
  need_more_photos: false,
};

function stubTool(
  analyzer: ImageAnalyzer | null,
  messages: Array<Record<string, unknown>>
) {
  const fake = seed(messages);
  return {
    fake,
    tool: createAnalyzeImagesTool({
      analyzer,
      mediaLoader: alwaysLoader,
    }),
  };
}

describe('analyze_images', () => {
  it('is registered as a side-effect-free read tool', () => {
    const { tool } = stubTool(createStubImageAnalyzer(SOFA_RESULT), [
      imageMessage('message-1', '2026-10-01T10:00:00.000Z', 'photo-1.jpg'),
    ]);

    expect(tool.name).toBe('analyze_images');
    expect(tool.access).toBe('read');
    expect(tool.side_effects).toBe('none');
    expect(tool).not.toHaveProperty('approval_required');
  });

  it('returns structured observations for the newest image', async () => {
    const analyzer = createStubImageAnalyzer(SOFA_RESULT);
    const { fake, tool } = stubTool(analyzer, [
      textMessage('message-0', '2026-10-01T09:00:00.000Z'),
      imageMessage('message-1', '2026-10-01T10:00:00.000Z', 'photo-1.jpg'),
    ]);

    const result = await tool.execute(toolContext(fake.db, ACCOUNT), {
      conversation_id: CONVERSATION,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.conversation_id).toBe(CONVERSATION);
    expect(result.data.analyzer_id).toBe('fake_image_analyzer');
    expect(result.data.freshness.source).toBe('wacrm');
    expect(result.data.context_window).toEqual({
      image_limit: 3,
      selected_images: 1,
      has_earlier_images: false,
    });
    expect(result.data.images).toEqual([
      {
        ordinal: 1,
        source_message_id: 'message-1',
        source_media_id: `${FOLDER}/inbound/photo-1.jpg`,
        mime_type: 'image/jpeg',
        byte_length: JPEG_BYTES.byteLength,
        direction: 'inbound',
        content_type: 'image',
        created_at: '2026-10-01T10:00:00.000Z',
      },
    ]);
    expect(result.data.observations[0]?.label).toBe('three-seat sofa');
    expect(result.data.observations[0]?.sources[0]?.source_message_id).toBe(
      'message-1'
    );
  });

  it('never reports a price, weight, or hidden detail as fact', async () => {
    const { fake, tool } = stubTool(
      createStubImageAnalyzer({
        ...SOFA_RESULT,
        observations: [
          {
            kind: 'furniture',
            label: 'three-seat sofa',
            confidence: 0.6,
            source_indexes: [1],
          },
        ],
      }),
      [imageMessage('message-1', '2026-10-01T10:00:00.000Z', 'photo-1.jpg')]
    );

    const result = await tool.execute(toolContext(fake.db, ACCOUNT), {
      conversation_id: CONVERSATION,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // No observation, ambiguity, quality, or volume field carries a
    // monetary or weight value. The only occurrences of those words are the
    // explicit negative guarantees below.
    const analysis = { ...result.data, guarantees: undefined };
    expect(JSON.stringify(analysis)).not.toMatch(
      /"(price|prices|cost|weight|quote|charge|fee|amount)[a-z_]*"\s*:\s*(?!false|null|"|\[|\{)[-\d]/
    );
    expect(result.data.guarantees).toEqual({
      price_calculated: false,
      weight_estimated: false,
      hidden_details_inferred: false,
    });
  });

  it('scopes the call to the authenticated account', async () => {
    const analyzer = createStubImageAnalyzer(SOFA_RESULT);
    const { fake, tool } = stubTool(analyzer, [
      imageMessage('message-1', '2026-10-01T10:00:00.000Z', 'photo-1.jpg'),
    ]);

    const result = await tool.execute(toolContext(fake.db, OTHER_ACCOUNT), {
      conversation_id: CONVERSATION,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('not_found');
    expect(analyzer.calls).toHaveLength(0);
    // The conversation read is explicitly account-scoped.
    expect(fake.calls.some((call) => call.table === 'conversations')).toBe(
      true
    );
  });

  it('refuses a message id from another conversation', async () => {
    const analyzer = createStubImageAnalyzer(SOFA_RESULT);
    const { fake, tool } = stubTool(analyzer, [
      imageMessage('message-1', '2026-10-01T10:00:00.000Z', 'photo-1.jpg'),
      imageMessage('message-2', '2026-10-01T10:01:00.000Z', 'photo-2.jpg', {
        conversation_id: 'conversation-other',
      }),
    ]);

    const result = await tool.execute(toolContext(fake.db, ACCOUNT), {
      conversation_id: CONVERSATION,
      message_ids: ['message-2'],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('not_found');
    expect(analyzer.calls).toHaveLength(0);
  });

  it('rejects an account_id supplied as tool input', async () => {
    const { fake, tool } = stubTool(createStubImageAnalyzer(SOFA_RESULT), [
      imageMessage('message-1', '2026-10-01T10:00:00.000Z', 'photo-1.jpg'),
    ]);

    const result = await tool.execute(toolContext(fake.db, ACCOUNT), {
      conversation_id: CONVERSATION,
      account_id: OTHER_ACCOUNT,
    } as never);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_input');
    expect(result.error.message).toContain('execution context');
  });

  it('rejects an arbitrary URL in place of a media reference', async () => {
    const { fake, tool } = stubTool(createStubImageAnalyzer(SOFA_RESULT), [
      imageMessage('message-1', '2026-10-01T10:00:00.000Z', 'photo-1.jpg'),
    ]);

    const result = await tool.execute(toolContext(fake.db, ACCOUNT), {
      conversation_id: CONVERSATION,
      image_url: 'https://example.com/photo.jpg',
    } as never);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_input');
    expect(result.error.message).toContain('message id only');
  });

  it('rejects more images than the per-call limit', async () => {
    const { fake, tool } = stubTool(createStubImageAnalyzer(SOFA_RESULT), [
      imageMessage('message-1', '2026-10-01T10:00:00.000Z', 'photo-1.jpg'),
    ]);

    const result = await tool.execute(toolContext(fake.db, ACCOUNT), {
      conversation_id: CONVERSATION,
      message_ids: Array.from(
        { length: IMAGE_ANALYSIS_LIMITS.max_images + 1 },
        (_unused, index) => `message-${index}`
      ),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_input');
    expect(result.error.message).toContain('At most');
  });

  it('rejects a conversation with no image media', async () => {
    const { fake, tool } = stubTool(createStubImageAnalyzer(SOFA_RESULT), [
      textMessage('message-1', '2026-10-01T10:00:00.000Z'),
    ]);

    const result = await tool.execute(toolContext(fake.db, ACCOUNT), {
      conversation_id: CONVERSATION,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_input');
    expect(result.error.message).toBe(
      'No image media was found for this conversation'
    );
  });

  it('fails safely as unavailable when no analyzer is configured', async () => {
    const { fake, tool } = stubTool(null, [
      imageMessage('message-1', '2026-10-01T10:00:00.000Z', 'photo-1.jpg'),
    ]);

    const result = await tool.execute(toolContext(fake.db, ACCOUNT), {
      conversation_id: CONVERSATION,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('unavailable');
    expect(result.error.retryable).toBe(false);
    // Fails before any media is read.
    expect(fake.calls.some((call) => call.table === 'messages')).toBe(false);
  });

  it('reports a provider timeout as a retryable unavailable error', async () => {
    const analyzer: ImageAnalyzer = {
      id: 'hanging',
      analyze: () => new Promise(() => undefined),
    };
    const fake = seed([
      imageMessage('message-1', '2026-10-01T10:00:00.000Z', 'photo-1.jpg'),
    ]);
    const tool = createAnalyzeImagesTool({
      analyzer,
      mediaLoader: alwaysLoader,
      analyzerTimeoutMs: 5,
    });

    const result = await tool.execute(toolContext(fake.db, ACCOUNT), {
      conversation_id: CONVERSATION,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('unavailable');
    expect(result.error.retryable).toBe(true);
    expect(result.error.message).toBe('Image analysis timed out');
  });

  it('reports a provider failure without leaking the provider message', async () => {
    const analyzer: ImageAnalyzer = {
      id: 'broken',
      analyze: async () => {
        throw new Error('api key sk-live-should-never-appear');
      },
    };
    const fake = seed([
      imageMessage('message-1', '2026-10-01T10:00:00.000Z', 'photo-1.jpg'),
    ]);
    const tool = createAnalyzeImagesTool({
      analyzer,
      mediaLoader: alwaysLoader,
    });

    const result = await tool.execute(toolContext(fake.db, ACCOUNT), {
      conversation_id: CONVERSATION,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('unavailable');
    expect(result.error.message).toBe('Image analysis provider failed');
    expect(JSON.stringify(result)).not.toContain('sk-live');
  });

  it('rejects an invalid provider result as an internal error', async () => {
    const { fake, tool } = stubTool(
      createStubImageAnalyzer({
        observations: [
          {
            kind: 'furniture',
            label: 'sofa',
            confidence: 0.8,
            source_indexes: [1],
            estimated_price: 149,
          },
        ],
        need_more_photos: false,
      }),
      [imageMessage('message-1', '2026-10-01T10:00:00.000Z', 'photo-1.jpg')]
    );

    const result = await tool.execute(toolContext(fake.db, ACCOUNT), {
      conversation_id: CONVERSATION,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('internal');
    expect(result.error.message).toContain('invalid result');
    expect(result.error.message).not.toContain('149');
  });

  it('honours caller cancellation', async () => {
    const analyzer: ImageAnalyzer = {
      id: 'hanging',
      analyze: () => new Promise(() => undefined),
    };
    const fake = seed([
      imageMessage('message-1', '2026-10-01T10:00:00.000Z', 'photo-1.jpg'),
    ]);
    const tool = createAnalyzeImagesTool({
      analyzer,
      mediaLoader: alwaysLoader,
    });

    const result = await tool.execute(
      { ...toolContext(fake.db, ACCOUNT), signal: AbortSignal.abort() },
      { conversation_id: CONVERSATION }
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('unavailable');
    expect(result.error.retryable).toBe(true);
  });

  it('does not retain image bytes in the recorded analyzer call', async () => {
    const analyzer = createStubImageAnalyzer(SOFA_RESULT);
    const { fake, tool } = stubTool(analyzer, [
      imageMessage('message-1', '2026-10-01T10:00:00.000Z', 'photo-1.jpg'),
    ]);

    await tool.execute(toolContext(fake.db, ACCOUNT), {
      conversation_id: CONVERSATION,
    });

    expect(JSON.stringify(analyzer.calls)).not.toContain('bytes');
    expect(analyzer.calls[0]?.images[0]?.byte_length).toBe(
      JPEG_BYTES.byteLength
    );
  });
});

describe('analyze_images multi-image traceability', () => {
  const MIXED_RESULT = {
    observations: [
      {
        kind: 'furniture',
        label: 'armchair',
        confidence: 0.7,
        source_indexes: [1],
      },
      {
        kind: 'loose_mixed_waste',
        label: 'general waste',
        confidence: 0.55,
        approximate_count: { value: 3, confidence: 0.4 },
        source_indexes: [2],
      },
    ],
    ambiguous_items: [
      {
        description: 'unidentified item behind the armchair',
        confidence: 0.2,
        source_indexes: [1],
      },
    ],
    image_quality: [{ kind: 'obstructed', source_indexes: [2] }],
    estimated_volume_range: { min: 1, max: 3, confidence: 0.4 },
    need_more_photos: true,
    follow_up_questions: ['Is there anything behind the armchair?'],
    notes: ['Second photo is partially obstructed.'],
  };

  it('analyses several images in chronological order with per-source observations', async () => {
    const analyzer = createStubImageAnalyzer(MIXED_RESULT);
    const fake = seed([
      imageMessage('message-2', '2026-10-01T10:05:00.000Z', 'photo-2.jpg'),
      imageMessage('message-1', '2026-10-01T10:00:00.000Z', 'photo-1.jpg'),
    ]);
    const tool = createAnalyzeImagesTool({
      analyzer,
      mediaLoader: alwaysLoader,
    });

    const result = await tool.execute(toolContext(fake.db, ACCOUNT), {
      conversation_id: CONVERSATION,
      image_limit: 2,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.images.map((image) => image.source_message_id)).toEqual([
      'message-1',
      'message-2',
    ]);
    expect(result.data.observations[0]?.sources[0]?.source_message_id).toBe(
      'message-1'
    );
    expect(result.data.observations[1]?.sources[0]?.source_message_id).toBe(
      'message-2'
    );
    expect(result.data.uncertainty.has_ambiguous_items).toBe(true);
    expect(result.data.uncertainty.has_image_quality_issues).toBe(true);
    expect(result.data.uncertainty.possible_duplicate_photos).toBe(true);
    expect(result.data.need_more_photos).toBe(true);
  });

  it('collapses a repeated reference to the same stored object', async () => {
    // One image survives deduplication, so the provider may only reference
    // ordinal 1 — a reference to ordinal 2 would be rejected.
    const analyzer = createFakeImageAnalyzer({
      respond: () => ({
        observations: [
          {
            kind: 'furniture',
            label: 'armchair',
            confidence: 0.7,
            source_indexes: [1],
          },
        ],
        need_more_photos: false,
      }),
    });
    const fake = seed([
      imageMessage('message-1', '2026-10-01T10:00:00.000Z', 'photo-1.jpg'),
      imageMessage('message-2', '2026-10-01T10:05:00.000Z', 'photo-1.jpg'),
    ]);
    const tool = createAnalyzeImagesTool({
      analyzer,
      mediaLoader: alwaysLoader,
    });

    const result = await tool.execute(toolContext(fake.db, ACCOUNT), {
      conversation_id: CONVERSATION,
      image_limit: 2,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // One object, so one image reached the analyzer — the second message
    // was the same stored photo referenced twice.
    expect(result.data.images).toHaveLength(1);
    expect(result.data.duplicate_media_references).toEqual([
      {
        message_id: 'message-2',
        duplicate_of_message_id: 'message-1',
        reason: 'identical_media_object',
      },
    ]);
    expect(analyzer.calls[0]?.image_count).toBe(1);
  });

  it('passes customer-stated context separately from what is observed', async () => {
    // Only one image is analysed here, so the provider may reference
    // ordinal 1 only.
    const analyzer = createStubImageAnalyzer(SOFA_RESULT);
    const fake = seed(
      [imageMessage('message-1', '2026-10-01T10:00:00.000Z', 'photo-1.jpg')],
      {
        enquiries: [
          enquiryRow({ item_descriptions: ['old wardrobe in the loft'] }),
        ],
      }
    );

    const tool = createAnalyzeImagesTool({
      analyzer,
      mediaLoader: alwaysLoader,
    });

    const result = await tool.execute(toolContext(fake.db, ACCOUNT), {
      conversation_id: CONVERSATION,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The stated wardrobe is context, never an observation.
    expect(result.data.observations.map((o) => o.label)).not.toContain(
      'old wardrobe in the loft'
    );
    expect(result.data.supplied_context?.origin).toBe('customer_statement');
    expect(result.data.supplied_context?.item_descriptions).toEqual([
      'old wardrobe in the loft',
    ]);
    expect(analyzer.calls[0]?.context_present).toBe(true);
  });

  it('omits context when the caller opts out', async () => {
    const analyzer = createStubImageAnalyzer(SOFA_RESULT);
    const { fake, tool } = stubTool(analyzer, [
      imageMessage('message-1', '2026-10-01T10:00:00.000Z', 'photo-1.jpg'),
    ]);

    const result = await tool.execute(toolContext(fake.db, ACCOUNT), {
      conversation_id: CONVERSATION,
      include_context: false,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.supplied_context).toBeNull();
    expect(analyzer.calls[0]?.context_present).toBe(false);
  });
});

describe('analyze_images result shape', () => {
  it('surfaces need_more_photos and follow-up questions for a poor photo', async () => {
    const { fake, tool } = stubTool(
      createStubImageAnalyzer({
        observations: [
          {
            kind: 'ambiguous_item',
            label: 'unclear shape in shadow',
            confidence: 0.15,
            basis: 'ambiguous',
            source_indexes: [1],
          },
        ],
        image_quality: [
          { kind: 'too_dark', detail: 'almost no light', source_indexes: [1] },
          { kind: 'low_resolution', source_indexes: [1] },
        ],
        need_more_photos: true,
        follow_up_questions: [
          'Could you send a photo in daylight?',
          'How many items are in the pile?',
        ],
      }),
      [imageMessage('message-1', '2026-10-01T10:00:00.000Z', 'photo-1.jpg')]
    );

    const result = await tool.execute(toolContext(fake.db, ACCOUNT), {
      conversation_id: CONVERSATION,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.need_more_photos).toBe(true);
    expect(result.data.follow_up_questions).toHaveLength(2);
    expect(result.data.uncertainty.lowest_observation_confidence).toBe(0.15);
    expect(result.data.uncertainty.volume_range_observed).toBe(false);
    expect(result.data.uncertainty.visual_deduplication).toBe(
      'identical_media_object_only'
    );
    expect(result.data.estimated_volume_range).toBeNull();
  });

  it('reports the effective limits so a caller can see the boundary', async () => {
    const { fake, tool } = stubTool(createStubImageAnalyzer(SOFA_RESULT), [
      imageMessage('message-1', '2026-10-01T10:00:00.000Z', 'photo-1.jpg'),
    ]);

    const result = await tool.execute(toolContext(fake.db, ACCOUNT), {
      conversation_id: CONVERSATION,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.limits).toEqual({
      max_images: IMAGE_ANALYSIS_LIMITS.max_images,
      max_bytes_per_image: IMAGE_ANALYSIS_LIMITS.max_bytes_per_image,
      max_total_bytes: IMAGE_ANALYSIS_LIMITS.max_total_bytes,
      supported_mime_types: IMAGE_ANALYSIS_LIMITS.supported_mime_types,
    });
  });
});

// ============================================================
// Production wiring: the per-account resolver and the real vision
// adapter behind it. Provider HTTP is mocked, so nothing here spends a
// token, and nothing here reaches a WhatsApp endpoint.
// ============================================================

function aiConfigRow(overrides: Record<string, unknown> = {}) {
  return {
    account_id: ACCOUNT,
    provider: 'openai',
    model: 'gpt-5.4-mini',
    api_key: encrypt('sk-test-vision-key'),
    system_prompt: null,
    is_active: true,
    auto_reply_enabled: false,
    auto_reply_max_per_conversation: 3,
    handoff_agent_id: null,
    embeddings_api_key: null,
    ...overrides,
  };
}

/** A tool wired the way the registry is, but with a mocked provider. */
function productionTool(
  aiConfigs: Array<Record<string, unknown>>,
  messages: Array<Record<string, unknown>>,
  loader: AnalysisMediaLoader = alwaysLoader
) {
  const fake = fakeToolDatabase({
    conversations: [
      {
        id: CONVERSATION,
        account_id: ACCOUNT,
        contact_id: 'contact-1',
        status: 'open',
        created_at: '2026-09-01T09:00:00.000Z',
        updated_at: '2026-10-01T10:00:00.000Z',
      },
    ],
    ai_configs: aiConfigs,
    enquiries: [],
    messages,
  });
  return {
    fake,
    tool: createAnalyzeImagesTool({
      resolveAnalyzer: getConfiguredImageAnalyzer,
      mediaLoader: loader,
    }),
  };
}

function visionResponse(result: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [
        { message: { content: JSON.stringify(result) }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  } as unknown as Response;
}

describe('analyze_images production resolver', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses the configured adapter end to end', async () => {
    fetchMock.mockResolvedValue(visionResponse(SOFA_RESULT));
    const { fake, tool } = productionTool([aiConfigRow()], [
      imageMessage('message-1', '2026-10-01T10:00:00.000Z', 'photo-1.jpg'),
    ]);

    const result = await tool.execute(toolContext(fake.db, ACCOUNT), {
      conversation_id: CONVERSATION,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.analyzer_id).toBe('configured_vision_model');
    expect(result.data.observations[0]?.label).toBe('three-seat sofa');
    expect(result.data.guarantees).toEqual({
      price_calculated: false,
      weight_estimated: false,
      hidden_details_inferred: false,
    });
  });

  it('analyses several images in one provider call', async () => {
    fetchMock.mockResolvedValue(
      visionResponse({
        ...SOFA_RESULT,
        observations: [
          { ...SOFA_RESULT.observations[0], source_indexes: [1] },
          {
            kind: 'loose_mixed_waste',
            label: 'mixed waste pile',
            confidence: 0.5,
            basis: 'observed',
            approximate_count: null,
            source_indexes: [2],
          },
        ],
      })
    );
    const { fake, tool } = productionTool([aiConfigRow()], [
      imageMessage('message-1', '2026-10-01T10:00:00.000Z', 'photo-1.jpg'),
      imageMessage('message-2', '2026-10-01T10:01:00.000Z', 'photo-2.jpg'),
    ]);

    const result = await tool.execute(toolContext(fake.db, ACCOUNT), {
      conversation_id: CONVERSATION,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.data.images).toHaveLength(2);
    expect(result.data.observations.map((o) => o.sources[0]?.ordinal)).toEqual([
      1, 2,
    ]);
  });

  it('reports unavailable and reads no media when the account has no AI config', async () => {
    const loader = { id: 'counting', read: vi.fn() };
    const { fake, tool } = productionTool(
      [],
      [imageMessage('message-1', '2026-10-01T10:00:00.000Z', 'photo-1.jpg')],
      loader as unknown as AnalysisMediaLoader
    );

    const result = await tool.execute(toolContext(fake.db, ACCOUNT), {
      conversation_id: CONVERSATION,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('unavailable');
    expect(result.error.retryable).toBe(false);
    expect(loader.read).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not resolve another account’s configuration', async () => {
    fetchMock.mockResolvedValue(visionResponse(SOFA_RESULT));
    const { fake, tool } = productionTool(
      [aiConfigRow({ account_id: OTHER_ACCOUNT })],
      [imageMessage('message-1', '2026-10-01T10:00:00.000Z', 'photo-1.jpg')]
    );

    const result = await tool.execute(toolContext(fake.db, ACCOUNT), {
      conversation_id: CONVERSATION,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a provider answer that smuggles in a price', async () => {
    fetchMock.mockResolvedValue(
      visionResponse({
        ...SOFA_RESULT,
        observations: [
          { ...SOFA_RESULT.observations[0], estimated_price: 240 },
        ],
      })
    );
    const { fake, tool } = productionTool([aiConfigRow()], [
      imageMessage('message-1', '2026-10-01T10:00:00.000Z', 'photo-1.jpg'),
    ]);

    const result = await tool.execute(toolContext(fake.db, ACCOUNT), {
      conversation_id: CONVERSATION,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('internal');
    expect(result.error.message).toContain('forbidden_field');
  });

  it('rejects a provider answer that smuggles in an exact weight', async () => {
    fetchMock.mockResolvedValue(
      visionResponse({
        ...SOFA_RESULT,
        observations: [
          { ...SOFA_RESULT.observations[0], estimated_weight_kg: 42 },
        ],
      })
    );
    const { fake, tool } = productionTool([aiConfigRow()], [
      imageMessage('message-1', '2026-10-01T10:00:00.000Z', 'photo-1.jpg'),
    ]);

    const result = await tool.execute(toolContext(fake.db, ACCOUNT), {
      conversation_id: CONVERSATION,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('forbidden_field');
  });

  it('rejects a provider answer that references an image that was not sent', async () => {
    fetchMock.mockResolvedValue(
      visionResponse({
        ...SOFA_RESULT,
        observations: [
          { ...SOFA_RESULT.observations[0], source_indexes: [4] },
        ],
      })
    );
    const { fake, tool } = productionTool([aiConfigRow()], [
      imageMessage('message-1', '2026-10-01T10:00:00.000Z', 'photo-1.jpg'),
    ]);

    const result = await tool.execute(toolContext(fake.db, ACCOUNT), {
      conversation_id: CONVERSATION,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('internal');
    expect(result.error.message).toContain('out_of_range');
  });

  it('rejects a provider answer with a malformed confidence', async () => {
    fetchMock.mockResolvedValue(
      visionResponse({
        ...SOFA_RESULT,
        observations: [
          { ...SOFA_RESULT.observations[0], confidence: 'high' },
        ],
      })
    );
    const { fake, tool } = productionTool([aiConfigRow()], [
      imageMessage('message-1', '2026-10-01T10:00:00.000Z', 'photo-1.jpg'),
    ]);

    const result = await tool.execute(toolContext(fake.db, ACCOUNT), {
      conversation_id: CONVERSATION,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('internal');
    expect(result.error.message).toContain('out_of_range');
  });

  it('never reaches a WhatsApp endpoint and writes nothing', async () => {
    fetchMock.mockResolvedValue(visionResponse(SOFA_RESULT));
    const { fake, tool } = productionTool([aiConfigRow()], [
      imageMessage('message-1', '2026-10-01T10:00:00.000Z', 'photo-1.jpg'),
    ]);

    await tool.execute(toolContext(fake.db, ACCOUNT), {
      conversation_id: CONVERSATION,
    });

    const hosts = fetchMock.mock.calls.map(([url]) => String(url));
    expect(
      hosts.every((url) => url.startsWith('https://api.openai.com/')),
    ).toBe(true);
    // Read-only against business data: nothing was written to a customer
    // table. The only insert is the account's own token-usage row.
    expect(fake.rows('messages')).toHaveLength(1);
    expect(fake.rows('enquiries')).toHaveLength(0);
    const written = fake.calls
      .filter((call) => call.operation === 'insert')
      .map((call) => call.table);
    expect(written).toEqual(['ai_usage_log']);
  });

  it('keeps the media boundary enforced on the production path', async () => {
    fetchMock.mockResolvedValue(visionResponse(SOFA_RESULT));
    const { fake, tool } = productionTool([aiConfigRow()], [
      imageMessage(
        'message-1',
        '2026-10-01T10:00:00.000Z',
        'photo-1.jpg',
        { media_url: mediaUrl('photo-1.jpg', `account-${OTHER_ACCOUNT}`) }
      ),
    ]);

    const result = await tool.execute(toolContext(fake.db, ACCOUNT), {
      conversation_id: CONVERSATION,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The object lives in another account's folder, so the bytes never
    // leave the boundary and the provider is never called.
    expect(result.error.code).toBe('forbidden');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a legacy Meta-hosted media pointer before any provider call', async () => {
    fetchMock.mockResolvedValue(visionResponse(SOFA_RESULT));
    const { fake, tool } = productionTool([aiConfigRow()], [
      imageMessage(
        'message-1',
        '2026-10-01T10:00:00.000Z',
        'photo-1.jpg',
        { media_url: '/api/whatsapp/media/1234567890' }
      ),
    ]);

    const result = await tool.execute(toolContext(fake.db, ACCOUNT), {
      conversation_id: CONVERSATION,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still refuses an account_id supplied as tool input', async () => {
    fetchMock.mockResolvedValue(visionResponse(SOFA_RESULT));
    const { fake, tool } = productionTool([aiConfigRow()], [
      imageMessage('message-1', '2026-10-01T10:00:00.000Z', 'photo-1.jpg'),
    ]);

    const result = await tool.execute(toolContext(fake.db, ACCOUNT), {
      conversation_id: CONVERSATION,
      account_id: OTHER_ACCOUNT,
    } as never);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_input');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
