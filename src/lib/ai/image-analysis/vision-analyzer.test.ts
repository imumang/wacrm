/**
 * Objective 08 — the production vision adapter.
 *
 * Every provider interaction is mocked. These tests never reach OpenAI or
 * Anthropic, never spend a token, and never need a real credential: the
 * account config is built from the same `ai_configs` shape the app uses,
 * encrypted with the test `ENCRYPTION_KEY` so `loadAiConfig` behaves
 * exactly as it does in production.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { encrypt } from '@/lib/whatsapp/encryption';
import {
  IMAGE_ANALYSIS_LIMITS,
  VISION_ANALYZER_ID,
  buildVisionSystemPrompt,
  createVisionImageAnalyzer,
  getConfiguredImageAnalyzer,
  parseProviderJson,
  type ImageAnalysisContext,
  type ImageAnalyzer,
  type ImageAnalyzerResolverArgs,
  type SupportedImageMimeType,
} from '@/lib/ai/image-analysis';

import { fakeToolDatabase } from '../tools/test-support';
import type { AiConfig } from '../types';

const ACCOUNT = '3f1b2c40-1111-4222-8333-444455556666';
const OTHER_ACCOUNT = '99999999-9999-4999-8999-888888888888';
const CONVERSATION = 'conversation-1';
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const API_KEY = 'sk-test-vision-key';

const SOFA_RESULT = {
  observations: [
    {
      kind: 'furniture',
      label: 'three-seat sofa',
      confidence: 0.82,
      basis: 'observed',
      approximate_count: { value: 1, confidence: 0.9 },
      source_indexes: [1],
    },
  ],
  ambiguous_items: [],
  image_quality: [],
  estimated_volume_range: null,
  need_more_photos: false,
  follow_up_questions: [],
  notes: [],
};

const CONTEXT: ImageAnalysisContext = {
  origin: 'customer_statement',
  enquiry_id: 'enquiry-1',
  item_descriptions: ['old sofa'],
  waste_type: null,
  estimated_volume: null,
  heavy_special_items: [],
  access_constraints: [],
  property_type: null,
  floor: null,
  lift_available: null,
  parking: null,
};

/** An `ai_configs` row in the exact production shape. */
function configRow(overrides: Record<string, unknown> = {}) {
  return {
    account_id: ACCOUNT,
    provider: 'openai',
    model: 'gpt-5.4-mini',
    api_key: encrypt(API_KEY),
    system_prompt: null,
    is_active: true,
    auto_reply_enabled: false,
    auto_reply_max_per_conversation: 3,
    handoff_agent_id: null,
    embeddings_api_key: null,
    ...overrides,
  };
}

/** A decrypted, in-memory `AiConfig` — the shape `loadAiConfig` returns. */
function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-5.4-mini',
    baseUrl: null,
    apiKey: API_KEY,
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: false,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    ...overrides,
  };
}

function resolverArgs(
  db: ReturnType<typeof fakeToolDatabase>['db'],
  overrides: Partial<ImageAnalyzerResolverArgs> = {}
): ImageAnalyzerResolverArgs {
  return {
    db,
    account_id: ACCOUNT,
    conversation_id: CONVERSATION,
    correlation_id: 'run-1',
    ...overrides,
  };
}

function image(ordinal: number, mime: SupportedImageMimeType = 'image/jpeg') {
  return {
    source: {
      ordinal,
      source_message_id: `message-${ordinal}`,
      source_media_id: `account-${ACCOUNT}/inbound/photo-${ordinal}.jpg`,
    },
    mime_type: mime,
    byte_length: JPEG_BYTES.byteLength,
    bytes: JPEG_BYTES,
  };
}

function openAiBody(result: unknown, usage = true) {
  return {
    choices: [{ message: { content: JSON.stringify(result) }, finish_reason: 'stop' }],
    ...(usage
      ? {
          usage: {
            prompt_tokens: 1_200,
            completion_tokens: 300,
            total_tokens: 1_500,
          },
        }
      : {}),
  };
}

