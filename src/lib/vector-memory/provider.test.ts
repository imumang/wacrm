import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const h = vi.hoisted(() => ({
  embedTextsWithUsage: vi.fn(),
  loadEmbeddingsKey: vi.fn(),
  logAiUsage: vi.fn(),
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

import { AiError } from '@/lib/ai/types';

import {
  VECTOR_EMBEDDING_DIMENSIONS,
  VECTOR_EMBEDDING_MODEL,
  VECTOR_EMBEDDING_MODEL_VERSION,
  VectorMemoryError,
} from './model';
import {
  generateEmbedding,
  generateEmbeddings,
  generateNativeImageEmbedding,
} from './provider';

const db = {} as SupabaseClient;

function vector(n = VECTOR_EMBEDDING_DIMENSIONS): number[] {
  return Array.from({ length: n }, (_, i) => i / n);
}

beforeEach(() => {
  h.loadEmbeddingsKey.mockReset();
  h.embedTextsWithUsage.mockReset();
  h.logAiUsage.mockReset();
  h.loadEmbeddingsKey.mockResolvedValue({ key: 'sk-embeddings', corrupt: false });
  h.embedTextsWithUsage.mockImplementation(async (_k: string, inputs: string[]) => ({
    vectors: inputs.map(() => vector()),
    usage: { promptTokens: 12, completionTokens: 0, totalTokens: 12 },
  }));
  h.logAiUsage.mockResolvedValue(undefined);

  // Hard guarantee for this whole file: no test may reach a real
  // network. If any code path in this module called fetch directly, this
  // would throw rather than silently pass.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('network access is not permitted in tests');
    })
  );
});

afterEach(() => vi.unstubAllGlobals());

