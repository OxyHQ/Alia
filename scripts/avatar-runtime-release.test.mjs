import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import worker from '../packages/app/worker/index.js';
import {
  readAvatarRelease,
  publishAvatarRelease,
  s3RuntimeStore,
} from '../packages/app/scripts/publish-avatar-runtime.mjs';
const hash = (b) => createHash('sha256').update(b).digest('hex');
async function fixture(t, override) {
  const dir = await mkdtemp(join(tmpdir(), 'avatar-release-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'assets'));
  const files = {
    'runtime.mjs': Buffer.from('export const ready=true;'),
    'assets/geometry-ab123456.bin': Buffer.from([0, 1, 255]),
  };
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(dir, name), bytes);
  const manifest = {
    version: 1,
    entry: 'runtime.mjs',
    files: Object.fromEntries(Object.entries(files).map(([n, b]) => [n, hash(b)])),
    ...override,
  };
  await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
  return dir;
}
test('validates all bytes and exact manifest revision before publishing', async (t) => {
  const dir = await fixture(t),
    release = await readAvatarRelease(dir);
  assert.equal(release.files.at(-1).name, 'manifest.json');
  await assert.rejects(readAvatarRelease(dir, 'a'.repeat(64)), /revision/);
  await writeFile(join(dir, 'assets/geometry-ab123456.bin'), 'bad');
  await assert.rejects(readAvatarRelease(dir), /integrity/);
});
test('rejects traversal or malformed manifest entries', async (t) => {
  for (const path of [
    '../secret',
    'assets/../secret',
    'assets/%2e%2e/secret',
    'assets/file.html',
  ]) {
    const dir = await fixture(t, {
      files: { 'runtime.mjs': hash('export const ready=true;'), [path]: 'a'.repeat(64) },
    });
    await assert.rejects(readAvatarRelease(dir), /path/);
  }
});
test('append-only rerun reuses exact bytes, refuses changed content, manifest last', async (t) => {
  const release = await readAvatarRelease(await fixture(t));
  const objects = new Map(),
    writes = [];
  const store = {
    get: async (key) => objects.get(key) ?? null,
    create: async (key, bytes) => {
      assert(!objects.has(key));
      objects.set(key, bytes);
      writes.push(key);
    },
  };
  assert.equal((await publishAvatarRelease(release, store)).uploaded, 5);
  assert(writes.at(-1).endsWith('/manifest.json'));
  assert.equal((await publishAvatarRelease(release, store)).reused, 5);
  assert.equal(writes.length, 5);
  objects.set(release.files[0].key, Buffer.from('bad'));
  await assert.rejects(publishAvatarRelease(release, store), /overwrite/);
  assert.equal(writes.length, 5);
});
test('S3 adapter sends conditional create and tolerates concurrent identical winner', async () => {
  let call;
  const store = s3RuntimeStore({
    async send(command) {
      call = command.input;
      const error = new Error('exists');
      error.$metadata = { httpStatusCode: 412 };
      throw error;
    },
  });
  await store.create('releases/revision/runtime.mjs', Buffer.from('x'), 'text/javascript');
  assert.equal(call.IfNoneMatch, '*');
  assert.equal(call.Bucket, 'alia-avatar-runtime');
});
test('immutable release routing bypasses SPA and serves exact bytes, CORS, HEAD and ETag', async () => {
  const revision = 'a'.repeat(64),
    path = `/bloom-character/releases/${revision}/runtime.mjs`;
  const bytes = 'export const ok=true;';
  let lookups = 0;
  const object = { httpEtag: '"sha"', size: bytes.length, body: bytes };
  const env = {
    ASSETS: {
      fetch() {
        throw Error('must not reach SPA');
      },
    },
    AVATAR_RUNTIME_RELEASES: {
      async get(key) {
        lookups++;
        assert.equal(key, `releases/${revision}/runtime.mjs`);
        return object;
      },
      async head() {
        return object;
      },
    },
  };
  const request = (suffix = '', options = {}) =>
    worker.fetch(new Request(`https://example.test${path}${suffix}`, options), env);
  const response = await request();
  assert.equal(await response.text(), bytes);
  assert.match(response.headers.get('cache-control'), /immutable/);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.match(response.headers.get('content-type'), /javascript/);
  assert.equal((await request('', { method: 'HEAD' })).body, null);
  assert.equal((await request('', { headers: { 'If-None-Match': '"sha"' } })).status, 304);
  assert.equal((await request('', { method: 'POST' })).status, 405);
  const prior = lookups;
  assert.equal((await request('%2f..%2findex.html')).status, 404);
  assert.equal(lookups, prior);
  env.AVATAR_RUNTIME_RELEASES.get = async () => null;
  const missing = await request();
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('cache-control'), 'no-store');
  assert.notEqual(await missing.text(), '<html>');
});