function anthropicBody(result: unknown, usage = true) {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    stop_reason: 'end_turn',
    ...(usage ? { usage: { input_tokens: 1_200, output_tokens: 300 } } : {}),
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('vision analyzer — provider selection', () => {
  it('sends a vision request to the account-configured OpenAI provider', async () => {
    fetchMock.mockResolvedValue(jsonResponse(openAiBody(SOFA_RESULT)));
    const analyzer = createVisionImageAnalyzer({
      config: aiConfig(),
    }) as ImageAnalyzer;

    const result = await analyzer.analyze({
      images: [image(1)],
      context: null,
    });

    expect(analyzer.id).toBe(VISION_ANALYZER_ID);
    expect(result).toEqual(SOFA_RESULT);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('api.openai.com');
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${API_KEY}` });

    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('gpt-5.4-mini');
    expect(body.response_format).toEqual({ type: 'json_object' });
    // The system prompt carries the evidence rules; the user turn carries
    // the images. Nothing else is in the payload.
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('system');
  });

  it('sends a vision request to the account-configured Anthropic provider', async () => {
    fetchMock.mockResolvedValue(jsonResponse(anthropicBody(SOFA_RESULT)));
    const analyzer = createVisionImageAnalyzer({
      config: aiConfig({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }),
    }) as ImageAnalyzer;

    await analyzer.analyze({ images: [image(1)], context: null });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('api.anthropic.com');
    expect(init.headers).toMatchObject({
      'x-api-key': API_KEY,
      'anthropic-version': expect.any(String),
    });

    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('claude-haiku-4-5-20251001');
    expect(body.system).toContain('relative_volume_units');
    expect(body.messages[0].content[0]).toMatchObject({ type: 'image' });
  });

  it('returns null rather than guessing when the provider is unsupported', () => {
    const analyzer = createVisionImageAnalyzer({
      config: aiConfig({ provider: 'unsupported' as never }),
    });
    expect(analyzer).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null when no model or key is configured', () => {
    expect(
      createVisionImageAnalyzer({ config: aiConfig({ model: '  ' }) }),
    ).toBeNull();
    expect(
      createVisionImageAnalyzer({ config: aiConfig({ apiKey: '' }) }),
    ).toBeNull();
  });
});

describe('vision analyzer — image payload', () => {
  it('inlines each image as base64 and never a URL or storage path', async () => {
    fetchMock.mockResolvedValue(jsonResponse(openAiBody(SOFA_RESULT)));
    const analyzer = createVisionImageAnalyzer({
      config: aiConfig(),
    }) as ImageAnalyzer;

    await analyzer.analyze({
      images: [image(1, 'image/jpeg'), image(2, 'image/png')],
      context: CONTEXT,
    });

    const body = JSON.parse(
      String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body),
    );
    const parts = body.messages[1].content as Array<Record<string, unknown>>;
    const images = parts.filter((part) => part.type === 'image_url');

    expect(images).toHaveLength(2);
    expect(images[0]?.image_url).toEqual({
      url: `data:image/jpeg;base64,${Buffer.from(JPEG_BYTES).toString('base64')}`,
    });
    expect(images[1]?.image_url).toMatchObject({
      url: expect.stringContaining('data:image/png;base64,'),
    });

    const serialized = JSON.stringify(body);
    // No location, identity, or credential ever reaches the provider.
    expect(serialized).not.toContain('supabase.co');
    expect(serialized).not.toContain('account-');
    expect(serialized).not.toContain('message-1');
    expect(serialized).not.toContain(ACCOUNT);
    expect(serialized).not.toContain('enquiry-1');
    expect(serialized).not.toContain(API_KEY);
  });

  it('keeps one image block per photograph for Anthropic', async () => {
    fetchMock.mockResolvedValue(jsonResponse(anthropicBody(SOFA_RESULT)));
    const analyzer = createVisionImageAnalyzer({
      config: aiConfig({ provider: 'anthropic' }),
    }) as ImageAnalyzer;

    await analyzer.analyze({ images: [image(1), image(2)], context: null });

    const body = JSON.parse(
      String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body),
    );
    const blocks = body.messages[0].content as Array<Record<string, unknown>>;
    expect(blocks.filter((block) => block.type === 'image')).toHaveLength(2);
    expect(blocks.filter((block) => block.type === 'image')[0]).toMatchObject({
      source: { type: 'base64', media_type: 'image/jpeg' },
    });
  });

  it('refuses an empty image set without calling a provider', async () => {
    const analyzer = createVisionImageAnalyzer({
      config: aiConfig(),
    }) as ImageAnalyzer;

    await expect(
      analyzer.analyze({ images: [], context: null }),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('vision analyzer — prompt guarantees', () => {
  it('states every evidence rule the validator depends on', () => {
    const prompt = buildVisionSystemPrompt();

    for (const rule of [
      'visible',
      'ambiguous',
      'approximate_count',
      'relative_volume_units',
      'Never state or imply a price',
      'Never state or imply a weight',
      'Never infer property',
      'obstruction',
      'need_more_photos',
      'source_indexes',
    ]) {
      expect(prompt).toContain(rule);
    }
    // The schema names must match `result.ts` exactly or the validator
    // rejects every observation.
    expect(prompt).toContain(
      'observations, ambiguous_items, image_quality, estimated_volume_range, need_more_photos, follow_up_questions, notes',
    );
    expect(prompt).toContain(String(IMAGE_ANALYSIS_LIMITS.max_observations));
  });

  it('labels customer-stated context as untrusted and bounds it', async () => {
    const analyzer = createVisionImageAnalyzer({
      config: aiConfig(),
    }) as ImageAnalyzer;
    fetchMock.mockResolvedValue(jsonResponse(openAiBody(SOFA_RESULT)));

    await analyzer.analyze({
      images: [image(1)],
      context: {
        ...CONTEXT,
        item_descriptions: ['x'.repeat(5_000)],
      },
    });

    const body = JSON.parse(
      String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body),
    );
    const userText = body.messages[1].content[0].text as string;
    expect(userText).toContain('untrusted');
    expect(userText).toContain('1 customer photograph');
    expect(userText).not.toContain('enquiry_id');
    expect(userText.length).toBeLessThan(1_000);
  });

  it('omits the context block entirely when the caller opted out', async () => {
    fetchMock.mockResolvedValue(jsonResponse(openAiBody(SOFA_RESULT)));
    const analyzer = createVisionImageAnalyzer({
      config: aiConfig(),
    }) as ImageAnalyzer;

    await analyzer.analyze({ images: [image(1)], context: null });

    const body = JSON.parse(
      String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body),
    );
    expect(String(body.messages[1].content[0].text)).not.toContain(
      'Customer-stated context',
    );
  });
});

describe('vision analyzer — structured output', () => {
  it('returns the provider answer unvalidated so the strict validator decides', async () => {
    const resultWithJunk = {
      ...SOFA_RESULT,
      price_estimate: 240,
      unknown_field: true,
    };
    fetchMock.mockResolvedValue(jsonResponse(openAiBody(resultWithJunk)));
    const analyzer = createVisionImageAnalyzer({
      config: aiConfig(),
    }) as ImageAnalyzer;

    // The adapter neither strips nor repairs: `parseImageAnalysisResult`
    // is the only thing allowed to reject, and it does.
    await expect(
      analyzer.analyze({ images: [image(1)], context: null }),
    ).resolves.toEqual(resultWithJunk);
  });

  it('refuses a length-truncated answer rather than parsing a fragment', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        choices: [
          { message: { content: '{"observations":[' }, finish_reason: 'length' },
        ],
      }),
    );
    const analyzer = createVisionImageAnalyzer({
      config: aiConfig(),
    }) as ImageAnalyzer;

    await expect(
      analyzer.analyze({ images: [image(1)], context: null }),
    ).rejects.toThrow(/truncated/i);
  });

  it('refuses a length-truncated Anthropic answer', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        content: [{ type: 'text', text: '{"observations":[' }],
        stop_reason: 'max_tokens',
      }),
    );
    const analyzer = createVisionImageAnalyzer({
      config: aiConfig({ provider: 'anthropic' }),
    }) as ImageAnalyzer;

    await expect(
      analyzer.analyze({ images: [image(1)], context: null }),
    ).rejects.toThrow(/truncated/i);
  });

  it('rejects an empty provider answer', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        choices: [{ message: {}, finish_reason: 'stop' }],
      }),
    );
    const analyzer = createVisionImageAnalyzer({
      config: aiConfig(),
    }) as ImageAnalyzer;

    await expect(
      analyzer.analyze({ images: [image(1)], context: null }),
    ).rejects.toThrow(/empty/i);
  });

  it('unwraps a code fence but repairs nothing else', () => {
    expect(parseProviderJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseProviderJson('  {"a":1}  ')).toEqual({ a: 1 });
    expect(() => parseProviderJson('here you go: {"a":1}')).toThrow(
      /not valid JSON/i,
    );
  });
});

describe('vision analyzer — timeout, cancellation, and error sanitization', () => {
  it('aborts the provider request when its own deadline elapses', async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }),
      );
      const analyzer = createVisionImageAnalyzer({
        config: aiConfig(),
        timeoutMs: 10,
      }) as ImageAnalyzer;

      const pending = analyzer
        .analyze({ images: [image(1)], context: null })
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(20);

      expect(await pending).toBeTruthy();
      const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
      expect(init.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates caller cancellation into the provider request', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const analyzer = createVisionImageAnalyzer({
      config: aiConfig(),
    }) as ImageAnalyzer;

    const pending = analyzer.analyze({
      images: [image(1)],
      context: null,
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toBeTruthy();
    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
    expect(init.signal?.aborted).toBe(true);
  });

  it('does not call a provider when the caller signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const analyzer = createVisionImageAnalyzer({
      config: aiConfig(),
    }) as ImageAnalyzer;

    await expect(
      analyzer.analyze({
        images: [image(1)],
        context: null,
        signal: controller.signal,
      }),
    ).rejects.toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps a provider HTTP failure to a typed error that carries no detail', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          error: {
            message:
              'Incorrect API key provided: sk-test-vision-key. See https://example.invalid/keys',
          },
        },
        false,
        401,
      ),
    );
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const analyzer = createVisionImageAnalyzer({
      config: aiConfig(),
      observability: {
        accountId: ACCOUNT,
        conversationId: CONVERSATION,
        correlationId: 'run-1',
      },
    }) as ImageAnalyzer;

    await expect(
      analyzer.analyze({ images: [image(1)], context: null }),
    ).rejects.toMatchObject({ code: 'invalid_key' });

    // The provider's message reached neither the log nor the caller's log
    // record: only a safe code/status.
    expect(JSON.stringify(info.mock.calls)).toContain('invalid_key');
    expect(JSON.stringify(info.mock.calls)).not.toContain('Incorrect API key');
    expect(JSON.stringify(info.mock.calls)).not.toContain(API_KEY);
    expect(JSON.stringify(error.mock.calls)).not.toContain('Incorrect API key');
  });

  it('maps a network failure to a typed error', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const analyzer = createVisionImageAnalyzer({
      config: aiConfig(),
    }) as ImageAnalyzer;

    await expect(
      analyzer.analyze({ images: [image(1)], context: null }),
    ).rejects.toBeTruthy();
  });
});

describe('vision analyzer — observability', () => {
  it('reports provider, model, image count, duration, outcome and tokens only', async () => {
    fetchMock.mockResolvedValue(jsonResponse(openAiBody(SOFA_RESULT)));
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const analyzer = createVisionImageAnalyzer({
      config: aiConfig(),
      observability: {
        accountId: ACCOUNT,
        conversationId: CONVERSATION,
        correlationId: 'run-9',
      },
    }) as ImageAnalyzer;

    await analyzer.analyze({ images: [image(1), image(2)], context: CONTEXT });

    const payload = JSON.parse(JSON.stringify(info.mock.calls[0]?.[1]));
    expect(payload).toMatchObject({
      account_id: ACCOUNT,
      conversation_id: CONVERSATION,
      correlation_id: 'run-9',
      provider: 'openai',
      model: 'gpt-5.4-mini',
      image_count: 2,
      outcome: 'success',
      prompt_tokens: 1_200,
      completion_tokens: 300,
      total_tokens: 1_500,
    });
    expect(payload.duration_ms).toBeGreaterThanOrEqual(0);
    // Nothing customer-derived.
    expect(JSON.stringify(info.mock.calls)).not.toContain('sofa');
    expect(JSON.stringify(info.mock.calls)).not.toContain('account-1/inbound');
    expect(JSON.stringify(info.mock.calls)).not.toContain(API_KEY);
  });

  it('reports token usage through the supplied hook', async () => {
    fetchMock.mockResolvedValue(jsonResponse(openAiBody(SOFA_RESULT)));
    const onUsage = vi.fn();
    const analyzer = createVisionImageAnalyzer({
      config: aiConfig(),
      onUsage,
    }) as ImageAnalyzer;

    await analyzer.analyze({ images: [image(1)], context: null });

    expect(onUsage).toHaveBeenCalledWith({
      promptTokens: 1_200,
      completionTokens: 300,
      totalTokens: 1_500,
    });
  });

  it('does not report usage the provider did not return', async () => {
    fetchMock.mockResolvedValue(jsonResponse(openAiBody(SOFA_RESULT, false)));
    const onUsage = vi.fn();
    const analyzer = createVisionImageAnalyzer({
      config: aiConfig(),
      onUsage,
    }) as ImageAnalyzer;

    await analyzer.analyze({ images: [image(1)], context: null });
    expect(onUsage).not.toHaveBeenCalled();
  });
});

describe('getConfiguredImageAnalyzer — account configuration isolation', () => {
  it('returns a configured analyzer for an account with active AI config', async () => {
    const fake = fakeToolDatabase({
      ai_configs: [configRow()],
    });

    const analyzer = await getConfiguredImageAnalyzer(resolverArgs(fake.db));
    expect(analyzer?.id).toBe(VISION_ANALYZER_ID);
  });

  it('returns null when the account has no AI configuration', async () => {
    const fake = fakeToolDatabase({ ai_configs: [] });
    expect(await getConfiguredImageAnalyzer(resolverArgs(fake.db))).toBeNull();
  });

  it('returns null when the account master switch is off', async () => {
    const fake = fakeToolDatabase({
      ai_configs: [configRow({ is_active: false })],
    });
    expect(await getConfiguredImageAnalyzer(resolverArgs(fake.db))).toBeNull();
  });

  it('fails closed rather than proceeding when the stored key cannot be decrypted', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fake = fakeToolDatabase({
      ai_configs: [configRow({ api_key: 'not-encrypted' })],
    });

    // Not `null`: an unreadable config is a distinguishable failure, so the
    // operator sees "could not be read" rather than a silent absence.
    await expect(getConfiguredImageAnalyzer(resolverArgs(fake.db))).rejects.toMatchObject(
      { code: 'unavailable', retryable: true },
    );
    expect(JSON.stringify(consoleError.mock.calls)).toContain(ACCOUNT);
  });

  it('never resolves another account’s configuration', async () => {
    const fake = fakeToolDatabase({
      ai_configs: [configRow({ account_id: OTHER_ACCOUNT })],
    });

    expect(await getConfiguredImageAnalyzer(resolverArgs(fake.db))).toBeNull();
    // The read was scoped to the requested account, not "the only row".
    const configRead = fake.calls.find((call) => call.table === 'ai_configs');
    expect(configRead?.filters).toContainEqual({
      kind: 'eq',
      column: 'account_id',
      value: ACCOUNT,
    });
  });

  it('reports a configuration read failure as retryable, not as absent', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const brokenDb = {
      from() {
        return {
          select() {
            return {
              eq() {
                return {
                  async maybeSingle() {
                    return { data: null, error: { message: 'boom' } };
                  },
                };
              },
            };
          },
        };
      },
    } as never;

    await expect(
      getConfiguredImageAnalyzer(resolverArgs(brokenDb)),
    ).rejects.toMatchObject({ code: 'unavailable', retryable: true });
  });

  it('records vision spend in the shared usage log under image_analysis', async () => {
    const fake = fakeToolDatabase({
      ai_configs: [configRow()],
      conversations: [{ id: CONVERSATION, account_id: ACCOUNT }],
      ai_usage_log: [],
    });
    fetchMock.mockResolvedValue(jsonResponse(openAiBody(SOFA_RESULT)));

    const analyzer = await getConfiguredImageAnalyzer(resolverArgs(fake.db));
    await analyzer?.analyze({ images: [image(1)], context: null });
    // `logAiUsage` is fire-and-forget; let its insert promise settle.
    await vi.waitFor(() => expect(fake.rows('ai_usage_log')).toHaveLength(1));

    expect(fake.rows('ai_usage_log')[0]).toMatchObject({
      account_id: ACCOUNT,
      conversation_id: CONVERSATION,
      mode: 'image_analysis',
      provider: 'openai',
      model: 'gpt-5.4-mini',
      prompt_tokens: 1_200,
      completion_tokens: 300,
      total_tokens: 1_500,
    });
  });
});

describe('getConfiguredImageAnalyzer — no outbound send', () => {
  it('performs exactly one provider call and reaches no other host', async () => {
    fetchMock.mockResolvedValue(jsonResponse(openAiBody(SOFA_RESULT)));
    const fake = fakeToolDatabase({
      ai_configs: [configRow()],
      conversations: [{ id: CONVERSATION, account_id: ACCOUNT }],
    });

    const analyzer = await getConfiguredImageAnalyzer(resolverArgs(fake.db));
    await analyzer?.analyze({ images: [image(1)], context: CONTEXT });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/^https:\/\/api\.openai\.com\//);
    // A Meta send would need an outbound message endpoint and a
    // conversation-scoped send token; neither is present.
    expect(JSON.stringify(init.body)).not.toContain('graph.facebook.com');
    expect(Object.keys(init.headers as Record<string, string>)).toEqual([
      'Authorization',
      'Content-Type',
    ]);
  });
});
