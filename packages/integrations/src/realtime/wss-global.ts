/**
 * Typed accessor for the process-global WebSocket server.
 *
 * The WS server is stored on `globalThis.__wss` so that streaming helpers across
 * the codebase (terminal, browser, realtime) can broadcast without threading the
 * instance through every call site.
 */

import type { WebSocketServer, WebSocket } from 'ws';

/** A subscribed client carries the `sessionId` it is listening to. */
export type SessionWebSocket = WebSocket & { sessionId?: string };

declare global {
  // eslint-disable-next-line no-var
  var __wss: WebSocketServer | undefined;
}

export function getWss(): WebSocketServer | undefined {
  return globalThis.__wss;
}

export function setWss(wss: WebSocketServer): void {
  globalThis.__wss = wss;
}
