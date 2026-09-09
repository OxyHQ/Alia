/**
 * The favicon behind each mark in an answer's sources row, fetched by Alia
 * rather than by the reader.
 *
 * ## Why the API fetches these at all
 *
 * The cheap version of this feature is an `<img>` pointed at a public favicon
 * service. That version sends a third party one request per source, from the
 * reader's own IP, naming the publication — which adds up to the list of
 * outlets every Alia answer was built on, attributable to a person, held by a
 * company with no part in the product. So Alia fetches the icon itself and
 * serves it from its own origin: a reader's browser only ever talks to Alia.
 *
 * ## Why that makes this the most dangerous input in the service
 *
 * The domain arrives from a message — a search result, or a page the model was
 * asked to read, both of which an attacker can arrange to control. Everything
 * here therefore treats it as hostile input for a request originating INSIDE
 * the VPC, where `169.254.169.254` and every private range live:
 *
 *  - a HOSTNAME is accepted, never a URL, so there is no scheme, port, path,
 *    credential or query for a caller to choose;
 *  - the hostname must be a public DNS name — IP literals and the reserved
 *    suffixes (`.local`, `.internal`, `localhost`, …) are refused before any
 *    lookup happens;
 *  - it is resolved, and EVERY address it resolves to must be public unicast,
 *    so a name that points at loopback is refused even though the string looks
 *    ordinary;
 *  - redirects are followed manually, three hops at most, each hop re-checked
 *    the same way, so a public host cannot hand the request to a private one;
 *  - one deadline covers the whole resolution, the body is capped while it
 *    streams, and only an image content type is ever returned.
 *
 * The residual is DNS rebinding: Node's `fetch` resolves the hostname itself,
 * so the address it connects to is resolved a second time and could differ from
 * the one checked here. Closing that needs an undici dispatcher with a pinned
 * `lookup`, which means taking `undici` as a direct dependency of this service
 * for one route; the exposure that remains is a GET, with no credential, whose
 * body is only returned when it is an image under {@link MAX_ICON_BYTES}.
 * `lib/tools/sandbox.ts` — the guard `browse` and `webScraper` use — does not
 * resolve at all, so it does not close it either.
 *
 * ## Why the cache is a map in this process
 *
 * Redis is configured for rate limiting and the Socket.IO adapter, but
 * `getRedisClient()` returns null whenever `REDIS_URL` is unset, so a
 * Redis-only cache is no cache at all in development and in tests — where the
 * fetch loop most wants to be exercised. An in-process LRU with a TTL is the
 * pattern this service already uses for outbound reads (`lib/tools/web-scraper.ts`),
 * it cannot fail or add latency of its own, and the number it has to bound is
 * small: the icons of the domains an answer cited. Per-reader repetition is
 * absorbed by the `Cache-Control` the route serves, and the in-flight map below
 * collapses the burst of a single answer's sources into one request each.
 *
 * A miss is cached too. Without that, every domain that has no favicon is a
 * fresh outbound request on every render, forever.
 */


import { log } from './logger.js';
import { classifyHost, normaliseHostname, publicFetch, type HostVerdict } from './public-host.js';

/** The paths a site's icon is conventionally served from, tried in order. */
const WELL_KNOWN_PATHS = ['/favicon.ico', '/apple-touch-icon.png'];

/** Bigger than any real favicon, small enough that 300 of them are nothing. */
const MAX_ICON_BYTES = 64 * 1024;

/** One deadline for the whole resolution: both paths, and every redirect hop. */
const FETCH_DEADLINE_MS = 5_000;

const MAX_REDIRECTS = 3;

const CACHE_MAX_ENTRIES = 300;

const ICON_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const NONE_TTL_MS = 6 * 60 * 60 * 1000;
const REFUSED_TTL_MS = 60 * 60 * 1000;

/**
 * How many domains may be in flight at once. An unauthenticated route that
 * makes an outbound request is a resource an anonymous caller can spend; this
 * bounds what a flood of distinct domains costs Alia — sockets, memory, and the
 * time of the event loop — rather than what it costs the sites named.
 */
