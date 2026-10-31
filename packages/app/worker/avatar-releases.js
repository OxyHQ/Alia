/** Durable native bundles: static Worker deployments must never delete an older release. */
export const AVATAR_RELEASE_PREFIX = '/bloom-character/releases/';
const TYPES = {
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  bin: 'application/octet-stream',
  wasm: 'application/wasm',
  png: 'image/png',
  webp: 'image/webp',
};
export function avatarReleasePath(pathname) {
  const match =
    /^\/bloom-character\/releases\/([a-f0-9]{64})\/(runtime\.mjs|manifest\.json|(?:assets|chunks)\/[A-Za-z0-9_-]+\.(?:mjs|json|bin|wasm|png|webp))$/.exec(
      pathname,
    );
  return match
    ? { key: `releases/${match[1]}/${match[2]}`, type: TYPES[match[2].split('.').at(-1)] }
    : null;
}
const headers = () =>
  new Headers({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Expose-Headers': 'ETag, Content-Length',
    'X-Content-Type-Options': 'nosniff',
  });
export function acceptsGzip(value) {
  const codings = (value ?? '').split(',').map((item) => {
    const [name, ...parameters] = item.trim().toLowerCase().split(';');
    const q = parameters.map((p) => p.trim()).find((p) => p.startsWith('q='));
    const quality = q === undefined ? 1 : Number(q.slice(2));
    return {
      name,
      quality: Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : 0,
    };
  });
  const exact = codings.filter((c) => c.name === 'gzip');
  const selected = exact.length ? exact : codings.filter((c) => c.name === '*');
  return selected.length > 0 && selected.every((c) => c.quality > 0);
}
/** RFC9110§13.1.2: GET/HEAD use weak comparison; call only after finding a resource. */
export function matchesIfNoneMatch(value, etag) {
  if (!value) return false;
  const field = value.trim();
  if (field === '*') return true;
  const current = /^(?:W\/)?("[\x21\x23-\x7e\x80-\xff]*")$/.exec(etag ?? '')?.[1];
  if (!current) return false;
  // Entity tags can contain commas. Parse quoted tags before list delimiters;
  // empty list elements are allowed, but malformed syntax cannot match.
  const item = /[ \t]*(?:(?:W\/)?("[\x21\x23-\x7e\x80-\xff]*")[ \t]*(?:,|$)|,)/y;
  let offset = 0;
  let matched = false;
  while (offset < field.length) {
    item.lastIndex = offset;
    const next = item.exec(field);
    if (!next) return false;
    if (next[1] === current) matched = true;
    offset = item.lastIndex;
  }
  return matched;
}
export async function serveAvatarRelease(request, env, ctx) {
  return serve(request, env, ctx, avatarReleasePath(new URL(request.url).pathname), false);
}
export async function serveFlatAvatarGzip(request, env, ctx) {
  const match = /^\/bloom-character\/(assets\/[A-Za-z0-9_-]+-[\w-]{8}\.bin)$/.exec(
    new URL(request.url).pathname,
  );
  if (
    !match ||
    !acceptsGzip(request.cf?.clientAcceptEncoding ?? request.headers.get('Accept-Encoding')) ||
    !env.AVATAR_RUNTIME_RELEASES
  )
    return null;
  return serve(request, env, ctx, { key: `flat/${match[1]}`, type: TYPES.bin }, true);
}
async function serve(request, env, ctx, path, flat) {
  const responseHeaders = headers();
  responseHeaders.set('Cache-Control', 'no-store');
  responseHeaders.set('Vary', 'Accept-Encoding');
  if (!path) return new Response('Not found', { status: 404, headers: responseHeaders });
  if (request.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: responseHeaders });
  if (!['GET', 'HEAD'].includes(request.method)) {
    responseHeaders.set('Allow', 'GET, HEAD, OPTIONS');
    return new Response('Method not allowed', { status: 405, headers: responseHeaders });
  }
  // Keep our negotiated binary representation intact through the CDN. Other types
  // retain automatic Brotli/gzip; binary encoding is negotiated explicitly here.
  const binary = path.key.endsWith('.bin');
  const cacheControl = binary
    ? 'public, max-age=31536000, immutable, no-transform'
    : 'public, max-age=31536000, immutable';
  const gzip =
    binary &&
    acceptsGzip(request.cf?.clientAcceptEncoding ?? request.headers.get('Accept-Encoding'));
  const cache = globalThis.caches?.default;
  const cacheUrl = new URL(request.url);
  // Older production Cache API entries materialized decoded bodies with gzip headers.
  // Version binary entries and store encoded payloads as opaque bytes instead.
  cacheUrl.search = binary
    ? `?avatar-encoding=binary-v3-${gzip ? 'gzip' : 'identity'}`
    : '?avatar-encoding=identity';
  const cacheKey = new Request(cacheUrl, {
    method: 'GET',
    ...(binary ? { headers: { 'Accept-Encoding': gzip ? 'gzip' : 'identity' } } : {}),
  });
  const cached = cache ? await cache.match(cacheKey) : null;
  if (cached) {
    const cachedHeaders = new Headers(cached.headers);
    cachedHeaders.set('Cache-Control', cacheControl);
    const storedEncoding = cachedHeaders.get('X-Avatar-Stored-Encoding');
    if (storedEncoding) cachedHeaders.set('Content-Encoding', storedEncoding);
    cachedHeaders.delete('X-Avatar-Stored-Encoding');
    if (matchesIfNoneMatch(request.headers.get('If-None-Match'), cached.headers.get('ETag')))
      return new Response(null, { status: 304, headers: cachedHeaders });
    // Cache API does not preserve encodeBody. Reassert it on hits to avoid double gzip.
    return new Response(request.method === 'HEAD' ? null : cached.body, {
      headers: cachedHeaders,
      encodeBody: 'manual',
    });
  }
  if (!env.AVATAR_RUNTIME_RELEASES)
    return new Response('Runtime storage unavailable', { status: 503, headers: responseHeaders });
  const read = (key) =>
    request.method === 'HEAD'
      ? env.AVATAR_RUNTIME_RELEASES.head(key)
      : env.AVATAR_RUNTIME_RELEASES.get(key);
  let object = gzip ? await read(`${path.key}.gz`) : null;
  const encoded = !!object;
  if (!object && !flat) object = await read(path.key);
  if (!object)
    return flat ? null : new Response('Not found', { status: 404, headers: responseHeaders });
  responseHeaders.set('Content-Type', path.type);
  responseHeaders.set('Cache-Control', cacheControl);
  responseHeaders.set('ETag', object.httpEtag);
  if (encoded) responseHeaders.set('Content-Encoding', 'gzip');
  if (matchesIfNoneMatch(request.headers.get('If-None-Match'), object.httpEtag))
    return new Response(null, { status: 304, headers: responseHeaders });
  responseHeaders.set('Content-Length', String(object.size));
  const response = new Response(request.method === 'HEAD' ? null : object.body, {
    headers: responseHeaders,
    encodeBody: 'manual',
  });
  // clone() also loses manual encoding in workerd; cache an explicitly encoded response.
  // A missing sidecar must not pin raw bytes under the gzip cache key.
  if (cache && request.method === 'GET' && ctx?.waitUntil && (!gzip || encoded)) {
    const storedHeaders = new Headers(response.headers);
    // Cache API may decode Content-Encoding even when it preserves that header.
    // Cache an opaque binary payload and restore the wire encoding only on delivery.
    if (encoded) {
      storedHeaders.delete('Content-Encoding');
      storedHeaders.set('X-Avatar-Stored-Encoding', 'gzip');
    }
    ctx.waitUntil(
      cache.put(
        cacheKey,
        new Response(response.clone().body, { headers: storedHeaders, encodeBody: 'manual' }),
      ),
    );
  }
  return response;
}
