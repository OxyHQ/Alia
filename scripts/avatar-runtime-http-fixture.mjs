/** Test-only real workerd HTTP fixture: production Worker, local R2 and Cache API. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const canvasRequire = createRequire(join(repo, 'packages/alia-canvas/package.json'));
const wranglerRequire = createRequire(canvasRequire.resolve('wrangler/package.json'));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire('miniflare');
const source = resolve(process.argv[2]);
const manifestBytes = await readFile(join(source, 'manifest.json'));
const manifest = JSON.parse(manifestBytes);
const revision = createHash('sha256').update(manifestBytes).digest('hex');
const name = Object.keys(manifest.files).find((p) => /geometry.*\.bin$/.test(p));
const raw = await readFile(join(source, name));
const gzip = gzipSync(raw, { level: 6 });
const entry = `
import worker from './index.js';
let reads = 0;
const served = [], pending = [];
export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === '/__test_reads') {
      await Promise.all(pending);
      return Response.json({ reads, served });
    }
    const bucket = env.AVATAR_RUNTIME_RELEASES;
    const response = await worker.fetch(request, {
      ...env,
      AVATAR_RUNTIME_RELEASES: {
        get(key) { reads++; return bucket.get(key); },
        head(key) { reads++; return bucket.head(key); }
      }
    }, { waitUntil(task) { pending.push(task); ctx.waitUntil(task); } });
    served.push({
      path: new URL(request.url).pathname,
      acceptEncoding: request.headers.get('Accept-Encoding'),
      clientAcceptEncoding: request.cf?.clientAcceptEncoding,
      contentEncoding: response.headers.get('Content-Encoding')
    });
    return response;
  }
};`;

const mf = new Miniflare(
  convertV4MiniflareOptions({
    port: 6010,
    host: '127.0.0.1',
    compatibilityDate: '2026-08-24',
    modules: [
      { type: 'ESModule', path: join(repo, 'entry.js'), contents: entry },
      {
        type: 'ESModule',
        path: join(repo, 'index.js'),
        contents: await readFile(join(repo, 'packages/app/worker/index.js'), 'utf8'),
      },
      {
        type: 'ESModule',
        path: join(repo, 'avatar-releases.js'),
        contents: await readFile(join(repo, 'packages/app/worker/avatar-releases.js'), 'utf8'),
      },
    ],
    r2Buckets: ['AVATAR_RUNTIME_RELEASES'],
    serviceBindings: {
      ASSETS: async (request) =>
        new URL(request.url).pathname.endsWith(name)
          ? new Response(raw, { headers: { 'Content-Type': 'application/octet-stream' } })
          : new Response('<html>fallback</html>', { headers: { 'Content-Type': 'text/html' } }),
    },
  }),
);
const bucket = await mf.getR2Bucket('AVATAR_RUNTIME_RELEASES');
let gzipEtag;
for (const key of [`releases/${revision}/${name}`, `flat/${name}`]) {
  await bucket.put(key, raw, { httpMetadata: { contentType: 'application/octet-stream' } });
  const compressedObject = await bucket.put(`${key}.gz`, gzip, {
    httpMetadata: { contentType: 'application/octet-stream', contentEncoding: 'gzip' },
  });
  gzipEtag = compressedObject.httpEtag;
}
await mf.ready;
console.log(
  JSON.stringify({
    origin: 'http://127.0.0.1:6010',
    revision,
    name,
    rawBytes: raw.length,
    gzipBytes: gzip.length,
    gzipEtag,
    sha256: manifest.files[name],
    paths: [`/bloom-character/releases/${revision}/${name}`, `/bloom-character/${name}`],
  }),
);
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, async () => {
    await mf.dispose();
    process.exit(0);
  });
