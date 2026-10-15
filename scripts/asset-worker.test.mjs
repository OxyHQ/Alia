import assert from 'node:assert/strict';
import { test } from 'node:test';
import aliaCanvasWorker from '../packages/alia-canvas/worker/index.js';
import appWorker from '../packages/app/worker/index.js';

for (const [name, worker] of [
  ['app', appWorker],
  ['alia-canvas', aliaCanvasWorker],
]) {
  test(`${name} keeps asset streams, headers and errors`, async () => {
    const response = new Response('asset bytes', {
      headers: {
        'content-type': 'application/javascript',
        'cache-control': 'public, max-age=3600',
      },
    });
    const request = new Request('https://example.test/assets/app.js');
    const env = {
      ASSETS: {
        fetch: async (received) => {
          assert.equal(received, request);
          return response;
        },
      },
    };
    const ctx = {
      waitUntil() {
        throw new Error('the asset Worker schedules no background work');
      },
    };
    assert.equal(await worker.fetch(request, env, ctx), response);
    assert.equal(await response.text(), 'asset bytes');
    const failure = new Error('asset binding failure');
    env.ASSETS.fetch = async () => {
      throw failure;
    };
    await assert.rejects(worker.fetch(request, env, ctx), (error) => error === failure);
  });
}

test('app serves the character runtime to any origin', async () => {
  const env = { ASSETS: { fetch: async () => new Response('runtime') } };
  const shared = await appWorker.fetch(
    new Request('https://example.test/bloom-character/runtime.mjs'),
    env,
    {},
  );
  assert.equal(shared.headers.get('access-control-allow-origin'), '*');
  assert.equal(await shared.text(), 'runtime');
});

const serve = (response) => ({ ASSETS: { fetch: async () => response } });
const get = (path, response) =>
  appWorker.fetch(new Request(`https://example.test${path}`), serve(response), {});
const asset = (status = 200, type = 'application/octet-stream') =>
  new Response(status === 304 ? null : 'bytes', {
    status,
    headers: {
      'content-type': type,
      'cache-control': 'public, max-age=0, must-revalidate',
      etag: '"abc"',
    },
  });
const IMMUTABLE = 'public, max-age=31536000, immutable';

test('app serves content-hashed files for a year, immutable', async () => {
  for (const path of [
    '/bloom-character/assets/furCards-Bsdd0YY1.bin',
    '/bloom-character/assets/geometry--n2o_fbw.bin',
    '/bloom-character/chunks/avatar-pool-Bi4opEMV.mjs',
    '/_expo/static/js/web/index-b4703dcbb2781575faf678d4b468b831.js',
    '/_expo/static/css/global-05f0886e18b70fd6baa79d66fc497c4e.css',
    '/assets/__node_modules/expo-router/assets/back-icon.35ba0eaec5a4f5ed12ca16fabeae451d.png',
  ]) {
    const response = await get(path, asset());
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('cache-control'), IMMUTABLE, path);
    assert.equal(response.headers.get('etag'), '"abc"', path);
    assert.equal(await response.text(), 'bytes', path);
  }
});

test("a revalidation of a hashed file is answered immutable too, so an old visitor's copy stops asking", async () => {
  const response = await get('/bloom-character/assets/furCards-Bsdd0YY1.bin', asset(304));
  assert.equal(response.status, 304);
  assert.equal(response.headers.get('cache-control'), IMMUTABLE);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
});

test('entry files keep the revalidate-every-time default', async () => {
  for (const path of [
    '/',
    '/index.html',
    '/sw.js',
    '/agent-avatar-reference.png',
    '/bloom-character/runtime.mjs',
    '/bloom-character/manifest.json',
    '/bloom-character/README.md',
  ]) {
    const response = await get(path, asset(200, 'text/plain'));
    assert.equal(response.headers.get('cache-control'), 'public, max-age=0, must-revalidate', path);
  }
  const runtime = await get('/bloom-character/runtime.mjs', asset());
  assert.equal(runtime.headers.get('access-control-allow-origin'), '*');
});

test('a hashed name this deploy lacks is a 404 nothing keeps, never the app shell', async () => {
  const shell = asset(200, 'text/html; charset=utf-8');
  for (const path of [
    '/_expo/static/js/web/index-00000000000000000000000000000000.js',
    '/bloom-character/assets/furCards-Gone0000.bin',
  ]) {
    const response = await get(path, shell);
    assert.equal(response.status, 404, path);
    assert.equal(response.headers.get('cache-control'), 'no-store', path);
  }
  const route = await get('/c/some-conversation', asset(200, 'text/html'));
  assert.equal(route.status, 200);
});
