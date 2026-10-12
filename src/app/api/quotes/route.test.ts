import { beforeEach, describe, expect, it, vi } from 'vitest';

// PATCH-008 third boundary: POST /api/quotes with action 'create_imported'
// is gated by canImportHistoricalData (admin+); 'create_manual' stays agent+.

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  profile: vi.fn(),
  createManualQuote: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: mocks.getUser },
    from: (table: string) => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () =>
          table === 'profiles'
            ? mocks.profile()
            : { data: { id: 'account-1', name: 'Acme' }, error: null },
      };
      return builder;
    },
  }),
}));

vi.mock('@/lib/quotes/service', () => ({
  createQuoteService: () => ({ createManualQuote: mocks.createManualQuote }),
}));

import { POST } from './route';

function signIn(role: string, accountId = 'account-1') {
  mocks.getUser.mockResolvedValue({
    data: { user: { id: 'user-1' } },
    error: null,
  });
  mocks.profile.mockReturnValue({
    data: { account_id: accountId, account_role: role },
    error: null,
  });
}

function post(body: Record<string, unknown>) {
  return new Request('http://localhost/api/quotes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'k-1' },
    body: JSON.stringify(body),
  });
}

const base = { enquiry_id: 'enq-1', proposal: {} };

beforeEach(() => {
  mocks.getUser.mockReset();
  mocks.profile.mockReset();
  mocks.createManualQuote
    .mockReset()
    .mockResolvedValue({ replayed: false, quote: { id: 'q-1' } });
});

describe('POST /api/quotes imported-quote gate', () => {
  it('returns 401 when unauthenticated', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    const res = await POST(post({ ...base, action: 'create_imported' }));
    expect(res.status).toBe(401);
    expect(mocks.createManualQuote).not.toHaveBeenCalled();
  });

  it.each(['viewer', 'agent'])(
    'refuses create_imported for %s without invoking the service',
    async (role) => {
      signIn(role);
      const res = await POST(post({ ...base, action: 'create_imported' }));
      expect(res.status).toBe(403);
      expect(mocks.createManualQuote).not.toHaveBeenCalled();
    }
  );

  it.each(['admin', 'owner'])('allows create_imported for %s', async (role) => {
    signIn(role);
    const res = await POST(post({ ...base, action: 'create_imported' }));
    expect(res.status).toBe(201);
    expect(mocks.createManualQuote.mock.calls[0][0].origin).toBe(
      'imported_historical'
    );
  });

  it('still allows an agent to create_manual', async () => {
    signIn('agent');
    const res = await POST(post({ ...base, action: 'create_manual' }));
    expect(res.status).toBe(201);
    expect(mocks.createManualQuote.mock.calls[0][0].origin).toBe('manual');
  });

  it('rejects client-supplied account/role fields and ignores them', async () => {
    signIn('agent');
    const res = await POST(
      post({
        ...base,
        action: 'create_imported',
        role: 'admin',
        account_id: 'victim',
      })
    );
    expect(res.status).toBe(400);
    expect(mocks.createManualQuote).not.toHaveBeenCalled();
  });

  it('uses the profile account and user for an admin create', async () => {
    signIn('admin', 'account-1');
    await POST(post({ ...base, action: 'create_imported' }));
    const args = mocks.createManualQuote.mock.calls[0][0];
    expect(args.accountId).toBe('account-1');
    expect(args.actorUserId).toBe('user-1');
  });
});
