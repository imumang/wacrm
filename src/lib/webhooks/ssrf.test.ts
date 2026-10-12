import { describe, it, expect, vi, afterEach } from 'vitest';

// DNS is faked only when a test sets `fakeLookup`; otherwise the real
// resolver is used so existing tests keep their behaviour.
let fakeLookup:
  ((host: string) => { address: string; family: number }[]) | null = null;
vi.mock('node:dns/promises', async (orig) => {
  const actual = await orig<typeof import('node:dns/promises')>();
  return {
    ...actual,
    lookup: (host: string, opts?: unknown) =>
      fakeLookup
        ? Promise.resolve(fakeLookup(host))
        : (actual.lookup as (h: string, o?: unknown) => Promise<unknown>)(
            host,
            opts
          ),
  };
});
import { isPrivateOrReservedIp, isDeliverableUrl } from './ssrf';

describe('isPrivateOrReservedIp', () => {
  it('flags loopback / private / link-local / CGNAT IPv4', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1', // CGNAT
      '0.0.0.0',
    ]) {
      expect(isPrivateOrReservedIp(ip)).toBe(true);
    }
  });

  it('allows public IPv4', () => {
    for (const ip of [
      '8.8.8.8',
      '1.1.1.1',
      '172.15.0.1',
      '172.32.0.1',
      '93.184.216.34',
    ]) {
      expect(isPrivateOrReservedIp(ip)).toBe(false);
    }
  });

  it('flags other IPv4 special-purpose ranges', () => {
    for (const ip of [
      '192.0.0.1', // IETF protocol assignments
      '192.0.2.5', // TEST-NET-1
      '192.88.99.1', // 6to4 relay anycast
      '198.18.0.1', // benchmarking
      '198.51.100.7', // TEST-NET-2
      '203.0.113.7', // TEST-NET-3
      '224.0.0.1', // multicast
      '255.255.255.255', // broadcast
    ]) {
      expect(isPrivateOrReservedIp(ip)).toBe(true);
    }
  });

  it('flags loopback / ULA / link-local IPv6 and IPv4-mapped privates', () => {
    for (const ip of [
      '::',
      '::1',
      'fe80::1',
      'fe80::1%eth0',
      'febf::1',
      'fc00::1',
      'fd12::34',
      'ff02::1', // multicast
      '100::1', // discard-only
      '2001:db8::1', // documentation
      '::ffff:127.0.0.1',
    ]) {
      expect(isPrivateOrReservedIp(ip)).toBe(true);
    }
    expect(isPrivateOrReservedIp('2606:4700:4700::1111')).toBe(false);
    expect(isPrivateOrReservedIp('::ffff:8.8.8.8')).toBe(false);
  });

  // GHSA-m4cp-pqxq-x9f7 — the WHATWG URL parser rewrites the dotted
  // tail of an IPv4-mapped literal to hex, which the previous
  // dotted-decimal regex could not see.
  it('flags IPv4-mapped addresses written in hexadecimal', () => {
    for (const ip of [
      '::ffff:7f00:1', // 127.0.0.1
      '::ffff:a00:1', // 10.0.0.1
      '::ffff:a9fe:a9fe', // 169.254.169.254
      '::FFFF:7F00:1', // case-insensitive
      '[::ffff:7f00:1]', // bracketed, as URL.hostname yields it
    ]) {
      expect(isPrivateOrReservedIp(ip)).toBe(true);
    }
    expect(isPrivateOrReservedIp('::ffff:808:808')).toBe(false); // 8.8.8.8
  });

  // GHSA-q4p6-pj4g-26xx — IPv6 transition encodings carry an IPv4
  // address inside a prefix that looks like ordinary global unicast.
  it('flags IPv4 embedded in 6to4 / NAT64 / Teredo encodings', () => {
    for (const ip of [
      '2002:7f00:0001::', // 6to4 → 127.0.0.1
      '2002:a9fe:a9fe::', // 6to4 → 169.254.169.254
      '2002:a00:1::', // 6to4 → 10.0.0.1
      '64:ff9b::7f00:1', // NAT64 → 127.0.0.1
      '64:ff9b::a9fe:a9fe', // NAT64 → 169.254.169.254
      '64:ff9b::169.254.169.254', // NAT64, dotted tail
      '64:ff9b:1::a9fe:a9fe', // NAT64 local-use prefix
      '2001:0:53aa:64c:0:7f9a:a9fe:a9fe', // Teredo
      '2001::1', // Teredo prefix
    ]) {
      expect(isPrivateOrReservedIp(ip)).toBe(true);
    }
    // A 6to4 address wrapping public IPv4 space is still routable.
    expect(isPrivateOrReservedIp('2002:808:808::')).toBe(false);
  });

  it('fails closed on anything it cannot parse', () => {
    for (const ip of [
      '',
      'not-an-ip',
      '1.2.3',
      '1.2.3.4.5',
      '256.1.1.1',
      'gg::1',
      '::1::2',
    ]) {
      expect(isPrivateOrReservedIp(ip)).toBe(true);
    }
  });
});

