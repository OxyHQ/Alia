/**
 * Which destinations the agents' browser may reach: public HTTP(S) on ports 80
 * and 443, and nothing else.
 *
 * Adapted from OpenMuse `apps/worker/src/network.ts` (MIT, see ../../NOTICE).
 *
 * ## The answer, not the name, is what is checked
 *
 * A hostname proves nothing: `metadata.example` can resolve to 169.254.169.254
 * and `rebind.example` can answer a public address to the check and a private
 * one to the connect. So the egress proxy resolves a name ONCE, refuses it if
 * ANY answer is not a public unicast address, and then connects to exactly the
 * address it checked — there is no second lookup for a rebinding answer to land
 * in. {@link destinationFor} is that one lookup.
 *
 * The allow-list is conservative on purpose: private, loopback, link-local
 * (the instance metadata service), carrier-grade NAT, documentation, benchmark,
 * multicast and reserved ranges are refused, IPv6 is limited to global unicast
 * (2000::/3) minus 6to4, Teredo and documentation, and an IPv4 address mapped
 * into IPv6 is refused rather than unwrapped. The VPC's own CIDR is private
 * already; `extraDenied` lets the deployment name more.
 */
import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';

export class BlockedDestination extends Error {
  constructor(
    readonly code: 'blocked_url' | 'dns_unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'BlockedDestination';
  }
}

const blocked = () =>
  new BlockedDestination('blocked_url', 'Only public HTTP(S) destinations on ports 80 and 443 are allowed.');

/** One IPv4 CIDR, as [network, mask] integers. */
export type Cidr4 = readonly [number, number];

function ipv4ToInt(address: string): number {
  return address.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

export function parseCidr4(cidr: string): Cidr4 {
  const [address, bits] = cidr.split('/');
  const prefix = Number(bits);
  if (isIP(address ?? '') !== 4 || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`Not an IPv4 CIDR: ${cidr}`);
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return [(ipv4ToInt(address as string) & mask) >>> 0, mask];
}

/** Conservative global-unicast allow-list. Anything not provably public is refused. */
export function isPublicIp(address: string, extraDenied: readonly Cidr4[] = []): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a = 0, b = 0, c = 0] = address.split('.').map(Number);
    const reserved =
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113);
    if (reserved) return false;
    const value = ipv4ToInt(address);
    return !extraDenied.some(([network, mask]) => ((value & mask) >>> 0) === network);
  }
  // A zone id or an embedded dotted quad (::ffff:10.0.0.1, ::10.0.0.1) is
  // never a browser destination; refusing beats unwrapping.
  if (family !== 6 || address.includes('.') || address.includes('%')) return false;
  const halves = address.toLowerCase().split('::');
  if (halves.length > 2) return false;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const words = halves.length === 1 ? left : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  const first = Number.parseInt(words[0] ?? '0', 16);
  const second = Number.parseInt(words[1] ?? '0', 16);
  return (
    first >= 0x2000 &&
    first <= 0x3fff &&
    !(first === 0x2001 && (second < 0x200 || second === 0xdb8)) &&
    first !== 0x2002 &&
    !(first === 0x3fff && second < 0x1000)
  );
}

/**
 * The URL, if its SHAPE is allowed: http(s), no credentials, port 80/443, a
 * hostname that is not a local name. No DNS here — the browser's request hook
 * uses this to refuse early and cheaply; the proxy still decides.
 */
export function allowedUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw blocked();
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && url.port !== '80' && url.port !== '443') ||
    !hostname ||
    /(^|\.)(localhost|local|internal|home|lan|localdomain|arpa)$/.test(hostname) ||
    (isIP(hostname) !== 0 && !isPublicIp(hostname))
  ) {
    throw blocked();
  }
  return url;
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>;

/**
 * A resolver that asks the given DNS servers directly (c-ares), never
 * `/etc/hosts` or the container's own resolver configuration.
 */
export function dnsResolver(servers: readonly string[] = []): HostResolver {
  const resolver = new Resolver({ timeout: 3000, tries: 2 });
  if (servers.length > 0) resolver.setServers([...servers]);
  return async (hostname) => {
    const settled = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
    const answers: ResolvedAddress[] = [];
    if (settled[0].status === 'fulfilled') answers.push(...settled[0].value.map((address) => ({ address, family: 4 as const })));
    if (settled[1].status === 'fulfilled') answers.push(...settled[1].value.map((address) => ({ address, family: 6 as const })));
    return answers;
  };
}

export interface Destination {
  url: URL;
  hostname: string;
  address: string;
  family: 4 | 6;
  port: number;
}

/**
 * Resolve once and pin: the address to CONNECT to, or a refusal. Every answer
 * must be public — one private answer among public ones is how a rebinding
 * resolver hedges, so the whole name is refused.
 */
export async function destinationFor(
  value: string,
  resolve: HostResolver,
  extraDenied: readonly Cidr4[] = [],
  timeoutMs = 5000,
): Promise<Destination> {
  const url = allowedUrl(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  let answers: ResolvedAddress[];
  const literal = isIP(hostname);
  if (literal) {
    answers = [{ address: hostname, family: literal as 4 | 6 }];
  } else {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      answers = await Promise.race([
        resolve(hostname),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('DNS timeout')), timeoutMs);
        }),
      ]);
    } catch {
      throw new BlockedDestination('dns_unavailable', 'The destination could not be resolved.');
    } finally {
      clearTimeout(timer);
    }
  }
  if (answers.length === 0) throw new BlockedDestination('dns_unavailable', 'The destination could not be resolved.');
  if (answers.some((answer) => !isPublicIp(answer.address, extraDenied))) throw blocked();
  const chosen = answers.find((answer) => answer.family === 4) ?? answers[0];
  if (!chosen) throw blocked();
  return { url, hostname, address: chosen.address, family: chosen.family, port };
}
