import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { APIClient } from '../api-client';
import { handleIncomingMessage } from '../chat-handler';

const ACCOUNT = '69b2d3df5d12f58c9800d651';
const requests: Array<{ path: string; headers: IncomingMessage['headers'] }> = [];
let server: Server;

beforeAll(async () => {
  // The deployed legacy wire: no workload bearer and no knowledge of provider
  // metadata. Additive headers cannot change which credential this reader sees.
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const path = req.url ?? '';
    requests.push({ path, headers: req.headers });
    if (req.headers.authorization || req.headers['x-channel-bot-secret'] !== 'legacy-secret') {
      res.writeHead(401).end(JSON.stringify({ error: 'legacy authentication refused' }));
      return;
    }
    if (path.startsWith('/bots/internal/')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ isLinked: true, oxyUserId: ACCOUNT, conversationId: 'thread' }));
      return;
    }
    if (req.headers['x-oxy-user-id'] !== ACCOUNT) {
      res.writeHead(401).end(JSON.stringify({ error: 'legacy account required' }));
      return;
    }
    if (body.stream) {
      res.setHeader('content-type', 'text/event-stream');
      res.end('data: {"choices":[{"delta":{"content":"reply"}}]}\n\ndata: [DONE]\n\n');
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        messages: [],
        text: 'transcript',
        choices: [{ message: { content: 'reply' } }],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  vi.stubEnv('API_BASE_URL', `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => requests.splice(0));

describe('legacy producers with additive provider identity', () => {
  it.each([
    [
      'telegram',
      { kind: 'bot', platformUserId: 'provider-123' },
      'x-alia-platform-user',
      'provider-123',
    ],
    [
      'whatsapp',
      { kind: 'account', sessionId: 'connection-123' },
      'x-alia-channel-session',
      'connection-123',
    ],
  ] as const)(
    'preserves the old %s reader for chat, streaming, history and audio',
    async (platform, identity, header, value) => {
      const client = new APIClient(platform, 'legacy-secret');
      await expect(client.chatCompletion(ACCOUNT, [], { identity })).resolves.toMatchObject({
        content: 'reply',
      });
      const chunks = [];
      for await (const chunk of client.chatCompletionStream(ACCOUNT, [], { identity }))
        chunks.push(chunk);
      expect(chunks).toEqual(['reply']);
      await client.getConversation(ACCOUNT, 'thread', identity);
      await client.saveConversation(ACCOUNT, 'thread', [], undefined, identity);
      await client.getConversations(ACCOUNT, identity);
      await expect(client.transcribe(ACCOUNT, 'audio', 'audio/ogg', identity)).resolves.toBe(
        'transcript',
      );
      expect(requests).toHaveLength(6);
      for (const request of requests) {
        expect(request.headers).toMatchObject({
          'x-channel-bot-secret': 'legacy-secret',
          'x-oxy-user-id': ACCOUNT,
          'x-alia-channel': platform,
          [header]: value,
        });
        expect(request.headers.authorization).toBeUndefined();
        expect(
          request.headers[
            header === 'x-alia-platform-user' ? 'x-alia-channel-session' : 'x-alia-platform-user'
          ],
        ).toBeUndefined();
      }
    },
  );
  it('does not authenticate with provider metadata when the secret is wrong', async () => {
    const client = new APIClient('telegram', 'wrong-secret');
    await expect(
      client.chatCompletion(ACCOUNT, [], {
        identity: { kind: 'bot', platformUserId: 'provider-123' },
      }),
    ).rejects.toMatchObject({ status: 401 });
  });
  it('the connected-account adapter supplies its session, not the Oxy owner as a provider ID', async () => {
    const client = new APIClient('whatsapp', 'legacy-secret');
    vi.spyOn(client, 'requestModel').mockResolvedValue(undefined);
    const sendResponse = vi.fn(async () => {});
    await handleIncomingMessage(
      {
        platform: 'whatsapp',
        sessionId: 'actual-session',
        oxyUserId: ACCOUNT,
        chatId: 'peer',
        messageText: 'hello',
        sendResponse,
      },
      client,
    );
    expect(sendResponse).toHaveBeenCalledWith('reply');
    const privateRequests = requests.filter(({ path }) => !path.startsWith('/bots/'));
    expect(privateRequests).toHaveLength(2);
    for (const request of privateRequests) {
      expect(request.headers['x-alia-channel-session']).toBe('actual-session');
      expect(request.headers['x-alia-platform-user']).toBeUndefined();
    }
  });
});