describe('isDeliverableUrl', () => {
  it('rejects literal private IPs and internal names without DNS', async () => {
    expect(await isDeliverableUrl('https://127.0.0.1/hook')).toBe(false);
    expect(
      await isDeliverableUrl('https://169.254.169.254/latest/meta-data')
    ).toBe(false);
    expect(await isDeliverableUrl('https://[::1]/hook')).toBe(false);
    expect(await isDeliverableUrl('https://localhost/hook')).toBe(false);
    expect(await isDeliverableUrl('https://foo.internal/hook')).toBe(false);
  });

  it('rejects a malformed URL', async () => {
    expect(await isDeliverableUrl('not a url')).toBe(false);
  });

  it('rejects the IPv6 spellings of an internal IPv4 target', async () => {
    // Each of these was accepted before GHSA-m4cp-pqxq-x9f7 /
    // GHSA-q4p6-pj4g-26xx; go through isDeliverableUrl so the URL
    // parser's own normalization is part of the assertion.
    for (const url of [
      'https://[::ffff:127.0.0.1]/hook',
      'https://[::ffff:169.254.169.254]/latest/meta-data',
      'https://[::ffff:10.0.0.1]/hook',
      'http://[2002:a9fe:a9fe::]:80/latest/meta-data/',
      'http://[2002:7f00:0001::]:8080/admin',
      'http://[64:ff9b::a9fe:a9fe]/latest/meta-data/',
      'http://[64:ff9b::ac10:fe01]/',
    ]) {
      expect(await isDeliverableUrl(url)).toBe(false);
    }
  });

  it('allows a literal public IP', async () => {
    expect(await isDeliverableUrl('https://8.8.8.8/hook')).toBe(true);
    expect(await isDeliverableUrl('https://[2606:4700:4700::1111]/hook')).toBe(
      true
    );
  });
});

describe('isDeliverableUrl private host allow-list', () => {
  it('allows only an explicitly allow-listed private host', async () => {
    expect(
      await isDeliverableUrl('http://127.0.0.1:11434/hook', {
        allowPrivateHosts: ['127.0.0.1'],
      })
    ).toBe(true);
    expect(
      await isDeliverableUrl('http://127.0.0.1:11434/hook', {
        allowPrivateHosts: ['127.0.0.2'],
      })
    ).toBe(false);
  });
});

describe('IPv6 fails closed outside global unicast', () => {
  it.each([
    'fec0::1', // site-local (deprecated)
    'feff::1',
    '4000::1', // outside 2000::/3
    '8000::1',
    'c000::1',
    'e000::1',
    '0100::1',
    '3fff::1', // 3fff::/20 documentation
    '3fff:fff::1',
    '2001:db8::1',
    '2001::1', // Teredo
    '2001:2::1', // benchmarking
    '2001:1::1', // 2001::/23 IETF protocol assignments
    '2001:1ff::1',
    '5f00::1', // SRv6 SIDs
    '64:ff9b::1',
    '64:ff9b:1::1',
    '2002:a9fe:a9fe::1',
    '::ffff:7f00:1',
    '::',
    '::1',
    'fe80::1',
    'fc00::1',
    'fd00::1',
    'ff02::1',
  ])('rejects %s', (a) => {
    expect(isPrivateOrReservedIp(a)).toBe(true);
  });

  it.each([
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
    '2a00:1450:4009:81f::200e',
    '2620:fe::fe',
  ])('allows ordinary global address %s', (a) => {
    expect(isPrivateOrReservedIp(a)).toBe(false);
  });

  it('rejects reserved IPv6 literal URLs', async () => {
    for (const url of [
      'http://[fec0::1]/',
      'http://[4000::1]/',
      'http://[3fff::1]/',
    ]) {
      expect(await isDeliverableUrl(url)).toBe(false);
    }
    expect(await isDeliverableUrl('https://[2606:4700:4700::1111]/')).toBe(
      true
    );
  });
});

describe('isDeliverableUrl resolved DNS results', () => {
  afterEach(() => {
    fakeLookup = null;
  });

  it('rejects a hostname that resolves to reserved IPv6 space', async () => {
    for (const address of [
      'fec0::1',
      '4000::1',
      '3fff::1',
      '2002:a9fe:a9fe::1',
    ]) {
      fakeLookup = () => [{ address, family: 6 }];
      expect(await isDeliverableUrl('https://dns-test.example/hook')).toBe(
        false
      );
    }
  });

  it('rejects when any resolved address is reserved', async () => {
    fakeLookup = () => [
      { address: '2606:4700:4700::1111', family: 6 },
      { address: 'fec0::1', family: 6 },
    ];
    expect(await isDeliverableUrl('https://dns-test.example/hook')).toBe(false);
  });

  it('accepts a hostname resolving only to global addresses', async () => {
    fakeLookup = () => [
      { address: '2606:4700:4700::1111', family: 6 },
      { address: '8.8.8.8', family: 4 },
    ];
    expect(await isDeliverableUrl('https://dns-test.example/hook')).toBe(true);
  });
});
