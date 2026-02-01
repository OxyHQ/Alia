import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';

interface Client {
  ws: WebSocket;
  channels: Set<string>;
}

const clients = new Set<Client>();

export const providersWss = new WebSocketServer({ noServer: true });

providersWss.on('connection', (ws: WebSocket, _req: IncomingMessage) => {
  const client: Client = { ws, channels: new Set() };
  clients.add(client);

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
