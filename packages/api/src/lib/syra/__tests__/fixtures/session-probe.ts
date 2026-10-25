import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Request } from 'express';
import type { SyraClient } from '@syra.fm/sdk';

const calls: Array<{ url: string; authorization?: string; ticket?: string | string[] }> = [];
let redirected = 0;
const other = createServer((_req, res) => {
  redirected++;
  res.end('{}');
});
await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
const server = createServer((req, res) => {
  calls.push({
    url: req.url!,
    authorization: req.headers.authorization,
    ticket: req.headers['x-ingest-ticket'],
  });
  if (req.url?.endsWith('/redirect')) {
    res.writeHead(302, {
      location: `http://127.0.0.1:${(other.address() as AddressInfo).port}/target`,
    });
    res.end();
    return;
  }
  res.setHeader('content-type', 'application/json');
  if (req.url?.endsWith('/revoked')) {
    res.writeHead(401);
    res.end('{}');
    return;
  }
  if (req.url?.endsWith('/ingest/abandon')) {
    // Only transport authority is under test; a 401 also proves tickets do not
    // silently fall back to a previously used human bearer.
    res.writeHead(401);
    res.end('{}');
    return;
  }
  res.end(JSON.stringify({ data: { podcast: { id: 'podcast', title: 'Original account' } } }));
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.SYRA_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const { withSyraRequest, syraForTicket } = await import('../../syra');
const token = (id: string) =>
  `e30.${Buffer.from(JSON.stringify({ userId: id, sessionId: `session-${id}`, exp: 2_000_000_000 })).toString('base64url')}.fixture`;
const request = (id: string) =>
  ({ userId: id, user: { id }, sessionId: `session-${id}`, accessToken: token(id) }) as Request;
try {
  const a = request('A');
  let escaped: SyraClient | undefined;
  await withSyraRequest(a, async (syra) => {
    escaped = syra;
    a.accessToken = token('B');
    assert.equal((await syra.getPodcast('podcast')).id, 'podcast');
  });
  assert.equal(calls[0]?.authorization, `Bearer ${token('A')}`);
  await withSyraRequest(request('B'), (syra) => syra.getPodcast('podcast'));
  assert.equal(calls[1]?.authorization, `Bearer ${token('B')}`);
  const beforeDisposed = calls.length;
  await assert.rejects(escaped!.getPodcast('podcast'));
  assert.equal(calls.length, beforeDisposed);
  for (const invalid of [
    { ...request('A'), serviceApp: { appId: 'service' } },
    { ...request('A'), machineCredential: { kind: 'key' } },
    { ...request('A'), sessionId: undefined },
    { ...request('A'), userId: 'B' },
  ]) {
    await assert.rejects(
      withSyraRequest(invalid as Request, (syra) => syra.getPodcast('podcast')),
      /verified human session/,
    );
  }
  assert.equal(calls.length, beforeDisposed);
  await assert.rejects(withSyraRequest(request('A'), (syra) => syra.getPodcast('redirect')));
  assert.equal(redirected, 0);
  await assert.rejects(withSyraRequest(request('A'), (syra) => syra.getPodcast('revoked')));
  assert.equal(calls.filter((call) => call.url.endsWith('/revoked')).length, 1);
  await assert.rejects(
    syraForTicket().abandonEpisodeIngest({
      episodeId: 'episode',
      ingestTicket: 'operation-ticket',
    }),
  );
  assert.equal(calls.at(-1)?.authorization, undefined);
  assert.equal(calls.at(-1)?.ticket, 'operation-ticket');
  console.log('ALIA_SYRA_SESSION_OK');
} finally {
  for (const listener of [server, other]) {
    listener.closeAllConnections();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
}
