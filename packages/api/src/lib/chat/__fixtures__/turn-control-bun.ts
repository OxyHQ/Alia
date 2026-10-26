/** Real Bun HTTP, two independent replica observers, real Postgres and published Oxy transport. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { OxyInferenceClient } from '@oxy.so/core/inference';
import { connectPostgres, closePostgres, getDb } from '../../../db';
import { turnControlRepository } from '../../../db/chat/turnControlRepository';
import {
  cancelChatTurn,
  turnIdentity,
  ChatTurnObserver,
  answerTurnControlError,
} from '../turn-control';

if (!process.versions.bun) throw new Error('This fixture must exercise Bun');
if (!connectPostgres(process.env.DATABASE_URL)) throw new Error('Missing isolated fixture DB');
const servers: Server[] = [];
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const started = new Map<string, ReturnType<typeof deferred>>();
const released = new Map<string, ReturnType<typeof deferred>>();
const cancelled = new Map<string, ReturnType<typeof deferred>>();
const finished = new Map<string, ReturnType<typeof deferred>>();
let executions = 0;

async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
function setup(id: string) {
  for (const map of [started, released, cancelled, finished]) map.set(id, deferred());
}
function event(map: Map<string, ReturnType<typeof deferred>>, id: string) {
  const value = map.get(id);
  if (!value) throw new Error('Missing fixture event');
  return value;
}
const timeout = AbortSignal.timeout(20_000);
async function bounded(promise: Promise<void>) {
  await Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timeout.addEventListener('abort', () => reject(timeout.reason), { once: true });
    }),
  ]);
}

try {
  const provider = await listen(
    createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const { input: id } = JSON.parse(Buffer.concat(chunks).toString());
      executions++;
      res.on('close', () => {
        if (!res.writableEnded) cancelled.get(id)?.resolve();
      });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Oxy-Request-Id': id });
      res.write(
        `event: start\ndata: ${JSON.stringify({ schemaVersion: 1, type: 'start', requestId: id, sequence: 0, generationId: id, resolvedModelReference: 'fixture/model@1', servingProvider: 'fixture', startedAt: new Date().toISOString() })}\n\n`,
      );
      started.get(id)?.resolve();
      await released.get(id)?.promise;
      if (res.destroyed) return;
      res.end(
        `event: done\ndata: ${JSON.stringify({ schemaVersion: 1, type: 'done', requestId: id, sequence: 1, generationId: id, receiptId: id, finishReason: 'stop', completedAt: new Date().toISOString() })}\n\n`,
      );
    }),
  );
  const inference = new OxyInferenceClient({ baseURL: provider, credential: 'synthetic-local' });
  const replica = async () => {
    const app = express();
    app.use(express.json());
    // Authentication fixtures are trusted principal projections, never billing owners.
    app.use((req, _res, next) => {
      const user = req.headers.authorization === 'Bearer B' ? 'fixture-B' : 'fixture-A';
      Object.assign(req, {
        user: { id: user },
        userId: user,
        sessionId: `session-${user}`,
        oxyActor: { actorAccountId: user, effectiveAccountId: user },
      });
      next();
    });
    const repo = turnControlRepository(getDb());
    const observer = new ChatTurnObserver(repo);
    app.post('/v1/chat/turns/:turnId/cancel', cancelChatTurn);
    app.post('/chat', async (req, res) => {
      let observation: ReturnType<ChatTurnObserver['observe']> | undefined;
      let identity: Awaited<ReturnType<typeof turnIdentity>> | undefined;
      const owner = randomUUID();
      let complete = false;
      try {
        identity = await turnIdentity(req, req.body.turnId);
        await repo.claim(identity, owner);
        const abort = new AbortController();
        observation = observer.observe(identity, owner, abort);
        // Deliberately no res.close -> abort: this is the durable disconnect contract.
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: admitted\n\n');
        for await (const event of inference.stream(
          { model: 'fixture/model', input: identity.id },
          { signal: abort.signal },
        )) {
          if (!res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
        await observation.beginFinish();
        complete = true;
        res.end('data: completed\n\n');
      } catch (error) {
        if (!res.headersSent) answerTurnControlError(res, error);
        else res.end();
      } finally {
        observation?.stop();
        if (identity && observation) await repo.finish(identity, owner, complete);
        finished.get(req.body.turnId)?.resolve();
      }
    });
    return listen(createServer(app));
  };
  const first = await replica();
  const second = await replica();
  const post = (base: string, path: string, body: object, account = 'A', signal?: AbortSignal) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${account}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });

  const background = randomUUID();
  setup(background);
  const disconnect = new AbortController();
  const stream = await post(first, '/chat', { turnId: background }, 'A', disconnect.signal);
  await bounded(event(started, background).promise);
  disconnect.abort();
  await stream.body?.cancel().catch(() => undefined);
  event(released, background).resolve();
  await bounded(event(finished, background).promise);
  assert.deepEqual(await (await post(second, `/v1/chat/turns/${background}/cancel`, {})).json(), {
    turnId: background,
    state: 'completed',
  });

  const stopped = randomUUID();
  setup(stopped);
  const active = await post(first, '/chat', { turnId: stopped });
  await bounded(event(started, stopped).promise);
  assert.equal((await post(second, `/v1/chat/turns/${stopped}/cancel`, {}, 'B')).status, 404);
  const results = await Promise.all([
    post(second, `/v1/chat/turns/${stopped}/cancel`, {}),
    post(second, `/v1/chat/turns/${stopped}/cancel`, {}),
  ]);
  assert.ok(results.every((r) => r.status === 200));
  await bounded(event(cancelled, stopped).promise);
  event(released, stopped).resolve();
  assert.ok(!(await active.text()).includes('completed'));
  await bounded(event(finished, stopped).promise);

  const early = randomUUID();
  setup(early);
  assert.equal((await post(second, `/v1/chat/turns/${early}/cancel`, {})).status, 200);
  assert.equal((await post(first, '/chat', { turnId: early })).status, 409);
  assert.equal(executions, 2);
  console.log('BUN_TURN_CONTROL_PASS');
} finally {
  for (const value of released.values()) value.resolve();
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await closePostgres();
}
