/**
 * The smallest static server that can serve an Expo web export.
 *
 * Node's own `http` rather than a package: the harness is checked in and run
 * rarely, and a dependency whose whole job is mapping extensions to MIME types
 * is a dependency that has to be audited, upgraded and trusted forever.
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

async function fileAt(path) {
  try {
    const info = await stat(path);
    return info.isFile() ? info : null;
  } catch {
    return null;
  }
}

/**
 * Serves `root` on an ephemeral loopback port, falling back to `index.html` for
 * any extension-less path — the export is a single-page app, so every route the
 * harness visits is that one document.
 *
 * @param {string} root
 * @returns {Promise<{ origin: string, close: () => Promise<void> }>}
 */
export async function serveExport(root) {
  const base = resolve(root);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const requested = decodeURIComponent(url.pathname);
    // `normalize` collapses `..` before the prefix check, so a traversal
    // attempt lands outside `base` and is refused rather than served.
    let target = normalize(join(base, requested));
    if (target !== base && !target.startsWith(base + sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }

    let info = await fileAt(target);
    if (!info && !extname(requested)) {
      target = join(base, 'index.html');
      info = await fileAt(target);
    }
    if (!info) {
      res.writeHead(404).end('not found');
      return;
    }

    res.writeHead(200, {
      'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'content-length': String(info.size),
      // Never let a stale response survive between runs of the harness.
      'cache-control': 'no-store',
    });
    createReadStream(target).pipe(res);
  });

  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', done);
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections?.();
        server.close(() => done());
      }),
  };
}
