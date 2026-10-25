import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OxyServices } from '@oxy.so/core';
import { expect, it } from 'vitest';
import { streamAliaChat } from '../alia-chat.js';

function token(account: string, revision: number): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256' })}.${encode({ userId: account, sessionId: `session-${account}`, revision, exp: Math.floor(Date.now() / 1000) + 3600 })}.test-signature`;
}

it('streams through the shared session transport with one refresh and current-account authority', async () => {
  const seen: string[] = [];
  const alice = token('alice', 1);
  const refreshed = token('alice', 2);
  const bob = token('bob', 1);
  const server = createServer((request, response) => {
    seen.push(request.headers.authorization ?? '');
    if (request.headers.authorization === `Bearer ${alice}`) {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end('{}');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'hello' } }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const oxy = new OxyServices({ baseURL: baseUrl });
  const linked = oxy.createLinkedClient({ baseURL: baseUrl });
  let refreshes = 0;
  oxy.http.setAuthRefreshHandler(async () => {
    refreshes++;
    return refreshed;
  });
  const collect = async (target = baseUrl) => {
    const events = [];
    for await (const event of streamAliaChat({
      baseUrl: target,
      fetch: linked.fetch,
      body: { messages: [] },
    }))
      events.push(event);
    return events;
  };
  try {
    oxy.session.setAccessToken(alice);
    expect(await collect()).toEqual([{ type: 'content', text: 'hello' }]);
    oxy.session.setAccessToken(bob);
    expect(await collect()).toEqual([{ type: 'content', text: 'hello' }]);
    expect(refreshes).toBe(1);
    expect(seen).toEqual([`Bearer ${alice}`, `Bearer ${refreshed}`, `Bearer ${bob}`]);
    await expect(collect('https://foreign.example')).rejects.toThrow('configured API origin');
    oxy.session.clear();
    await expect(collect()).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(seen).toHaveLength(3);
  } finally {
    linked.dispose();
    oxy.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
