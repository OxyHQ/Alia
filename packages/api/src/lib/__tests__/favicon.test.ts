import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What Alia is willing to fetch when a message hands it a domain.
 *
 * The favicon resolver is the one place in this service where a string an
 * attacker can plant — a search result's host, a page the model was asked to
 * read — becomes an outbound request made from inside the VPC. So most of this
 * file is about requests that must NOT happen, and every one of those cases
 * counts the outbound calls rather than only reading the verdict: a guard that
 * returns "refused" after fetching has already done the damage.
 *
 * Nothing here reaches the network. DNS is a table and `fetch` is a handler, so
 * a domain "resolving to loopback" is stated rather than arranged, which is the
 * only way to state it in a test environment that has no outbound network at
 * all.
 */

const H = vi.hoisted(() => ({
  /** hostname → what DNS answers. Absent means NXDOMAIN. */
  addresses: new Map<string, Array<{ address: string; family: number }>>(),
  /** Every hostname a lookup was attempted for, in order. */
  lookups: [] as string[],
  /** Every URL an outbound request was made to, in order. */
  fetched: [] as string[],
  handler: (_url: URL, _init: RequestInit): Promise<Response> =>
    Promise.resolve(new Response(null, { status: 404 })),
}));

vi.mock('node:dns/promises', () => ({
  lookup: async (hostname: string) => {
    H.lookups.push(hostname);
    const found = H.addresses.get(hostname);
    if (found === undefined) throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    return found;
  },
}));

const { getFavicon } = await import('../favicon.js');

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** A one-pixel PNG is not needed: only the bytes' size and type are read. */
const ICON = Buffer.from('icon-bytes');

function iconResponse(contentType = 'image/x-icon', body: Buffer = ICON): Response {
  // `Uint8Array`, not the `Buffer` itself: `BodyInit` does not include Node's
  // subclass, though the runtime is happy with either.
  return new Response(new Uint8Array(body), { status: 200, headers: { 'content-type': contentType } });
}

/** A body that arrives in chunks and declares no length, like a real stream. */
function chunkedResponse(chunks: number, chunkBytes: number, contentType = 'image/png'): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < chunks; i += 1) controller.enqueue(new Uint8Array(chunkBytes).fill(1));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': contentType } });
}

function publicly(...hostnames: string[]): void {
  for (const hostname of hostnames) H.addresses.set(hostname, [{ address: '93.184.216.34', family: 4 }]);
}

