import { beforeEach, describe, expect, it, vi } from 'vitest';

// PATCH-008: route-level authorization gate for vector-memory generation.
// Only the Supabase server client and the domain service/repository are
// faked; the real requireRole / getCurrentAccount / role helpers run.

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  profile: vi.fn(),
  run: vi.fn(),
  coverage: vi.fn(),
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

vi.mock('@/lib/vector-memory/service', () => ({
  VECTOR_MEMORY_OPERATION_MODES: ['missing', 'stale', 'all'],
  runCaseEmbeddingOperation: mocks.run,
}));

vi.mock('@/lib/vector-memory/repository', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/vector-memory/repository')>()),
  countEmbeddingCoverage: mocks.coverage,
}));

import { GET, POST } from './route';

const opResult = {
  correlation_id: 'c-1',
  mode: 'missing',
  dry_run: true,
  has_more: false,
  next_offset: 0,
  examined: 0,
  generated: 0,
  up_to_date: 0,
  skipped: 0,
  ineligible: 0,
  findings: [],
  outcomes: [],
};

function signIn(role: string | null, accountId = 'account-1') {
  mocks.getUser.mockResolvedValue({
    data: { user: { id: 'user-1' } },
    error: null,
  });
  mocks.profile.mockReturnValue({
    data: { account_id: accountId, account_role: role },
    error: null,
  });
}

function post(body: unknown) {
  return new Request('http://localhost/api/vector-memory', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mocks.getUser.mockReset();
  mocks.profile.mockReset();
  mocks.run.mockReset().mockResolvedValue(opResult);
  mocks.coverage.mockReset().mockResolvedValue({ total: 0 });
});

describe('POST /api/vector-memory authorization', () => {
  it('returns 401 when unauthenticated and invokes nothing', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    const res = await POST(post({ mode: 'missing', dry_run: false }));
    expect(res.status).toBe(401);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it.each(['viewer', 'agent'])(
    'returns 403 for %s without invoking the service',
    async (role) => {
      signIn(role);
      const res = await POST(post({ mode: 'missing', dry_run: false }));
      expect(res.status).toBe(403);
      expect(mocks.run).not.toHaveBeenCalled();
    }
  );

  it('returns 403 when the profile has no role (fails closed)', async () => {
    signIn(null);
    const res = await POST(post({ mode: 'missing', dry_run: false }));
    expect(res.status).toBe(403);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it.each(['admin', 'owner'])('allows %s to run a real pass', async (role) => {
    signIn(role);
    const res = await POST(post({ mode: 'missing', dry_run: false }));
    expect(res.status).toBe(200);
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(mocks.run.mock.calls[0][1].dryRun).toBe(false);
  });

  it('defaults to a dry run for an admin', async () => {
    signIn('admin');
    const res = await POST(post({ mode: 'missing' }));
    expect(res.status).toBe(200);
    expect(mocks.run.mock.calls[0][1].dryRun).toBe(true);
  });

  it('ignores a body-supplied role: an agent claiming admin is still refused', async () => {
    signIn('agent');
    const res = await POST(
      post({
        mode: 'all',
        dry_run: false,
        role: 'admin',
        account_role: 'owner',
      })
    );
    expect(res.status).toBe(403);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('takes the account from the server context, never the body', async () => {
    signIn('admin', 'account-1');
    const res = await POST(
      post({
        mode: 'all',
        dry_run: false,
        account_id: 'victim-account',
        accountId: 'victim-account',
      })
    );
    expect(res.status).toBe(200);
    expect(mocks.run.mock.calls[0][1].accountId).toBe('account-1');
    expect(JSON.stringify(mocks.run.mock.calls)).not.toContain('victim');
  });

  it('rejects an unknown mode before reaching the service', async () => {
    signIn('admin');
    const res = await POST(post({ mode: 'drop_everything', dry_run: false }));
    expect(res.status).toBe(400);
    expect(mocks.run).not.toHaveBeenCalled();
  });
});

describe('GET /api/vector-memory', () => {
  it('returns 401 when unauthenticated', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    const res = await GET();
    expect(res.status).toBe(401);
    expect(mocks.coverage).not.toHaveBeenCalled();
  });

  it('reads coverage scoped to the profile account', async () => {
    signIn('viewer', 'account-1');
    const res = await GET();
    expect(res.status).toBe(200);
    expect(mocks.coverage.mock.calls[0][1]).toEqual({ accountId: 'account-1' });
  });
});