test('successful release bytes are cached separately from SPA and reused for HEAD', async (t) => {
  const original = globalThis.caches;
  t.after(() => {
    globalThis.caches = original;
  });
  let stored,
    reads = 0;
  const pending = [];
  globalThis.caches = {
    default: {
      async match() {
        return stored?.clone();
      },
      async put(_key, response) {
        stored = response;
      },
    },
  };
  const env = {
    AVATAR_RUNTIME_RELEASES: {
      async get() {
        reads++;
        return { httpEtag: '"same"', size: 5, body: 'bytes' };
      },
    },
  };
  const url = `https://example.test/bloom-character/releases/${'a'.repeat(64)}/runtime.mjs`;
  assert.equal(
    await (await worker.fetch(new Request(url), env, { waitUntil: (p) => pending.push(p) })).text(),
    'bytes',
  );
  await Promise.all(pending);
  const second = await worker.fetch(new Request(`${url}?rev=ignored`, { method: 'HEAD' }), env, {});
  assert.equal(second.body, null);
  assert.equal(reads, 1);
  assert.equal(second.headers.get('content-length'), '5');
});

test('gzip negotiation preserves decoded bytes, q=0, ETags and both URL families', async () => {
  const { gzipSync, gunzipSync } = await import('node:zlib');
  const { acceptsGzip } = await import('../packages/app/worker/avatar-releases.js');
  for (const value of ['gzip', 'br, gzip;q=0.5', '*;q=1']) assert(acceptsGzip(value));
  for (const value of [null, 'identity', 'gzip;q=0', 'gzip;q=0, *;q=1', 'gzip;q=invalid'])
    assert(!acceptsGzip(value));
  const bytes = Buffer.from('same exact decoded bytes'.repeat(100)),
    compressed = gzipSync(bytes);
  const object = (body, etag) => ({ body, size: body.length, httpEtag: etag });
  const env = {
    ASSETS: {
      async fetch() {
        return new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } });
      },
    },
    AVATAR_RUNTIME_RELEASES: {
      async get(key) {
        return key.endsWith('.gz') ? object(compressed, '"gzip"') : object(bytes, '"raw"');
      },
    },
  };
  for (const path of [
    `/bloom-character/releases/${'a'.repeat(64)}/assets/geometry-ab123456.bin`,
    '/bloom-character/assets/geometry-ab123456.bin',
  ]) {
    const gzip = await worker.fetch(
      new Request(`https://example.test${path}`, { headers: { 'Accept-Encoding': 'gzip' } }),
      env,
      {},
    );
    assert.equal(gzip.headers.get('content-encoding'), 'gzip');
    assert.equal(gzip.headers.get('etag'), '"gzip"');
    assert.equal(gzip.headers.get('vary'), 'Accept-Encoding');
    assert.deepEqual(gunzipSync(Buffer.from(await gzip.arrayBuffer())), bytes);
    const raw = await worker.fetch(
      new Request(`https://example.test${path}`, {
        headers: { 'Accept-Encoding': 'gzip;q=0, *;q=1' },
      }),
      env,
      {},
    );
    assert.equal(raw.headers.get('content-encoding'), null);
    assert.deepEqual(Buffer.from(await raw.arrayBuffer()), bytes);
  }
  const rewritten = new Request(
    `https://example.test/bloom-character/releases/${'a'.repeat(64)}/assets/geometry-ab123456.bin`,
    { headers: { 'Accept-Encoding': 'br,gzip' } },
  );
  Object.defineProperty(rewritten, 'cf', { value: { clientAcceptEncoding: 'gzip;q=0' } });
  assert.equal((await worker.fetch(rewritten, env, {})).headers.get('content-encoding'), null);
  // A new ASSETS deployment can drop the old name; its gzip remains in durable storage.
  env.ASSETS.fetch = async () =>
    new Response('<html>new deployment</html>', { headers: { 'Content-Type': 'text/html' } });
  const old = await worker.fetch(
    new Request('https://example.test/bloom-character/assets/geometry-ab123456.bin', {
      headers: { 'Accept-Encoding': 'gzip' },
    }),
    env,
    {},
  );
  assert.deepEqual(gunzipSync(Buffer.from(await old.arrayBuffer())), bytes);
});

test('gzip and identity use distinct edge cache keys and ETags', async (t) => {
  const original = globalThis.caches;
  t.after(() => {
    globalThis.caches = original;
  });
  const objects = new Map(),
    tasks = [];
  globalThis.caches = {
    default: {
      async match(key) {
        return objects.get(key.url)?.clone();
      },
      async put(key, response) {
        objects.set(key.url, response);
      },
    },
  };
  const env = {
    AVATAR_RUNTIME_RELEASES: {
      async get(key) {
        return { httpEtag: key.endsWith('.gz') ? '"gzip"' : '"raw"', size: 1, body: 'x' };
      },
    },
  };
  const url = `https://example.test/bloom-character/releases/${'a'.repeat(64)}/assets/geometry-ab123456.bin`;
  for (const coding of ['gzip', 'identity'])
    await worker.fetch(new Request(url, { headers: { 'Accept-Encoding': coding } }), env, {
      waitUntil: (p) => tasks.push(p),
    });
  await Promise.all(tasks);
  assert.equal(objects.size, 2);
  assert.deepEqual(
    new Set([...objects.values()].map((r) => r.headers.get('etag'))),
    new Set(['"gzip"', '"raw"']),
  );
});

