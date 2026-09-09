import net from 'net';
import { lookup as dnsLookup } from 'dns/promises';
import { Agent } from 'undici';
import { log } from './logger.js';

/**
 * Whether a hostname is one this service will reach, and a client that connects
 * only to the addresses that answered yes.
 *
 * Alia fetches URLs it did not choose. `webScraper` and `browse` take whatever
 * the model produces — which is shaped by search results and by what the person
 * typed — and the favicon route takes a domain out of a message. Every one of
 * those requests leaves from inside the VPC, where `169.254.169.254` and every
 * private range answer.
 *
 * The guard this replaced in `tools/sandbox.ts` was entirely syntactic: a list
 * of internal hostnames, plus private addresses written literally into the URL.
 * It never resolved, so `http://a-name-i-control.example/` whose A record says
 * `169.254.169.254` passed all three of its checks and was fetched.
 *
 * ## Why the dispatcher exists
 *
 * Checking an address and then handing the hostname to `fetch` leaves a
 * rebinding window: `fetch` resolves the name a second time and may connect
 * somewhere else. {@link publicOnlyAgent} closes it by doing the check INSIDE
 * the lookup, so the addresses that were judged are the addresses connected to.
 * A caller that does not use the agent still gets the name check, and still has
 * that window — `browse` drives a real browser, which resolves on its own.
 */

export type HostVerdict = 'ok' | 'refused' | 'unresolvable';

/**
 * Names that must never leave the network, whatever DNS says about them. The
 * address check is the real guard; this refuses the obvious ones without
 * spending a lookup, and covers the split-horizon case where an internal
 * resolver answers for a name a public one does not.
 */
const RESERVED_SUFFIXES = [
  'localhost', 'local', 'localdomain', 'internal', 'intranet', 'lan', 'home',
  'corp', 'private', 'arpa', 'alt', 'onion', 'test', 'example', 'invalid',
];

/**
 * Every address range that is not public unicast: loopback, the private and
 * carrier-grade ranges, link-local — which is where the cloud metadata service
 * answers — and the multicast and reserved space.
 *
 * `net.BlockList` rather than arithmetic on octets: it parses addresses with
 * Node's own parser and checks an IPv4-mapped IPv6 address (`::ffff:127.0.0.1`,
 * a routine bypass for hand-written checks) against the IPv4 rules.
 */
const BLOCKED_ADDRESSES = new net.BlockList();
BLOCKED_ADDRESSES.addSubnet('0.0.0.0', 8, 'ipv4');
BLOCKED_ADDRESSES.addSubnet('10.0.0.0', 8, 'ipv4');
BLOCKED_ADDRESSES.addSubnet('100.64.0.0', 10, 'ipv4');
BLOCKED_ADDRESSES.addSubnet('127.0.0.0', 8, 'ipv4');
BLOCKED_ADDRESSES.addSubnet('169.254.0.0', 16, 'ipv4');
BLOCKED_ADDRESSES.addSubnet('172.16.0.0', 12, 'ipv4');
BLOCKED_ADDRESSES.addSubnet('192.0.0.0', 24, 'ipv4');
BLOCKED_ADDRESSES.addSubnet('192.168.0.0', 16, 'ipv4');
BLOCKED_ADDRESSES.addSubnet('198.18.0.0', 15, 'ipv4');
BLOCKED_ADDRESSES.addSubnet('224.0.0.0', 4, 'ipv4');
BLOCKED_ADDRESSES.addSubnet('240.0.0.0', 4, 'ipv4');
BLOCKED_ADDRESSES.addAddress('::', 'ipv6');
BLOCKED_ADDRESSES.addAddress('::1', 'ipv6');
BLOCKED_ADDRESSES.addSubnet('64:ff9b::', 96, 'ipv6');
BLOCKED_ADDRESSES.addSubnet('100::', 64, 'ipv6');
BLOCKED_ADDRESSES.addSubnet('2002::', 16, 'ipv6');
BLOCKED_ADDRESSES.addSubnet('fc00::', 7, 'ipv6');
BLOCKED_ADDRESSES.addSubnet('fe80::', 10, 'ipv6');
BLOCKED_ADDRESSES.addSubnet('ff00::', 8, 'ipv6');

