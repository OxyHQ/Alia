import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The guard in front of every URL Alia did not choose.
 *
 * `webScraper` and `browse` are handed whatever the model produces — shaped by
 * search results and by what the person typed — and those requests leave from
 * inside the VPC, where `169.254.169.254` answers.
 *
 * The guard they had was entirely syntactic: a set of internal hostnames plus
 * private addresses written literally into the URL. It never resolved, so a
 * name whose A record pointed at the metadata service passed every check. The
 * first test here is that hole, and it is written against `validateUrl` — the
 * function the tools actually call — rather than against the resolver, because
 * a test of the resolver alone would have stayed green through the whole bug.
 */

const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('dns/promises', () => ({ lookup: dns.lookup }));

import { classifyHost, normaliseHostname } from '../public-host.js';
import { validateUrl } from '../tools/sandbox.js';

const resolvesTo = (...addresses: string[]) =>
  dns.lookup.mockResolvedValue(
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
  );

beforeEach(() => dns.lookup.mockReset());
afterEach(() => vi.clearAllMocks());

describe('the hole this closes', () => {
  it('refuses a public-looking name whose A record is the metadata service', async () => {
    resolvesTo('169.254.169.254');
    const verdict = await validateUrl('http://a-name-i-control.example/');
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toMatch(/non-public/i);
  });

  it('still allows an ordinary public host', async () => {
    resolvesTo('93.184.216.34');
    expect((await validateUrl('https://example.com/page')).valid).toBe(true);
  });
});

describe('classifyHost', () => {
  it('judges every address, not just the first', async () => {
    // One public answer and one loopback answer is a name that reaches loopback.
    resolvesTo('93.184.216.34', '127.0.0.1');
    expect(await classifyHost('split.example.com')).toBe('refused');
  });

  it('catches an IPv4 address mapped into IPv6, the routine bypass', async () => {
    resolvesTo('::ffff:127.0.0.1');
    expect(await classifyHost('mapped.example.com')).toBe('refused');
  });

  it.each([
    ['10.0.0.5', 'RFC1918'],
    ['172.16.9.9', 'RFC1918'],
    ['192.168.1.1', 'RFC1918'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['169.254.169.254', 'cloud metadata'],
    ['fd00::1', 'IPv6 unique-local'],
    ['fe80::1', 'IPv6 link-local'],
  ])('refuses %s (%s)', async (address) => {
    resolvesTo(address);
    expect(await classifyHost('anything.example.com')).toBe('refused');
  });

  it('reports a name that does not resolve as unresolvable, not as allowed', async () => {
    const enotfound = Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    dns.lookup.mockImplementationOnce(() => Promise.reject(enotfound));
    await expect(classifyHost('gone.example.com')).resolves.toBe('unresolvable');
  });

  it('treats an empty answer as unresolvable rather than as nothing to refuse', async () => {
    dns.lookup.mockResolvedValue([]);
    expect(await classifyHost('empty.example.com')).toBe('unresolvable');
  });

  it('does not spend a lookup on a name it already refuses', async () => {
    expect(await classifyHost('localhost')).toBe('refused');
    expect(dns.lookup).not.toHaveBeenCalled();
  });
});

describe('normaliseHostname', () => {
  it.each([
    '127.0.0.1', '169.254.169.254', '0.0.0.0',
    '[::1]', '::1',
    'localhost', 'foo.local', 'svc.internal', 'box.lan', 'x.onion',
    'singlelabel', '', '   ',
  ])('refuses %j', (raw) => {
    expect(normaliseHostname(raw)).toBeNull();
  });

  it.each([
    ['Example.COM', 'example.com'],
    ['example.com.', 'example.com'],
    ['news.bbc.co.uk', 'news.bbc.co.uk'],
  ])('accepts %j as %j', (raw, expected) => {
    expect(normaliseHostname(raw)).toBe(expected);
  });
});
