import { createServer, type Server } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { OxyServices } from '@oxy.so/core';
import { streamAliaChat } from '../aliaChat';
import { fetchPickerCatalogue } from '../catalogue';
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
function bearer(account: string, version: string) {
  return `e30.${Buffer.from(JSON.stringify({ userId: account, sessionId: account, exp: Math.floor(Date.now() / 1000) + 3600, jti: version })).toString('base64url')}.signature`;
}
async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('No port');
  return `http://127.0.0.1:${address.port}`;
}
it('SSE uses shared HTTP refresh and preserves the product stream', async () => {
  const seen: (string | undefined)[] = [];
  const old = bearer('a', 'old');
  const fresh = bearer('a', 'fresh');
  const baseURL = await listen(
    createServer((req, res) => {
      seen.push(req.headers.authorization);
      req.resume();
      if (seen.length === 1) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end('{"message":"expired"}');
        return;
      }
      expect(req.url).toBe('/alia/chat');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        'data: {"choices":[{"delta":{"content":"verified"},"finish_reason":null}]}\n\ndata: [DONE]\n\n',
      );
    }),
  );
  const oxy = new OxyServices({ baseURL });
  disposers.push(() => oxy.dispose());
  oxy.session.setAccessToken(old);
  oxy.http.setAuthRefreshHandler(async () => fresh);
  const linked = oxy.createLinkedClient({ baseURL });
  disposers.push(() => linked.dispose());
  const events = [];
  for await (const event of streamAliaChat({
    baseUrl: baseURL,
    fetch: linked.fetch,
    body: { messages: [{ role: 'user', content: 'test' }] },
  }))
    events.push(event);
  expect(events).toContainEqual({ type: 'content', text: 'verified' });
  expect(seen).toEqual([`Bearer ${old}`, `Bearer ${fresh}`]);
});
it('a new account fetches its own catalogue instead of a process-wide cached answer', async () => {
  const first = bearer('a', 'current');
  const second = bearer('b', 'current');
  const seen: (string | undefined)[] = [];
  const baseURL = await listen(
    createServer((req, res) => {
      seen.push(req.headers.authorization);
      const name =
        req.headers.authorization === `Bearer ${first}`
          ? 'First account model'
          : 'Second account model';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          data: [
            {
              object: 'model',
              id: 'publisher/model',
              name,
              publisher: { id: 'publisher', name: 'Publisher' },
              reasoningEfforts: [],
            },
          ],
        }),
      );
    }),
  );
  const oxy = new OxyServices({ baseURL });
  disposers.push(() => oxy.dispose());
  oxy.session.setAccessToken(first);
  let linked = oxy.createLinkedClient({ baseURL });
  const a = await fetchPickerCatalogue(baseURL, linked.fetch);
  linked.dispose();
  oxy.session.setAccessToken(second);
  linked = oxy.createLinkedClient({ baseURL });
  disposers.push(() => linked.dispose());
  const b = await fetchPickerCatalogue(baseURL, linked.fetch);
  expect(JSON.stringify(a)).toContain('First account model');
  expect(JSON.stringify(b)).toContain('Second account model');
  expect(JSON.stringify(b)).not.toContain('First account model');
  expect(seen).toEqual([`Bearer ${first}`, `Bearer ${second}`]);
});
