/**
 * The browser worker's HTTP API, reachable only on the browser's internal
 * Docker network and only with the token the control API generated when it
 * created this container (`browser-stack.ts`). The egress proxy shares the
 * network and does NOT hold the token.
 *
 * Adapted from OpenMuse `apps/worker/src/server.ts` (MIT, see ../../NOTICE).
 *
 *   GET    /health
 *   GET    /overview                              { contexts, browser, idleForMs }
 *   GET    /actors/:key                           session status
 *   POST   /actors/:key/open        { url?, by }
 *   POST   /actors/:key/navigate    { url, by }
 *   GET    /actors/:key/read                      { url, title, text, truncated, elements }
 *   GET    /actors/:key/screenshot                image/jpeg, 1280×800
 *   POST   /actors/:key/input       { input, by }
 *   POST   /actors/:key/control     { controller }
 *   POST   /actors/:key/close
 *   GET    /actors/:key/downloads                 { downloads, failures }
 *   GET    /actors/:key/downloads/:id             the bytes
 *   DELETE /actors/:key/downloads/:id
 *
 * `:key` is the actor's hash. Responses are `{ data }` or `{ error: { code, message } }`.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { actorRoleSchema, browserInputSchema } from './input.js';
import { BlockedDestination } from './network.js';
import { PoolError, type BrowserPool } from './pool.js';

const BODY_LIMIT = 64 * 1024;
const urlField = z.string().min(1).max(8192);
const openSchema = z.object({ url: urlField.optional(), by: actorRoleSchema }).strict();
const navigateSchema = z.object({ url: urlField, by: actorRoleSchema }).strict();
const inputSchema = z.object({ input: browserInputSchema, by: actorRoleSchema }).strict();
const controlSchema = z.object({ controller: actorRoleSchema }).strict();

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > BODY_LIMIT) throw new PoolError('body_too_large', 'Request body too large', 413);
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new PoolError('invalid_request', 'A JSON body is required', 400);
  }
}

export function createWorkerServer(options: { pool: BrowserPool; token: string }) {
  if (options.token.length < 32)
    throw new Error('ALIA_BROWSER_TOKEN must be at least 32 characters');
  const expected = createHash('sha256').update(`Bearer ${options.token}`).digest();
  const { pool } = options;

  const send = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(JSON.stringify(body));
  };

  const server = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? '/', 'http://worker').pathname;
      const method = request.method ?? 'GET';
      if (method === 'GET' && path === '/health')
        return send(response, 200, { data: { ok: true } });

      const presented = createHash('sha256')
        .update(request.headers.authorization ?? '')
        .digest();
      if (!timingSafeEqual(presented, expected)) {
        return send(response, 401, {
          error: { code: 'unauthenticated', message: 'Worker token required' },
        });
      }
      if (method === 'GET' && path === '/overview')
        return send(response, 200, { data: pool.overview() });

      const match = /^\/actors\/([0-9a-f]{24})(?:\/([a-z]+)(?:\/([0-9a-f-]{36}))?)?$/.exec(path);
      if (!match) throw new PoolError('not_found', 'No such route', 404);
      const [, key, action, id] = match as unknown as [
        string,
        string,
        string | undefined,
        string | undefined,
      ];

      if (!action && method === 'GET') return send(response, 200, { data: await pool.status(key) });
      if (action === 'open' && method === 'POST') {
        const body = openSchema.parse(await readJson(request));
        return send(response, 200, { data: await pool.open(key, body.url, body.by) });
      }
      if (action === 'navigate' && method === 'POST') {
        const body = navigateSchema.parse(await readJson(request));
        return send(response, 200, { data: await pool.navigate(key, body.url, body.by) });
      }
      if (action === 'read' && method === 'GET')
        return send(response, 200, { data: await pool.read(key) });
      if (action === 'screenshot' && method === 'GET') {
        const bytes = await pool.screenshot(key);
        response.writeHead(200, {
          'content-type': 'image/jpeg',
          'content-length': bytes.length,
          'cache-control': 'no-store',
        });
        response.end(bytes);
        return;
      }
      if (action === 'input' && method === 'POST') {
        const body = inputSchema.parse(await readJson(request));
        return send(response, 200, { data: await pool.input(key, body.input, body.by) });
      }
      if (action === 'control' && method === 'POST') {
        const body = controlSchema.parse(await readJson(request));
        return send(response, 200, { data: await pool.control(key, body.controller) });
      }
      if (action === 'close' && method === 'POST')
        return send(response, 200, { data: await pool.close(key) });
      if (action === 'downloads' && !id && method === 'GET')
        return send(response, 200, { data: await pool.downloads(key) });
      if (action === 'downloads' && id && method === 'GET') {
        const { meta, bytes } = await pool.download(key, id);
        response.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': bytes.length,
          'x-download-name': encodeURIComponent(meta.name),
          'x-download-type': meta.mimeType,
        });
        response.end(bytes);
        return;
      }
      if (action === 'downloads' && id && method === 'DELETE') {
        await pool.forgetDownload(key, id);
        return send(response, 200, { data: { ok: true } });
      }
      throw new PoolError('not_found', 'No such route', 404);
    })().catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof PoolError)
        return send(response, error.status, {
          error: { code: error.code, message: error.message },
        });
      if (error instanceof BlockedDestination) {
        return send(response, error.code === 'dns_unavailable' ? 502 : 400, {
          error: { code: error.code, message: error.message },
        });
      }
      if (error instanceof z.ZodError) {
        return send(response, 400, {
          error: {
            code: 'invalid_request',
            message: error.issues[0]?.message ?? 'Invalid request',
          },
        });
      }
      send(response, 500, {
        error: { code: 'worker_failed', message: 'The browser operation failed.' },
      });
    });
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