const MAX_CONCURRENT_FETCHES = 8;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * The content types served back, and what they are served AS. A favicon comes
 * with every spelling of "icon" the last thirty years produced; anything not
 * listed — an HTML soft-404 above all, which is what most sites answer with at
 * `/favicon.ico` — is not an icon and is not returned.
 */
const IMAGE_TYPES = new Map<string, string>([
  ['image/x-icon', 'image/x-icon'],
  ['image/vnd.microsoft.icon', 'image/x-icon'],
  ['image/ico', 'image/x-icon'],
  ['image/icon', 'image/x-icon'],
  ['text/ico', 'image/x-icon'],
  ['image/png', 'image/png'],
  ['image/jpeg', 'image/jpeg'],
  ['image/gif', 'image/gif'],
  ['image/webp', 'image/webp'],
  ['image/avif', 'image/avif'],
  ['image/bmp', 'image/bmp'],
  ['image/svg+xml', 'image/svg+xml'],
]);

export type FaviconResult =
  /** Bytes to serve, with the type to serve them as. */
  | { kind: 'icon'; body: Buffer; contentType: string }
  /** The site has no icon we can serve. The caller draws its own mark. */
  | { kind: 'none' }
  /** The domain was not something Alia will fetch. Never fetched. */
  | { kind: 'refused'; reason: string }
  /** Too many domains in flight; nothing was attempted and nothing is cached. */
  | { kind: 'busy' };

interface CacheEntry {
  result: FaviconResult;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<FaviconResult>>();
let outstandingFetches = 0;

/** What DNS said about one hostname, within one resolution. */

/**
 * The icon for one domain: from the cache, from a request already in flight for
 * it, or from the sites themselves.
 */
export async function getFavicon(domain: string): Promise<FaviconResult> {
  const host = normaliseHostname(domain);
  if (host === null) {
    return { kind: 'refused', reason: 'not a public hostname' };
  }

  const cached = readCache(host);
  if (cached !== null) return cached;

  const pending = inFlight.get(host);
  if (pending !== undefined) return pending;

  if (outstandingFetches >= MAX_CONCURRENT_FETCHES) {
    return { kind: 'busy' };
  }

  outstandingFetches += 1;
  const work = resolveFavicon(host)
    .then((result) => {
      writeCache(host, result);
      return result;
    })
    .catch((err: unknown): FaviconResult => {
      log.general.warn({ err, host }, 'Favicon resolution failed unexpectedly');
      return { kind: 'none' };
    })
    .finally(() => {
      outstandingFetches -= 1;
      inFlight.delete(host);
    });

  inFlight.set(host, work);
  return work;
}

/**
 * The hostname Alia is willing to fetch from, or null.
 *
 * Parsed as a URL first so an internationalised domain arrives as the punycode
 * the DNS actually uses, and so that anything carrying a port, a path or
 * credentials is reduced to its host before it is judged.
 */
async function resolveFavicon(host: string): Promise<FaviconResult> {
  const controller = new AbortController();
  const deadline = setTimeout(
    () => controller.abort(new Error('favicon fetch deadline reached')),
    FETCH_DEADLINE_MS,
  );
  // One verdict per hostname per resolution: the two well-known paths and any
  // redirect back to the same host reuse it instead of resolving again.
  const verdicts = new Map<string, HostVerdict>();

  try {
    for (const path of WELL_KNOWN_PATHS) {
      const attempt = await fetchIcon(`https://${host}${path}`, controller.signal, verdicts);
      // A refusal is a property of the host, not of the path: trying the second
      // one would be the same request to the same forbidden address.
      if (attempt.kind !== 'none') return attempt;
    }
    return { kind: 'none' };
  } finally {
    clearTimeout(deadline);
  }
}

async function fetchIcon(
  startUrl: string,
  signal: AbortSignal,
  verdicts: Map<string, HostVerdict>,
): Promise<FaviconResult> {
  let target: URL;
  try {
    target = new URL(startUrl);
  } catch {
    return { kind: 'none' };
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      return { kind: 'refused', reason: 'only http and https are fetched' };
    }

    const verdict = await hostVerdict(target.hostname, verdicts);
    if (verdict === 'refused') return { kind: 'refused', reason: 'domain does not resolve to a public address' };
    if (verdict === 'unresolvable') return { kind: 'none' };

    let response: Response;
    try {
      // undici's fetch through `publicOnlyAgent`, so the address judged by
      // `classifyHost` is the address connected to. The global fetch resolves
      // the name again after the check, which is the rebinding window.
      response = await publicFetch(target, {
        // Manual, so a redirect to a private address is judged rather than
        // followed by the runtime before this code ever sees it.
        redirect: 'manual',
        signal,
        headers: { Accept: 'image/*', 'User-Agent': 'AliaBot/1.0' },
      });
    } catch (err: unknown) {
      log.general.debug({ err, host: target.hostname }, 'Favicon request failed');
      return { kind: 'none' };
    }

    if (!REDIRECT_STATUSES.has(response.status)) {
      return await readIcon(response);
    }

    const location = response.headers.get('location');
    await discard(response);
    if (location === null) return { kind: 'none' };

    try {
      target = new URL(location, target);
    } catch {
      return { kind: 'none' };
    }
  }

