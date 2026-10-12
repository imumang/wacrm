import { beforeEach, describe, expect, it, vi } from 'vitest';

// Verifies that a config save with an omitted/blank verify token keeps the
// stored (encrypted) token through persistence instead of nulling it.

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  existing: { current: null as Record<string, unknown> | null },
  update: vi.fn(),
  insert: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: mocks.getUser },
    from: (table: string) => {
      if (table === 'profiles') {
        const b = {
          select: () => b,
          eq: () => b,
          maybeSingle: async () => ({
            data: { account_id: 'account-1' },
            error: null,
          }),
        };
        return b;
      }
      // whatsapp_config on the user's own client
      const b = {
        select: () => b,
        eq: () => b,
        maybeSingle: async () => ({
          data: mocks.existing.current,
          error: null,
        }),
        update: (row: unknown) => {
          mocks.update(row);
          return { eq: async () => ({ error: null }) };
        },
        insert: async (row: unknown) => {
          mocks.insert(row);
          return { error: null };
        },
      };
      return b;
    },
  }),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => {
    const b = {
      select: () => b,
      eq: () => b,
      neq: () => b,
      maybeSingle: async () => ({ data: null, error: null }),
    };
    return { from: () => b };
  },
}));

vi.mock('@/lib/whatsapp/meta-api', () => ({
  verifyPhoneNumber: async () => ({ id: '123', display_phone_number: '+1' }),
  listWabaPhoneNumbers: async () => [],
  registerPhoneNumber: async () => undefined,
  subscribeWabaToApp: async () => undefined,
  getSubscribedApps: async () => [],
}));

import { decrypt, encrypt } from '@/lib/whatsapp/encryption';
import { POST } from './route';

const STORED = encrypt('stored-verify-token');

function post(body: Record<string, unknown>) {
  return new Request('http://localhost/api/whatsapp/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      phone_number_id: '123456789',
      access_token: 'meta-access-token',
      ...body,
    }),
  });
}

beforeEach(() => {
  mocks.getUser.mockReset().mockResolvedValue({
    data: { user: { id: 'user-1' } },
    error: null,
  });
  mocks.existing.current = {
    id: 'cfg-1',
    registered_at: '2026-01-01T00:00:00Z',
    phone_number_id: '123456789',
    verify_token: STORED,
  };
  mocks.update.mockReset();
  mocks.insert.mockReset();
});

describe('POST /api/whatsapp/config verify token persistence', () => {
  it.each([
    ['omitted', {}],
    ['empty string', { verify_token: '' }],
    ['whitespace', { verify_token: '   ' }],
    ['null', { verify_token: null }],
  ])(
    'preserves the stored token when verify_token is %s',
    async (_n, extra) => {
      const res = await POST(post(extra));
      expect(res.status).toBe(200);
      expect(mocks.update).toHaveBeenCalledTimes(1);
      expect(mocks.update.mock.calls[0][0].verify_token).toBe(STORED);
    }
  );

  it('encrypts and stores a newly supplied token', async () => {
    const res = await POST(post({ verify_token: 'new-token' }));
    expect(res.status).toBe(200);
    const saved = mocks.update.mock.calls[0][0].verify_token as string;
    expect(saved).not.toBe(STORED);
    expect(saved).not.toContain('new-token');
    expect(decrypt(saved)).toBe('new-token');
  });

  it('stores null on first save with no token and no prior row', async () => {
    mocks.existing.current = null;
    const res = await POST(post({}));
    expect(res.status).toBe(200);
    expect(mocks.insert).toHaveBeenCalledTimes(1);
    expect(mocks.insert.mock.calls[0][0].verify_token).toBeNull();
    expect(mocks.insert.mock.calls[0][0].account_id).toBe('account-1');
  });
});
