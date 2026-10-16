/**
 * Every WebSocket upgrade on Alia's HTTP server is routed HERE, once.
 *
 * Three surfaces share the server: socket.io (chat events, `/socket.io/`), the
 * MCP relay (`/ws/mcp`) and voice calls (`/v1/voice/session`). Before this
 * module each one installed its own `server.on('upgrade')`, and socket.io's
 * engine kept its default `destroyUpgrade`: one second after any upgrade that
 * was not its own, it ended the socket unless `socket.bytesWritten > 0`. Under
 * Node the 101 another listener had written made that true; under Bun (the API's
 * runtime) an upgraded socket reports `bytesWritten` 0, so engine.io ended every
 * voice and relay socket ~1 s after it opened — a browser saw close 1006 and the
 * call looped "listening… reconnecting…". The tests ran on Node, which is why
 * they never saw it (`websocket-upgrades.test.ts` now runs on both runtimes).
 *
 * So the rule is: socket.io serves its own path with its own listener and
 * `destroyUpgrade: false` (`socket.ts`); every other path is one of the routes
 * below; anything else is refused here with a 404, which is the job engine.io's
 * timer was doing badly.
 */

import type http from 'node:http';
import type { Duplex } from 'node:stream';

/** One path's WebSocket endpoint. From `handleUpgrade` on the socket is the route's. */
export interface WebSocketRoute {
  readonly path: string;
  handleUpgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer): void;
}

const NOT_FOUND = 'HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n';

/**
 * Route every upgrade: `socketIoPath` is left to socket.io's own listener, a
 * route's exact path goes to that route, any other path is answered 404.
 */
export function routeWebSocketUpgrades(
  server: http.Server,
  input: { readonly socketIoPath: string; readonly routes: readonly WebSocketRoute[] },
): void {
  const routes = new Map(input.routes.map((route) => [route.path, route]));
  if (routes.size !== input.routes.length) throw new Error('Two WebSocket routes share a path');
  server.on('upgrade', (request: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const { pathname } = new URL(request.url ?? '', 'http://internal');
    if (pathname.startsWith(input.socketIoPath)) return;
    const route = routes.get(pathname);
    if (route) {
      route.handleUpgrade(request, socket, head);
      return;
    }
    socket.end(NOT_FOUND);
  });
}