/** True when any address is one this service must not connect to. */
function anyBlocked(addresses: ReadonlyArray<{ address: string; family: number }>): string | null {
  for (const { address, family } of addresses) {
    if (BLOCKED_ADDRESSES.check(address, family === 6 ? 'ipv6' : 'ipv4')) return address;
  }
  return null;
}

/**
 * The hostname on its own, lowercased and stripped of a trailing dot, or `null`
 * when it is not a name this service will resolve at all: an address literal, a
 * single label, or a reserved suffix.
 */
export function normaliseHostname(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(`https://${raw.trim()}`);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (host.length === 0 || host.length > 253) return null;

  const labels = host.split('.');
  // At least two labels, each a legal DNS label. An IPv6 literal keeps its
  // brackets and colons here, so the character class refuses it.
  if (labels.length < 2) return null;
  if (!labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;

  // A registry TLD is alphabetic, which is also what refuses every IPv4
  // literal — `127.0.0.1` ends in `1` — without a separate case for them.
  const tld = labels[labels.length - 1];
  if (!/^[a-z]{2,}$/.test(tld) && !tld.startsWith('xn--')) return null;

  if (RESERVED_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return null;

  return host;
}

/**
 * Resolve the name and judge every address it answers with.
 *
 * Every address, not the first: a name that answers with one public address and
 * one loopback address is a name that reaches loopback.
 */
export async function classifyHost(hostname: string): Promise<HostVerdict> {
  if (normaliseHostname(hostname) === null) return 'refused';

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  } catch (err: unknown) {
    log.general.debug({ err, hostname }, 'Host did not resolve');
    return 'unresolvable';
  }
  if (addresses.length === 0) return 'unresolvable';

  const blocked = anyBlocked(addresses);
  if (blocked !== null) {
    log.general.warn({ hostname, address: blocked }, 'Refused a host resolving to a non-public address');
    return 'refused';
  }
  return 'ok';
}

/** The error a refused connection fails with, so callers can tell it apart. */
export class NonPublicAddressError extends Error {
  constructor(hostname: string, address: string) {
    super(`${hostname} resolves to a non-public address (${address})`);
    this.name = 'NonPublicAddressError';
  }
}

/**
 * A dispatcher whose every connection resolves through the same judgement.
 *
 * This is what closes the rebinding window: the check happens inside the lookup
 * the connection itself uses, so there is no second resolution between deciding
 * and connecting. Pass it as `dispatcher` to undici's `fetch`.
 */
export const publicOnlyAgent = new Agent({
  connect: {
    lookup: (hostname, options, callback) => {
      if (normaliseHostname(hostname) === null) {
        callback(new NonPublicAddressError(hostname, hostname), '', 4);
        return;
      }
      dnsLookup(hostname, { all: true, verbatim: true }).then(
        (addresses) => {
          const blocked = anyBlocked(addresses);
          if (blocked !== null) {
            log.general.warn({ hostname, address: blocked }, 'Refused a connection to a non-public address');
            callback(new NonPublicAddressError(hostname, blocked), '', 4);
            return;
          }
          // `all` was requested, so the caller gets every judged address and
          // connects to one of them — never to a name resolved again later.
          callback(null, addresses);
        },
        (err: unknown) => callback(err as NodeJS.ErrnoException, '', 4),
      );
    },
  },
});

/**
 * `fetch`, but every connection resolves through {@link publicOnlyAgent}.
 *
 * The global `fetch` IS undici's, so handing it a dispatcher is enough — and it
 * keeps one seam for callers and for the tests that stand in front of them,
 * rather than a second fetch implementation that a `vi.stubGlobal` would miss.
 *
 * `dispatcher` is undici's own option and is not in the DOM `RequestInit`, so
 * the init is built as a named value: passing it as a fresh object literal
 * would trip excess-property checking, and silencing that with a cast is how a
 * typo in the option name becomes an unguarded request.
 */
type GuardedInit = RequestInit & { dispatcher?: unknown };

export function publicFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const guarded: GuardedInit = { ...init, dispatcher: publicOnlyAgent };
  return fetch(input, guarded);
}
