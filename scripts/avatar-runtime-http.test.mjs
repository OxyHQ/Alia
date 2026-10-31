import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
test('real workerd gzip misses and Cache API hits decode exactly, including HEAD and q=0', {
  timeout: 60000,
}, async (t) => {
  const directory =
    process.env.AVATAR_RUNTIME_DIR ??
    join(dirname(require.resolve('@oxy.so/bloom/package.json')), 'assets', 'character-runtime');
  const child = spawn(process.execPath, ['scripts/avatar-runtime-http-fixture.mjs', directory], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGTERM'));
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const info = await new Promise((resolve, reject) => {
    let text = '';
    child.stdout.on('data', (chunk) => {
      text += chunk;
      const line = text.split('\n').find((x) => x.startsWith('{') && x.endsWith('}'));
      if (line) resolve(JSON.parse(line));
    });
    child.once('exit', (code) => reject(Error(`Fixture exited${code}: ${stderr}`)));
  });
  const conditions = [info.gzipEtag, `W/${info.gzipEtag}`, `"other", W/${info.gzipEtag}`, '*'];
  const checkConditionals = async () => {
    for (const path of info.paths) {
      for (const method of ['GET', 'HEAD']) {
        for (const condition of conditions) {
          const response = await fetch(info.origin + path, {
            method,
            headers: {
              'Accept-Encoding': 'gzip',
              'If-None-Match': condition,
            },
          });
          assert.equal(response.status, 304, `${method} ${condition} ${path}`);
          assert.equal((await response.arrayBuffer()).byteLength, 0);
          assert.equal(response.headers.get('etag'), info.gzipEtag);
          assert.equal(response.headers.get('x-avatar-stored-encoding'), null);
        }
      }
    }
  };
  await checkConditionals();
  const missReads = (await (await fetch(`${info.origin}/__test_reads`)).json()).reads;
  assert.equal(missReads, 16, 'conditional misses inspect R2 without populating body cache');
  for (const path of info.paths) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(info.origin + path, { headers: { 'Accept-Encoding': 'gzip' } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-encoding'), 'gzip');
      assert.match(response.headers.get('cache-control'), /no-transform/);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.length, info.rawBytes);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), info.sha256);
      // Drain waitUntil cache writes before asserting that the next request is a hit.
      await fetch(`${info.origin}/__test_reads`);
    }
    const head = await fetch(info.origin + path, {
      method: 'HEAD',
      headers: { 'Accept-Encoding': 'gzip' },
    });
    assert.equal(head.headers.get('content-encoding'), 'gzip');
    assert.equal(+head.headers.get('content-length'), info.gzipBytes);
  }
  assert.equal(
    (await (await fetch(`${info.origin}/__test_reads`)).json()).reads,
    missReads + 2,
    'second requests must hit edge cache',
  );
  await checkConditionals();
  assert.equal(
    (await (await fetch(`${info.origin}/__test_reads`)).json()).reads,
    missReads + 2,
    'conditional cache hits must not reread R2',
  );
  for (const path of info.paths) {
    const response = await fetch(info.origin + path, {
      headers: { 'Accept-Encoding': 'gzip;q=0, *;q=1' },
    });
    assert.equal(response.headers.get('content-encoding'), null);
    assert.match(response.headers.get('cache-control'), /no-transform/);
    assert.match(response.headers.get('vary'), /Accept-Encoding/);
    assert.equal(
      createHash('sha256')
        .update(Buffer.from(await response.arrayBuffer()))
        .digest('hex'),
      info.sha256,
    );
  }
});
