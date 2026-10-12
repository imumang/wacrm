import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({
  fromCalls: [] as string[],
}))

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      body,
      status: init?.status ?? 200,
    }),
  },
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: vi.fn(async () => ({
    supabase: {
      from: (table: string) => {
        h.fromCalls.push(table)
        throw new Error('db must not be touched for a gated provider')
      },
    },
    accountId: 'acc-1',
    userId: 'u-1',
  })),
  getCurrentAccount: vi.fn(),
  toErrorResponse: (e: unknown) => ({ body: { error: String(e) }, status: 500 }),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: vi.fn(),
  RATE_LIMITS: { adminAction: {} },
}))

import { POST as configPost } from './route'
import { POST as testPost } from '../test/route'

const req = (body: unknown) =>
  new Request('http://localhost/api/ai/config', {
    method: 'POST',
    body: JSON.stringify(body),
  })

const crafted = {
  provider: 'openai_compatible',
  model: 'm',
  base_url: 'https://api.example.com/v1',
  api_key: 'k',
  is_active: true,
  auto_reply_enabled: true,
}

beforeEach(() => {
  h.fromCalls.length = 0
  vi.stubGlobal('fetch', vi.fn())
  vi.stubEnv('AI_COMPATIBLE_PROVIDER_ENABLED', '')
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('openai_compatible gate at the API', () => {
  it('rejects a crafted config save with 403 before DB or network', async () => {
    const res = (await configPost(req(crafted))) as unknown as {
      status: number
      body: { code: string }
    }
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('provider_disabled')
    expect(h.fromCalls).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects a crafted test request with 403 and no outbound call', async () => {
    const res = (await testPost(req(crafted))) as unknown as {
      status: number
      body: { code: string }
    }
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('provider_disabled')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not reject openai at the gate (proceeds to normal handling)', async () => {
    const res = (await configPost(
      req({ ...crafted, provider: 'openai', base_url: null }),
    )) as unknown as { status: number; body: { code?: string } }
    expect(res.body.code).not.toBe('provider_disabled')
  })
})
