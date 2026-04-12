import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';

interface Client {
  ws: WebSocket;
  channels: Set<string>;
}

const clients = new Set<Client>();

// --------------- Heartbeat ---------------
const HEARTBEAT_INTERVAL_MS = 30_000;

/** Tracks whether each client responded to the last protocol-level ping. */
const clientAlive = new WeakMap<WebSocket, boolean>();

export const providersWss = new WebSocketServer({ noServer: true });

const heartbeatInterval = setInterval(() => {
  providersWss.clients.forEach((ws) => {
    if (clientAlive.get(ws) === false) {
      // Client missed the previous pong — consider it stale and terminate.
      ws.terminate();
      return;
    }
    clientAlive.set(ws, false);
    ws.ping(); // WebSocket protocol-level ping
  });
}, HEARTBEAT_INTERVAL_MS);

heartbeatInterval.unref();

/** Stop the heartbeat interval (call during graceful shutdown). */
export function stopHeartbeat(): void {
  clearInterval(heartbeatInterval);
}

// --------------- Connection handling ---------------

providersWss.on('connection', (ws: WebSocket, _req: IncomingMessage) => {
  const client: Client = { ws, channels: new Set() };
  clients.add(client);

  // Mark the client as alive on initial connection
  clientAlive.set(ws, true);

  // Protocol-level pong response — keeps heartbeat aware the client is alive
  ws.on('pong', () => {
    clientAlive.set(ws, true);
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      if (msg.type === 'subscribe' && msg.channel) {
        client.channels.add(msg.channel);
        return;
      }

      if (msg.type === 'unsubscribe' && msg.channel) {
        client.channels.delete(msg.channel);
        return;
      }
    } catch {
      ws.send(JSON.stringify({ type: 'error', error: 'Invalid message format' }));
    }
  });

  ws.on('close', () => {
    clients.delete(client);
  });
});

/**
 * Broadcast data to all clients subscribed to a channel
 */
export function broadcast(channel: string, data: unknown) {
  const message = JSON.stringify({ type: 'update', channel, data });
  for (const client of clients) {
    if (client.channels.has(channel) && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(message);
    }
  }
}
