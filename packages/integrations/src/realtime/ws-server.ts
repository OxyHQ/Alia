/**
 * WebSocket server utilities for real-time streaming.
 * Terminal output and browser screenshots are streamed to frontend clients.
 *
 * Protocol:
 * Client → Server:
 *   { type: "subscribe", sessionId: "abc" }     — subscribe to a session's streams
 *   { type: "terminal_input", data: "ls\n" }     — send input to terminal
 *
 * Server → Client:
 *   { type: "terminal", sessionId: "abc", data: "output..." }
 *   { type: "screenshot", sessionId: "abc", data: "base64..." }
 *   { type: "browser", sessionId: "abc", action: "navigate", url: "..." }
 *   { type: "status", sessionId: "abc", action: "Browsing google.com" }
 *   { type: "terminal_exit", sessionId: "abc" }
 */

import { getWss, type SessionWebSocket } from './wss-global';

/**
 * Broadcast a message to all WebSocket clients subscribed to a session.
 */
export function broadcastToSession(sessionId: string, type: string, data: Record<string, unknown>) {
  const wss = getWss();
  if (!wss) return;

  const message = JSON.stringify({ type, sessionId, ...data });

  for (const client of wss.clients) {
    const ws = client as SessionWebSocket;
    if (ws.sessionId === sessionId && ws.readyState === 1) {
      ws.send(message);
    }
  }
}

/**
 * Broadcast a status update (shown as activity indicator in the frontend).
 */
export function broadcastStatus(sessionId: string, action: string) {
  broadcastToSession(sessionId, 'status', { action });
}
