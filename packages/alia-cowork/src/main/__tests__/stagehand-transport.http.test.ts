import { createServer, type Server } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { OxyServices } from '@oxy.so/core';
import { stagehandClientForTransport } from '../stagehand-transport';

const servers: Server[] = [];
const disposers: (() => void)[] = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});
function token(version: string) {
  return `e30.${Buffer.from(JSON.stringify({ userId: 'account-a', sessionId: 'session-a', exp: Math.floor(Date.now() / 1000) + 3600, jti: version })).toString('base64url')}.signature`;
}
async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Missing port');
  return `http://127.0.0.1:${address.port}`;
}
it('the real Stagehand adapter uses core refresh and sends no placeholder credential', async () => {
  const seen: (string | undefined)[] = [];
  const oldToken = token('old');
  const freshToken = token('fresh');
  const baseURL = await listen(
    createServer((req, res) => {
      seen.push(req.headers.authorization);
      req.resume();
      if (seen.length === 1) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end('{"message":"expired"}');
        return;
      }
      expect(req.url).toBe('/v1/chat/completions');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chat-test',
          object: 'chat.completion',
          created: 1,
          model: 'publisher/model',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'verified response' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }),
      );
    }),
  );
  const oxy = new OxyServices({ baseURL });
  disposers.push(() => oxy.dispose());
  oxy.session.setAccessToken(oldToken);
  oxy.http.setAuthRefreshHandler(async () => freshToken);
  const linked = oxy.createLinkedClient({ baseURL });
  disposers.push(() => linked.dispose());
  const client = stagehandClientForTransport(linked, baseURL, 'publisher/model');
  const result = await client.createChatCompletion<{ data: string }>({
    options: { messages: [{ role: 'user', content: 'hello' }], tools: [] },
    logger: () => {},
  });
  expect(result.data).toBe('verified response');
  expect(seen).toEqual([`Bearer ${oldToken}`, `Bearer ${freshToken}`]);
});
it('the Stagehand model propagates caller cancellation through the shared transport', async () => {
  let arrived!: () => void;
  const received = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const baseURL = await listen(
    createServer((req) => {
      req.resume();
      arrived();
    }),
  );
  const oxy = new OxyServices({ baseURL });
  disposers.push(() => oxy.dispose());
  oxy.session.setAccessToken(token('current'));
  const linked = oxy.createLinkedClient({ baseURL });
  disposers.push(() => linked.dispose());
  const client = stagehandClientForTransport(linked, baseURL, 'publisher/model');
  const abort = new AbortController();
  const response = client.getLanguageModel().doGenerate({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    abortSignal: abort.signal,
  });
  const rejected = expect(response).rejects.toBeDefined();
  await received;
  abort.abort();
  await rejected;
});
