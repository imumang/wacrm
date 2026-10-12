import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  isCompatibleProviderEnabled,
  isProviderAllowed,
  assertProviderAllowed,
} from './compatible-provider-gate'
import { generateReply } from './generate'
import { generateOpenAiCompatible } from './providers/openai-compatible'
import type { AiConfig } from './types'

function config(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai_compatible',
    model: 'm',
    apiKey: 'k',
    baseUrl: 'https://api.example.com/v1',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    ...overrides,
  }
}

vi.mock('./providers/openai-compatible', async (orig) => ({
  ...(await orig<typeof import('./providers/openai-compatible')>()),
  generateOpenAiCompatible: vi.fn(),
}))

const ok = (json: unknown) =>
  ({ ok: true, status: 200, json: async () => json }) as unknown as Response

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
  vi.stubEnv('AI_COMPATIBLE_PROVIDER_ENABLED', '')
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('compatible provider gate', () => {
  it('is off unless the flag is exactly "true"', () => {
    expect(isCompatibleProviderEnabled()).toBe(false)
    for (const v of ['1', 'TRUE', 'yes', ' true']) {
      vi.stubEnv('AI_COMPATIBLE_PROVIDER_ENABLED', v)
      expect(isCompatibleProviderEnabled()).toBe(false)
    }
    vi.stubEnv('AI_COMPATIBLE_PROVIDER_ENABLED', 'true')
    expect(isCompatibleProviderEnabled()).toBe(true)
  })

  it('only gates openai_compatible', () => {
    expect(isProviderAllowed('openai')).toBe(true)
    expect(isProviderAllowed('anthropic')).toBe(true)
    expect(isProviderAllowed('openai_compatible')).toBe(false)
    expect(() => assertProviderAllowed('openai_compatible')).toThrow(
      expect.objectContaining({ code: 'provider_disabled', status: 403 }),
    )
  })

  it('generateReply refuses a persisted compatible config with no fetch', async () => {
    await expect(
      generateReply({ config: config(), systemPrompt: 's', messages: [] }),
    ).rejects.toMatchObject({ code: 'provider_disabled' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('generateReply still reaches openai and anthropic with the gate off', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      ok({ choices: [{ message: { content: 'hi' } }], usage: {} }),
    )
    const r = await generateReply({
      config: config({ provider: 'openai', baseUrl: null }),
      systemPrompt: 's',
      messages: [{ role: 'user', content: 'x' }],
    })
    expect(r.text).toBe('hi')

    vi.mocked(fetch).mockResolvedValueOnce(
      ok({ content: [{ type: 'text', text: 'yo' }], usage: {} }),
    )
    const a = await generateReply({
      config: config({ provider: 'anthropic', baseUrl: null }),
      systemPrompt: 's',
      messages: [{ role: 'user', content: 'x' }],
    })
    expect(a.text).toBe('yo')
  })

  it('gate on: compatible dispatch reaches the adapter (future approval path)', async () => {
    vi.stubEnv('AI_COMPATIBLE_PROVIDER_ENABLED', 'true')
    vi.mocked(generateOpenAiCompatible).mockResolvedValueOnce({
      text: 'hello',
      usage: null,
    })
    const r = await generateReply({
      config: config(),
      systemPrompt: 's',
      messages: [{ role: 'user', content: 'x' }],
    })
    expect(r.text).toBe('hello')
    expect(generateOpenAiCompatible).toHaveBeenCalledTimes(1)
  })

  it('gate off: adapter is never invoked', async () => {
    await expect(
      generateReply({ config: config(), systemPrompt: 's', messages: [] }),
    ).rejects.toMatchObject({ code: 'provider_disabled' })
    expect(generateOpenAiCompatible).not.toHaveBeenCalled()
  })
})
