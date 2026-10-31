import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const revision =
  process.argv[2] ??
  require('@oxy.so/bloom-avatar-native/runtime-revision').AVATAR_RUNTIME_REVISION;
assert.match(revision, /^[a-f0-9]{64}$/);
const origin = process.argv[3] ?? 'https://alia.onl';
const root = `${origin}/bloom-character/releases/${revision}/`;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function read(path, expected, type) {
  const response = await fetch(root + path);
  assert.equal(response.status, 200, path);
  assert.equal(response.headers.get('access-control-allow-origin'), '*', path);
  assert.match(response.headers.get('cache-control') ?? '', /immutable/, path);
  assert.match(response.headers.get('content-type') ?? '', type, path);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(hash(bytes), expected, path);
  return {
    bytes,
    summary: {
      path,
      decodedBytes: bytes.length,
      contentEncoding: response.headers.get('content-encoding'),
    },
  };
}
const manifest = await read('manifest.json', revision, /application\/json/);
const files = JSON.parse(manifest.bytes).files;
const paths = [
  'runtime.mjs',
  Object.keys(files).find((p) => /geometry.*\.bin$/.test(p)),
  Object.keys(files).find((p) => /motion.*work.*\.bin$/.test(p)),
];
assert(paths.every(Boolean), 'manifest must include base geometry and lazy work bytes');
const samples = [manifest.summary];
for (const path of paths)
  samples.push(
    (await read(path, files[path], path.endsWith('.mjs') ? /javascript/ : /octet-stream/)).summary,
  );
const binary = paths.find((path) => path.endsWith('.bin'));
const representations = [];
for (const url of [root + binary, `${origin}/bloom-character/${binary}`]) {
  for (const encoding of ['gzip', 'gzip;q=0, *;q=1']) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(url, { headers: { 'Accept-Encoding': encoding } });
      assert.equal(response.status, 200, url);
      assert.match(response.headers.get('vary') ?? '', /Accept-Encoding/, url);
      assert.equal(response.headers.get('content-encoding'), encoding === 'gzip' ? 'gzip' : null);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(hash(bytes), files[binary], url);
      representations.push({
        url,
        encoding,
        attempt,
        decodedBytes: bytes.length,
        etag: response.headers.get('etag'),
      });
    }
  }
}
const missing = await fetch(`${root}assets/missing-00000000.bin`);
assert.equal(missing.status, 404);
assert.equal(missing.headers.get('cache-control'), 'no-store');
assert.doesNotMatch(missing.headers.get('content-type') ?? '', /text\/html/);
console.log(
  JSON.stringify(
    { revision, manifestFiles: Object.keys(files).length, samples, representations, missing: 404 },
    null,
    2,
  ),
);