  return { kind: 'none' };
}

async function readIcon(response: Response): Promise<FaviconResult> {
  if (!response.ok) {
    await discard(response);
    return { kind: 'none' };
  }

  const contentType = imageType(response.headers.get('content-type'));
  if (contentType === null) {
    await discard(response);
    return { kind: 'none' };
  }

  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_ICON_BYTES) {
    await discard(response);
    return { kind: 'none' };
  }

  const body = await readCapped(response);
  // An empty 200 is a site saying "nothing here" with the wrong status; serving
  // it would be a broken image where the caller's own mark belongs.
  if (body === null || body.length === 0) return { kind: 'none' };

  return { kind: 'icon', body, contentType };
}

/**
 * The body, or null if it is bigger than the cap.
 *
 * Read chunk by chunk rather than through `arrayBuffer()`: a `Content-Length`
 * is a claim, and a chunked response makes none at all, so the only place the
 * cap can be enforced is while the bytes arrive.
 */
async function readCapped(response: Response): Promise<Buffer | null> {
  if (response.body === null) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > MAX_ICON_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch (err: unknown) {
    log.general.debug({ err }, 'Favicon body could not be read');
    return null;
  }

  return Buffer.concat(chunks);
}

/** Release a body whose bytes are not wanted, so the socket is not held open. */
async function discard(response: Response): Promise<void> {
  if (response.body === null) return;
  try {
    await response.body.cancel();
  } catch (err: unknown) {
    log.general.debug({ err }, 'Favicon body could not be discarded');
  }
}

function imageType(header: string | null): string | null {
  if (header === null) return null;
  const [declared] = header.split(';');
  return IMAGE_TYPES.get(declared.trim().toLowerCase()) ?? null;
}

async function hostVerdict(hostname: string, verdicts: Map<string, HostVerdict>): Promise<HostVerdict> {
  const known = verdicts.get(hostname);
  if (known !== undefined) return known;

  const verdict = await classifyHost(hostname);
  verdicts.set(hostname, verdict);
  return verdict;
}

function readCache(host: string): FaviconResult | null {
  const entry = cache.get(host);
  if (entry === undefined) return null;

  if (Date.now() >= entry.expiresAt) {
    cache.delete(host);
    return null;
  }

  // Re-insert so the map's insertion order is least-recently-used order.
  cache.delete(host);
  cache.set(host, entry);
  return entry.result;
}

function writeCache(host: string, result: FaviconResult): void {
  // `busy` is a statement about this instant, not about the domain. Caching it
  // would turn one flood into hours of missing icons for whoever asked during it.
  if (result.kind === 'busy') return;

  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }

  cache.set(host, { result, expiresAt: Date.now() + ttlFor(result.kind) });
}

function ttlFor(kind: FaviconResult['kind']): number {
  if (kind === 'icon') return ICON_TTL_MS;
  if (kind === 'refused') return REFUSED_TTL_MS;
  return NONE_TTL_MS;
}
