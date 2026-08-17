import { readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Nagle, on the surface every shipped client actually uses — epic #139
 * workstream 19.
 *
 * ## The reported finding, and what measuring it showed
 *
 * `/alia/chat` has a per-route middleware that calls `res.socket.setNoDelay(true)`
 * and `res.socket.setTimeout(0)`; `/v1` has only `X-Accel-Buffering`. Since `/v1`
 * is the live surface — `packages/app`, `@alia.onl/sdk`, `alia-codea` and
 * `packages/integrations` all POST it, and `/alia/chat` has no in-repo caller —
 * that reads as the treatment being missing from the one that matters.
 *
 * It is not. `index.ts` registers a `connection` handler on the HTTP SERVER that
 * calls `socket.setNoDelay(true)` for EVERY accepted connection, `/v1` included,
 * and it runs at connection establishment rather than per request — earlier and
 * broader than the per-route middleware. Measured under node v22 by spying on
 * `net.Socket.prototype`: a server built like `index.ts` records
 * `setNoDelay(true)` for a connection serving `/v1`; the same server without the
 * handler records none.
 *
 * The other half of the middleware is a no-op wherever it runs. `server.timeout`
 * defaults to `0`, so node's own HTTP server already calls `socket.setTimeout(0)`
 * on the connection — observed in all three configurations, including the one
 * with no treatment at all.
 *
 * First-frame timings over loopback, median of seven runs each, forty 1ms
 * frames: `/v1`-shaped 0.85ms, `/alia/chat`-shaped 0.65ms, no treatment 0.34ms,
 * largest inter-frame gap 2ms in every configuration. The differences are noise
 * and the ordering is the opposite of the Nagle hypothesis. **The conclusion
 * rests on the state measurement, not on these numbers** — loopback is exactly
 * where Nagle is least visible, so a timing run here cannot prove absence of a
 * cost on a real network. What it can do, and does, is fail to find the 40ms
 * delayed-ACK stall that a Nagle problem produces.
 *
 * So nothing about the two surfaces was changed. What is added is this file:
 * the treatment is one line in `index.ts` serving every stream, and deleting it
 * would silently cost `/v1` the first frame of every SSE response.
 *
 * ## What this file can and cannot see
 *
 * It reads source. It cannot boot `index.ts` — importing it opens a socket and
 * connects to two databases — so it cannot observe the real server's own
 * sockets. What it CAN do, and does below, is verify against a live socket that
 * the shape it asserts in source is the shape that produces the behaviour: the
 * `connection`-handler construction is exercised for real, so "the source says
 * `setNoDelay`" is not the whole of the claim.
 */

const PACKAGE_SRC = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const boot = readFileSync(path.join(PACKAGE_SRC, 'index.ts'), 'utf8');

describe('the boot file was read, so an absence is an absence', () => {
  it('is the real entrypoint', () => {
    expect(boot.length).toBeGreaterThan(5_000);
    expect(boot).toContain('const server = http.createServer(');
    expect(boot).toContain('server.listen(PORT');
  });
});

describe('every connection gets Nagle disabled, /v1 included (#139 ws19)', () => {
  it('the server-level connection handler disables Nagle', () => {
    // The one line the live streaming surface depends on. It is asserted as a
    // handler ON THE SERVER rather than as the substring `setNoDelay`, because
    // the same call inside a per-route middleware would satisfy a substring
    // search while covering one route instead of all of them.
    const handler = /server\.on\('connection',\s*\(socket\)\s*=>\s*\{([\s\S]*?)\n\}\);/.exec(boot);
    expect(handler, "the server's connection handler moved or was renamed").not.toBeNull();
    expect(handler?.[1]).toContain('socket.setNoDelay(true)');
  });

  it('the handler is registered on the server that serves the routes', () => {
    // A `connection` handler on some other server would pass the check above and
    // do nothing for `/v1`. There is one `http.createServer` in this file, it is
    // assigned to `server`, and `server` is what listens.
    expect(boot.match(/http\.createServer\(/g)).toHaveLength(1);
    expect(boot.indexOf('const server = http.createServer(')).toBeLessThan(
      boot.indexOf("server.on('connection'"),
    );
    expect(boot.indexOf("server.on('connection'")).toBeLessThan(boot.indexOf('server.listen(PORT'));
  });

  it('/v1 still gets the proxy-buffering header, which is a different control', () => {
    // `X-Accel-Buffering` tells an nginx in front of the process not to buffer;
    // `setNoDelay` tells the kernel not to. Neither substitutes for the other,
    // and both are load-bearing for a stream.
    expect(boot).toContain("app.use('/v1', (_req, res, next) => {");
    expect(boot).toContain("res.setHeader('X-Accel-Buffering', 'no');");
  });

  it('a server built that way really does disable Nagle on the socket it accepts', async () => {
    // The half a source census cannot reach: that this construction has the
    // effect the assertions above assume. `net.Socket.prototype` is spied
    // because node exposes no readable `noDelay`, and the control is the second
    // server, which is identical except for the handler.
    const original = net.Socket.prototype.setNoDelay;
    const seen: boolean[] = [];
    net.Socket.prototype.setNoDelay = function patched(this: net.Socket, value?: boolean) {
      seen.push(value === true);
      return original.call(this, value);
    };

    try {
      const withHandler = await probe(true);
      const withoutHandler = await probe(false);
      expect(withHandler).toBe(true);
      // The control. Without it, "Nagle was disabled" is also what a runtime
      // that disables it for every socket by default would report.
      expect(withoutHandler).toBe(false);
    } finally {
      net.Socket.prototype.setNoDelay = original;
    }

    async function probe(register: boolean): Promise<boolean> {
      const before = seen.length;
      const server = http.createServer(
        { maxHeaderSize: 16384, keepAlive: true, keepAliveTimeout: 65000 },
        (_req, res) => {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.end(': keep-alive\n\n');
        },
      );
      if (register) {
        server.on('connection', (socket) => {
          socket.setNoDelay(true);
          socket.setKeepAlive(true, 60000);
        });
      }
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      await new Promise<void>((resolve, reject) => {
        const request = http.get({ hostname: '127.0.0.1', port, path: '/v1/chat/completions' }, (res) => {
          res.resume();
          res.on('end', resolve);
        });
        request.on('error', reject);
      });
      await new Promise<void>((resolve) => server.close(() => resolve()));
      return seen.slice(before).some(Boolean);
    }
  });
});

describe('what the per-route middleware on /alia/chat adds', () => {
  it('re-applies setNoDelay and sets a socket timeout node has already set', () => {
    // Kept as a statement of the measurement rather than removed: the middleware
    // is redundant with the server-level handler and with node's own default
    // (`server.timeout` is 0, so node calls `socket.setTimeout(0)` itself), and
    // the reason it was not deleted is that deleting a redundant safety net on a
    // dead surface buys nothing and costs the next reader the measurement.
    expect(boot).toContain("app.use('/alia/chat', (_req, res, next) => {");
    expect(boot).toContain('res.socket.setNoDelay(true)');
    expect(boot).toContain('res.socket.setTimeout(0)');
    expect(new http.Server().timeout).toBe(0);
  });
});