beforeEach(() => {
  H.addresses.clear();
  H.lookups = [];
  H.fetched = [];
  H.handler = () => Promise.resolve(new Response(null, { status: 404 }));

  vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit) => {
    let url = new URL(String(input));
    // The stub follows redirects ITSELF unless asked not to, because that is
    // what `fetch` does: with anything but `redirect: 'manual'` the runtime
    // walks the chain and hands back only the last response, so the code under
    // test never sees the hop and cannot judge where it went. A stub that
    // returned the 30x either way would let that mistake pass.
    for (let hop = 0; hop < 8; hop += 1) {
      H.fetched.push(url.href);
      // Real `fetch` rejects immediately on a signal that has already aborted;
      // a handler that waits for an `abort` event it has missed would hang here
      // and make a deadline look like a hang in the code under test.
      if (init.signal?.aborted === true) throw init.signal.reason;
      const response = await H.handler(url, init);
      if (init.redirect === 'manual' || !REDIRECT_STATUSES.has(response.status)) return response;
      const location = response.headers.get('location');
      if (location === null) return response;
      url = new URL(location, url);
    }
    throw new TypeError('fetch failed: too many redirects');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('fetching a favicon', () => {
  it('asks the site itself, and no one else', async () => {
    // The whole reason this endpoint exists: a public favicon service would
    // learn which publications every reader's answers were built from.
    publicly('news.example.com');
    H.handler = () => Promise.resolve(iconResponse());

    const result = await getFavicon('news.example.com');

    expect(result).toEqual({ kind: 'icon', body: ICON, contentType: 'image/x-icon' });
    expect(H.fetched).toEqual(['https://news.example.com/favicon.ico']);
  });

  it('falls back to the apple touch icon when there is no favicon.ico', async () => {
    publicly('touch.example.com');
    H.handler = (url) =>
      Promise.resolve(
        url.pathname === '/apple-touch-icon.png'
          ? iconResponse('image/png')
          : new Response(null, { status: 404 }),
      );

    const result = await getFavicon('touch.example.com');

    expect(result).toEqual({ kind: 'icon', body: ICON, contentType: 'image/png' });
    expect(H.fetched).toEqual([
      'https://touch.example.com/favicon.ico',
      'https://touch.example.com/apple-touch-icon.png',
    ]);
  });

  it('serves a second reader from the cache instead of the site', async () => {
    publicly('cached.example.com');
    H.handler = () => Promise.resolve(iconResponse());

    const first = await getFavicon('cached.example.com');
    const second = await getFavicon('cached.example.com');

    expect(second).toEqual(first);
    expect(H.fetched).toHaveLength(1);
  });

  it('remembers that a site has no icon, so a miss is not fetched on every render', async () => {
    publicly('bare.example.com');
    H.handler = () => Promise.resolve(new Response(null, { status: 404 }));

    expect(await getFavicon('bare.example.com')).toEqual({ kind: 'none' });
    const afterFirst = H.fetched.length;
    expect(await getFavicon('bare.example.com')).toEqual({ kind: 'none' });

    expect(H.fetched).toHaveLength(afterFirst);
  });

  it('makes one request when a whole answer cites the same domain at once', async () => {
    publicly('busy.example.com');
    let release: (value: Response) => void = () => undefined;
    H.handler = () => new Promise<Response>((resolve) => { release = resolve; });

    const readers = [getFavicon('busy.example.com'), getFavicon('busy.example.com'), getFavicon('busy.example.com')];
    // Hold the site's answer until the request is actually out, so the three
    // readers are demonstrably concurrent rather than merely quick.
    await vi.waitFor(() => expect(H.fetched).toHaveLength(1));
    release(iconResponse());
    const results = await Promise.all(readers);

    expect(results.every((r) => r.kind === 'icon')).toBe(true);
    expect(H.fetched).toHaveLength(1);
  });
});

describe('refusing what must not be fetched', () => {
  it.each([
    ['loopback', '127.0.0.1', 4],
    ['a private range', '10.1.2.3', 4],
    ['the cloud metadata address', '169.254.169.254', 4],
    ['carrier-grade NAT', '100.64.0.1', 4],
    ['IPv6 loopback', '::1', 6],
    ['an IPv4-mapped loopback address', '::ffff:127.0.0.1', 6],
    ['an IPv6 unique-local address', 'fd00::1', 6],
  ])('refuses a domain resolving to %s, without fetching it', async (label, address, family) => {
    const host = `resolves-to-${label.toLowerCase().replace(/[^a-z]+/g, '-')}.example.com`;
    H.addresses.set(host, [{ address, family }]);

    const result = await getFavicon(host);

    expect(result.kind).toBe('refused');
    expect(H.fetched).toEqual([]);
  });

  it('refuses a domain that answers with one public address and one loopback address', async () => {
    // Checking only the first answer is the classic hole: the resolver is free
    // to return them in any order, so a single loopback answer is enough.
    H.addresses.set('mixed.example.com', [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);

    expect((await getFavicon('mixed.example.com')).kind).toBe('refused');
    expect(H.fetched).toEqual([]);
  });

  it('fetches a domain that resolves to an ordinary public address', async () => {
    // The control for every refusal above: without it, a guard that refused
    // EVERYTHING would pass this whole block.
    publicly('ordinary.example.com');
    H.handler = () => Promise.resolve(iconResponse());

    expect((await getFavicon('ordinary.example.com')).kind).toBe('icon');
    expect(H.fetched).toEqual(['https://ordinary.example.com/favicon.ico']);
  });

  it.each([
    ['an IPv4 literal', '127.0.0.1'],
    ['a public IPv4 literal', '93.184.216.34'],
    ['an IPv6 literal', '[::1]'],
    ['localhost', 'localhost'],
    ['an internal suffix', 'billing.internal'],
    ['an mDNS name', 'printer.local'],
    ['a single label', 'intranet-box'],
    ['a URL rather than a hostname', 'https://example.com/favicon.ico'],
    ['a file URL host', 'file:///etc/passwd'],
    ['an empty string', ''],
  ])('refuses %s before it resolves anything', async (_label, domain) => {
    const result = await getFavicon(domain);

    expect(result.kind).toBe('refused');
    expect(H.lookups).toEqual([]);
    expect(H.fetched).toEqual([]);
  });

  it('refuses a redirect that leads to a private address, and does not follow it', async () => {
    publicly('open-redirect.example.com');
    H.addresses.set('internal-host.example.com', [{ address: '169.254.169.254', family: 4 }]);
    H.handler = (url) =>
      Promise.resolve(
        url.hostname === 'open-redirect.example.com'
          ? new Response(null, { status: 302, headers: { location: 'https://internal-host.example.com/favicon.ico' } })
          : iconResponse(),
      );

    const result = await getFavicon('open-redirect.example.com');

    expect(result.kind).toBe('refused');
    expect(H.fetched).toEqual(['https://open-redirect.example.com/favicon.ico']);
  });

  it('refuses a redirect to an internal NAME even when it resolves publicly', async () => {
    // Split horizon: the same name answers with a private address inside the
    // network and something ordinary outside it. The address check cannot see
    // that from here, so the name itself has to be refused — which is the only
    // thing standing between a public redirect and `http://grafana.internal/`.
    publicly('trusting.example.com', 'grafana.internal');
    H.handler = (url) =>
      Promise.resolve(
        url.hostname === 'trusting.example.com'
          ? new Response(null, { status: 307, headers: { location: 'http://grafana.internal/favicon.ico' } })
          : iconResponse(),
      );

    const result = await getFavicon('trusting.example.com');

    expect(result.kind).toBe('refused');
    expect(H.fetched).toEqual(['https://trusting.example.com/favicon.ico']);
  });

  it('follows a redirect to another public host', async () => {
    // The control for the refusal above: redirects are ordinary for favicons
    // (bare domain to `www`), so refusing all of them would pass that test too.
    publicly('redirects.example.com', 'cdn.example.com');
    H.handler = (url) =>
      Promise.resolve(
        url.hostname === 'redirects.example.com'
          ? new Response(null, { status: 301, headers: { location: 'https://cdn.example.com/icons/favicon.ico' } })
          : iconResponse('image/png'),
      );

    const result = await getFavicon('redirects.example.com');

    expect(result.kind).toBe('icon');
    expect(H.fetched).toEqual([
      'https://redirects.example.com/favicon.ico',
      'https://cdn.example.com/icons/favicon.ico',
    ]);
  });

  it('stops following redirects instead of looping forever', async () => {
    publicly('loop.example.com');
    H.handler = (url) =>
      Promise.resolve(new Response(null, { status: 302, headers: { location: `${url.href}?again` } }));

    expect(await getFavicon('loop.example.com')).toEqual({ kind: 'none' });
    // Four hops per well-known path, and no more.
    expect(H.fetched).toHaveLength(8);
  });

  it('refuses a redirect to a scheme that is not http', async () => {
    publicly('scheme.example.com');
    H.handler = () => Promise.resolve(new Response(null, { status: 302, headers: { location: 'file:///etc/passwd' } }));

    expect((await getFavicon('scheme.example.com')).kind).toBe('refused');
    expect(H.fetched).toEqual(['https://scheme.example.com/favicon.ico']);
  });
});

describe('refusing what came back', () => {
  it('does not serve a page that a site returned instead of an icon', async () => {
    // A soft 404: status 200, an HTML "not found" page. Serving it would put
    // markup from another site on Alia's own origin.
    publicly('soft404.example.com');
    H.handler = () =>
      Promise.resolve(new Response('<!doctype html><title>Not found</title>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }));

    expect(await getFavicon('soft404.example.com')).toEqual({ kind: 'none' });
  });

  it('does not serve a response with no content type at all', async () => {
    publicly('untyped.example.com');
    H.handler = () => Promise.resolve(new Response(new Uint8Array(ICON), { status: 200 }));

    expect(await getFavicon('untyped.example.com')).toEqual({ kind: 'none' });
  });

  it('serves the icon spellings a real site uses', async () => {
    // The control for the two refusals above.
    publicly('vnd.example.com');
    H.handler = () => Promise.resolve(iconResponse('image/vnd.microsoft.icon; charset=binary'));

    expect(await getFavicon('vnd.example.com')).toEqual({ kind: 'icon', body: ICON, contentType: 'image/x-icon' });
  });

  it('refuses a body bigger than the cap even when nothing declares its length', async () => {
    // The cap has to be enforced as the bytes arrive: a chunked response makes
    // no `Content-Length` claim, and a claim is not a promise anyway.
    publicly('huge.example.com');
    H.handler = () => Promise.resolve(chunkedResponse(80, 1024));

    expect(await getFavicon('huge.example.com')).toEqual({ kind: 'none' });
  });

  it('serves a body just under the cap', async () => {
    publicly('big-enough.example.com');
    H.handler = () => Promise.resolve(chunkedResponse(63, 1024));

    const result = await getFavicon('big-enough.example.com');

    expect(result.kind).toBe('icon');
  });

  it('does not serve an empty body', async () => {
    publicly('empty.example.com');
    H.handler = () => Promise.resolve(new Response(new Uint8Array(0), { status: 200, headers: { 'content-type': 'image/png' } }));

    expect(await getFavicon('empty.example.com')).toEqual({ kind: 'none' });
  });

  it('treats a domain that does not resolve as a site without an icon', async () => {
    expect(await getFavicon('nowhere.example.com')).toEqual({ kind: 'none' });
    expect(H.fetched).toEqual([]);
  });
});

describe('bounding what one caller can spend', () => {
  it('gives up on a site that never answers', async () => {
    vi.useFakeTimers();
    publicly('slow.example.com');
    H.handler = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });

    const pending = getFavicon('slow.example.com');
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await pending).toEqual({ kind: 'none' });
  });

  it('answers "busy" rather than opening an unbounded number of connections', async () => {
    vi.useFakeTimers();
    const hosts = Array.from({ length: 8 }, (_, i) => `flood-${i}.example.com`);
    publicly(...hosts, 'legitimate.example.com');
    H.handler = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });

    const flood = hosts.map((host) => getFavicon(host));
    await Promise.resolve();

    expect(await getFavicon('legitimate.example.com')).toEqual({ kind: 'busy' });
    // And "busy" is not remembered: once the flood drains, the next reader gets
    // a real attempt rather than hours of a cached refusal.
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all(flood);
    H.handler = () => Promise.resolve(iconResponse());
    expect((await getFavicon('legitimate.example.com')).kind).toBe('icon');
  });
});