test('a missing gzip sidecar never pins raw bytes in the gzip cache', async (t) => {
  const original = globalThis.caches;
  t.after(() => {
    globalThis.caches = original;
  });
  let sidecar = false;
  const stored = new Map(),
    tasks = [];
  globalThis.caches = {
    default: {
      async match(key) {
        return stored.get(key.url)?.clone();
      },
      async put(key, value) {
        stored.set(key.url, value);
      },
    },
  };
  const env = {
    AVATAR_RUNTIME_RELEASES: {
      async get(key) {
        if (key.endsWith('.gz') && !sidecar) return null;
        return { httpEtag: key.endsWith('.gz') ? '"gzip"' : '"raw"', size: 1, body: 'x' };
      },
    },
  };
  const request = () =>
    new Request(
      `https://example.test/bloom-character/releases/${'a'.repeat(64)}/assets/geometry-ab123456.bin`,
      { headers: { 'Accept-Encoding': 'gzip' } },
    );
  const first = await worker.fetch(request(), env, { waitUntil: (p) => tasks.push(p) });
  assert.equal(first.headers.get('content-encoding'), null);
  await Promise.all(tasks);
  assert.equal(stored.size, 0);
  sidecar = true;
  const next = await worker.fetch(request(), env, { waitUntil: (p) => tasks.push(p) });
  assert.equal(next.headers.get('content-encoding'), 'gzip');
  await Promise.all(tasks);
  assert.equal(stored.size, 1);
});

test('binary cached hits gain no-transform while runtime and manifest retain CDN compression', async (t) => {
  const original = globalThis.caches;
  t.after(() => {
    globalThis.caches = original;
  });
  globalThis.caches = {
    default: {
      async match() {
        return new Response('old cached bytes', {
          headers: { 'Cache-Control': 'public, max-age=31536000, immutable', ETag: '"old"' },
        });
      },
    },
  };
  for (const name of ['assets/geometry-ab123456.bin', 'runtime.mjs', 'manifest.json']) {
    const response = await worker.fetch(
      new Request(`https://example.test/bloom-character/releases/${'a'.repeat(64)}/${name}`),
      {},
      {},
    );
    assert.equal(
      response.headers.get('cache-control').includes('no-transform'),
      name.endsWith('.bin'),
    );
  }
  globalThis.caches = undefined;
  for (const name of ['runtime.mjs', 'manifest.json']) {
    const response = await worker.fetch(
      new Request(`https://example.test/bloom-character/releases/${'a'.repeat(64)}/${name}`),
      {
        AVATAR_RUNTIME_RELEASES: {
          async get() {
            return { body: 'bytes', size: 5, httpEtag: '"new"' };
          },
        },
      },
      {},
    );
    assert(!response.headers.get('cache-control').includes('no-transform'));
  }
});

test('binary cache requests explicitly negotiate their encoding and bypass preceding keys', async (t) => {
  const original = globalThis.caches;
  t.after(() => {
    globalThis.caches = original;
  });
  const seen = [];
  globalThis.caches = {
    default: {
      async match(request) {
        seen.push({ url: request.url, encoding: request.headers.get('Accept-Encoding') });
        return null;
      },
    },
  };
  const env = {
    AVATAR_RUNTIME_RELEASES: {
      async get() {
        return { body: 'bytes', size: 5, httpEtag: '"x"' };
      },
    },
  };
  const base = `https://example.test/bloom-character/releases/${'a'.repeat(64)}/`;
  for (const encoding of ['gzip', 'identity'])
    await worker.fetch(
      new Request(`${base}assets/geometry-ab123456.bin`, {
        headers: { 'Accept-Encoding': encoding },
      }),
      env,
      {},
    );
  await worker.fetch(
    new Request(`${base}runtime.mjs`, { headers: { 'Accept-Encoding': 'gzip' } }),
    env,
    {},
  );
  assert.deepEqual(
    seen.map((x) => x.encoding),
    ['gzip', 'identity', null],
  );
  assert.equal(new URL(seen[0].url).search, '?avatar-encoding=binary-v2-gzip');
  assert.equal(new URL(seen[1].url).search, '?avatar-encoding=binary-v2-identity');
  assert.equal(new URL(seen[2].url).search, '?avatar-encoding=identity');
});
