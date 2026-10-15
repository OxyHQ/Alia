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