describe('generateEmbedding', () => {
  it('embeds with the account embeddings key and returns the compatibility group', async () => {
    const result = await generateEmbedding(db, {
      accountId: 'acct-1',
      kind: 'case_text',
      text: 'job items: sofa',
      semanticInputVersion: 'case-text-v1',
    });

    expect(h.loadEmbeddingsKey).toHaveBeenCalledWith(db, 'acct-1');
    expect(h.embedTextsWithUsage).toHaveBeenCalledTimes(1);
    expect(result.vector).toHaveLength(VECTOR_EMBEDDING_DIMENSIONS);
    expect(result.provider).toBe('openai');
    expect(result.embedding_model).toBe(VECTOR_EMBEDDING_MODEL);
    expect(result.model_version).toBe(VECTOR_EMBEDDING_MODEL_VERSION);
    expect(result.dimensions).toBe(VECTOR_EMBEDDING_DIMENSIONS);
    expect(result.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.kind).toBe('case_text');
  });

  it('records spend in the existing ai_usage_log trail with mode embeddings', async () => {
    await generateEmbedding(db, {
      accountId: 'acct-1',
      kind: 'case_text',
      text: 'job items: sofa',
      semanticInputVersion: 'case-text-v1',
    });

    expect(h.logAiUsage).toHaveBeenCalledTimes(1);
    const call = h.logAiUsage.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(call.mode).toBe('embeddings');
    expect(call.accountId).toBe('acct-1');
    expect(call.model).toBe(VECTOR_EMBEDDING_MODEL);
    // Vector memory belongs to a case, not a conversation.
    expect(call.conversationId).toBeNull();
    expect(call.usage).toEqual({
      promptTokens: 12,
      completionTokens: 0,
      totalTokens: 12,
    });
  });

  it('never logs vector values or the semantic text', async () => {
    await generateEmbedding(db, {
      accountId: 'acct-1',
      kind: 'case_text',
      text: 'job items: sofa; armchair',
      semanticInputVersion: 'case-text-v1',
    });

    const logged = JSON.stringify(h.logAiUsage.mock.calls);
    expect(logged).not.toContain('sofa');
    expect(logged).not.toContain('armchair');
    expect(logged).not.toContain('0.0');
  });

  it('reports an account with no embeddings key as unavailable', async () => {
    h.loadEmbeddingsKey.mockResolvedValue({ key: null, corrupt: false });
    await expect(
      generateEmbedding(db, {
        accountId: 'acct-1',
        kind: 'case_text',
        text: 'job items: sofa',
        semanticInputVersion: 'case-text-v1',
      })
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(h.embedTextsWithUsage).not.toHaveBeenCalled();
  });

  it('distinguishes a corrupt key from an absent one', async () => {
    h.loadEmbeddingsKey.mockResolvedValue({ key: null, corrupt: true });
    const error = await generateEmbedding(db, {
      accountId: 'acct-1',
      kind: 'case_text',
      text: 'job items: sofa',
      semanticInputVersion: 'case-text-v1',
    }).catch((e: unknown) => e as VectorMemoryError);
    expect((error as VectorMemoryError).message).toMatch(/decrypted/i);
  });

  it('maps a provider timeout to a typed provider error', async () => {
    h.embedTextsWithUsage.mockRejectedValue(
      new AiError('The AI provider took too long to respond.', {
        code: 'timeout',
        status: 504,
      })
    );
    await expect(
      generateEmbedding(db, {
        accountId: 'acct-1',
        kind: 'case_text',
        text: 'job items: sofa',
        semanticInputVersion: 'case-text-v1',
      })
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('maps a provider cancellation to a typed provider error', async () => {
    h.embedTextsWithUsage.mockRejectedValue(
      new AiError('Could not reach the AI provider: aborted', {
        code: 'network_error',
        status: 502,
      })
    );
    await expect(
      generateEmbedding(db, {
        accountId: 'acct-1',
        kind: 'case_text',
        text: 'job items: sofa',
        semanticInputVersion: 'case-text-v1',
      })
    ).rejects.toMatchObject({ code: 'network_error' });
  });

  it('surfaces a sanitized provider error without leaking the key', async () => {
    h.embedTextsWithUsage.mockRejectedValue(
      new AiError('OpenAI rejected the API key', { code: 'invalid_key' })
    );
    const error = await generateEmbedding(db, {
      accountId: 'acct-1',
      kind: 'case_text',
      text: 'job items: sofa',
      semanticInputVersion: 'case-text-v1',
    }).catch((e: unknown) => e as VectorMemoryError);
    expect((error as Error).message).not.toContain('sk-embeddings');
    expect((error as AiError).code).toBe('invalid_key');
  });

  it('refuses a vector with the wrong dimensions', async () => {
    h.embedTextsWithUsage.mockResolvedValue({
      vectors: [vector(256)],
      usage: null,
    });
    await expect(
      generateEmbedding(db, {
        accountId: 'acct-1',
        kind: 'case_text',
        text: 'job items: sofa',
        semanticInputVersion: 'case-text-v1',
      })
    ).rejects.toThrow(/256 dimensions/);
  });

  it('refuses a response with the wrong number of vectors', async () => {
    h.embedTextsWithUsage.mockResolvedValue({ vectors: [], usage: null });
    await expect(
      generateEmbedding(db, {
        accountId: 'acct-1',
        kind: 'case_text',
        text: 'job items: sofa',
        semanticInputVersion: 'case-text-v1',
      })
    ).rejects.toThrow(/different number of vectors/i);
  });

  it('refuses empty semantic input before spending anything', async () => {
    await expect(
      generateEmbedding(db, {
        accountId: 'acct-1',
        kind: 'case_text',
        text: '   ',
        semanticInputVersion: 'case-text-v1',
      })
    ).rejects.toThrow(/empty semantic input/i);
    expect(h.embedTextsWithUsage).not.toHaveBeenCalled();
    expect(h.loadEmbeddingsKey).not.toHaveBeenCalled();
  });

  it('passes the caller signal through for cancellation', async () => {
    const controller = new AbortController();
    await generateEmbedding(db, {
      accountId: 'acct-1',
      kind: 'case_text',
      text: 'job items: sofa',
      semanticInputVersion: 'case-text-v1',
      signal: controller.signal,
    });
    const options = h.embedTextsWithUsage.mock.calls[0]?.[2] as
      | { signal?: AbortSignal }
      | undefined;
    expect(options?.signal).toBe(controller.signal);
  });

  it('skips the usage row when the provider reports no usage', async () => {
    h.embedTextsWithUsage.mockResolvedValue({
      vectors: [vector()],
      usage: null,
    });
    await generateEmbedding(db, {
      accountId: 'acct-1',
      kind: 'case_text',
      text: 'job items: sofa',
      semanticInputVersion: 'case-text-v1',
    });
    expect(h.logAiUsage).not.toHaveBeenCalled();
  });
});

describe('generateEmbeddings', () => {
  it('makes no provider call for an empty batch', async () => {
    expect(await generateEmbeddings(db, {
      accountId: 'acct-1',
      kind: 'case_text',
      texts: [],
      semanticInputVersion: 'case-text-v1',
    })).toEqual([]);
    expect(h.embedTextsWithUsage).not.toHaveBeenCalled();
  });

  it('batches and returns one vector per input, in order', async () => {
    h.embedTextsWithUsage.mockImplementation(
      async (_k: string, inputs: string[]) => ({
        vectors: inputs.map((_t, i) =>
          Array.from({ length: VECTOR_EMBEDDING_DIMENSIONS }, () => i)
        ),
        usage: { promptTokens: 30, completionTokens: 0, totalTokens: 30 },
      })
    );
    const out = await generateEmbeddings(db, {
      accountId: 'acct-1',
      kind: 'case_text',
      texts: ['one', 'two'],
      semanticInputVersion: 'case-text-v1',
    });
    expect(out).toHaveLength(2);
    expect(out[0]?.vector[0]).toBe(0);
    expect(out[1]?.vector[0]).toBe(1);
    // One request, not one per input.
    expect(h.embedTextsWithUsage).toHaveBeenCalledTimes(1);
  });
});

describe('generateNativeImageEmbedding', () => {
  it('refuses with an unsupported error rather than approximating', async () => {
    await expect(generateNativeImageEmbedding()).rejects.toMatchObject({
      code: 'unsupported',
    });
  });

  it('never falls back to embedding observation text', async () => {
    const error = await generateNativeImageEmbedding().catch(
      (e: unknown) => e as VectorMemoryError
    );
    expect((error as Error).message).toMatch(/image_observation_text/);
    expect((error as Error).message).toMatch(/never label it native_image/);
    expect(h.embedTextsWithUsage).not.toHaveBeenCalled();
    expect(h.loadEmbeddingsKey).not.toHaveBeenCalled();
  });
});
