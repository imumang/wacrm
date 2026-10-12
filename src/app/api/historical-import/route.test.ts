import { beforeEach, describe, expect, it, vi } from 'vitest';

// PATCH-008: route-level authorization gate for historical import.
// Only the Supabase server client and the domain services are faked; the
// real requireRole / getCurrentAccount / role helpers run.

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  profile: vi.fn(),
  dryRun: vi.fn(),
  execute: vi.fn(),
  list: vi.fn(),
  inspect: vi.fn(),
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

vi.mock('@/lib/historical-import/service', () => ({
  dryRunHistoricalImport: mocks.dryRun,
  executeHistoricalImport: mocks.execute,
  listHistoricalImportSummaries: mocks.list,
}));

vi.mock('@/lib/historical-import/source-inventory', () => ({
  inspectHistoricalSources: mocks.inspect,
}));

import { GET, POST } from './route';

const run = {
  id: 'run-1',
  source_type: 'enquiries',
  dry_run: true,
  status: 'completed',
};
const result = {
  run,
  has_more: false,
  next_offset: 0,
  findings: [] as string[],
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

function post(body: unknown, query = '') {
  return new Request(`http://localhost/api/historical-import${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function expectNoMutation() {
  expect(mocks.dryRun).not.toHaveBeenCalled();
  expect(mocks.execute).not.toHaveBeenCalled();
}

beforeEach(() => {
  mocks.getUser.mockReset();
  mocks.profile.mockReset();
  mocks.dryRun.mockReset().mockResolvedValue(result);
  mocks.execute
    .mockReset()
    .mockResolvedValue({ ...result, run: { ...run, dry_run: false } });
  mocks.list.mockReset().mockResolvedValue([]);
  mocks.inspect.mockReset().mockResolvedValue({
    account_id: 'account-1',
    counts: {},
    mappable: 0,
    unmappable: 0,
    findings: [],
    inventory: [],
    absent_sources: [],
  });
});

describe('POST /api/historical-import authorization', () => {
  it('returns 401 when unauthenticated and invokes nothing', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    const res = await POST(post({ source_type: 'enquiries', dry_run: false }));
    expect(res.status).toBe(401);
    expectNoMutation();
  });

  it.each(['viewer', 'agent'])(
    'returns 403 for %s without invoking the service',
    async (role) => {
      signIn(role);
      const res = await POST(
        post({ source_type: 'enquiries', dry_run: false })
      );
      expect(res.status).toBe(403);
      expectNoMutation();
    }
  );

  it('returns 403 when the profile has no role (fails closed)', async () => {
    signIn(null);
    const res = await POST(post({ source_type: 'enquiries', dry_run: false }));
    expect(res.status).toBe(403);
    expectNoMutation();
  });

  it.each(['admin', 'owner'])('allows %s to execute', async (role) => {
    signIn(role);
    const res = await POST(post({ source_type: 'enquiries', dry_run: false }));
    expect(res.status).toBe(200);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.dryRun).not.toHaveBeenCalled();
  });

  it('defaults to a dry run for an admin', async () => {
    signIn('admin');
    const res = await POST(post({ source_type: 'enquiries' }));
    expect(res.status).toBe(200);
    expect(mocks.dryRun).toHaveBeenCalledTimes(1);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('ignores a body-supplied role: an agent claiming admin is still refused', async () => {
    signIn('agent');
    const res = await POST(
      post({
        source_type: 'enquiries',
        dry_run: false,
        role: 'admin',
        account_role: 'owner',
      })
    );
    expect(res.status).toBe(403);
    expectNoMutation();
  });

  it('takes account and actor from the server context, never the body or query', async () => {
    signIn('admin', 'account-1');
    const res = await POST(
      post(
        {
          source_type: 'enquiries',
          dry_run: false,
          account_id: 'victim-account',
          accountId: 'victim-account',
          triggered_by_user_id: 'victim-user',
        },
        '?account_id=victim-account'
      )
    );
    expect(res.status).toBe(200);
    const [, args] = mocks.execute.mock.calls[0];
    expect(args.accountId).toBe('account-1');
    expect(args.triggeredByUserId).toBe('user-1');
    expect(JSON.stringify(mocks.execute.mock.calls)).not.toContain('victim');
  });
});

describe('GET /api/historical-import', () => {
  it('returns 401 when unauthenticated', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    const res = await GET(
      new Request('http://localhost/api/historical-import')
    );
    expect(res.status).toBe(401);
    expect(mocks.inspect).not.toHaveBeenCalled();
  });

  it('scopes reads to the profile account, ignoring a query account_id', async () => {
    signIn('viewer', 'account-1');
    const res = await GET(
      new Request('http://localhost/api/historical-import?account_id=victim')
    );
    expect(res.status).toBe(200);
    expect(mocks.inspect.mock.calls[0][1].accountId).toBe('account-1');
    expect(mocks.list.mock.calls[0][1].accountId).toBe('account-1');
    expect(JSON.stringify(mocks.inspect.mock.calls)).not.toContain('victim');
  });
});
