import { createServer, type Server } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { AliaServerClient, createAliaTurnControl } from '../src/index.js';

const servers: Server[] = [];
afterEach(async () => {
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
async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server port');
  return `http://127.0.0.1:${address.port}`;
}

it('deduplicates early Stop and waits for the HTTP acknowledgement before detaching', async () => {
  let acknowledge!: () => void;
  let arrived!: () => void;
  const requestArrived = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const requests: { path?: string; body: string; auth?: string }[] = [];
  const baseUrl = await listen(
    createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      requests.push({ path: req.url, body, auth: req.headers.authorization });
      const id = req.url?.split('/').at(-2);
      acknowledge = () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ turnId: id, state: 'cancelled' }));
      };
      arrived();
    }),
  );
  const controller = new AbortController();
  const turn = createAliaTurnControl(new AliaServerClient({ baseUrl, token: 'fixture-a' }), {
    controller,
  });
  const first = turn.stop();
  expect(turn.stop()).toBe(first);
  await requestArrived;
  expect(controller.signal.aborted).toBe(false);
  let finished = false;
  const finishing = turn.finish().then(() => {
    finished = true;
  });
  await Promise.resolve();
  expect(finished).toBe(false);
  acknowledge();
  await first;
  await finishing;
  expect(controller.signal.aborted).toBe(true);
  expect(requests).toEqual([
    { path: `/v1/chat/turns/${turn.id}/cancel`, body: '{}', auth: 'Bearer fixture-a' },
  ]);
});

it('a refused Stop remains retryable and never claims remote cancellation', async () => {
  let count = 0;
  const baseUrl = await listen(
    createServer((req, res) => {
      req.resume();
      count++;
      res.writeHead(count === 1 ? 503 : 200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          count === 1
            ? { error: { code: 'unavailable' } }
            : { turnId: req.url?.split('/').at(-2), state: 'cancelled' },
        ),
      );
    }),
  );
  const controller = new AbortController();
  const turn = createAliaTurnControl(new AliaServerClient({ baseUrl }), { controller });
  await expect(turn.stop()).rejects.toThrow();
  expect(controller.signal.aborted).toBe(false);
  await turn.stop();
  expect(controller.signal.aborted).toBe(true);
  expect(count).toBe(2);
  await turn.finish();
});

it('detach/account change before dispatch never sends Stop under another identity', async () => {
  let calls = 0;
  const baseUrl = await listen(
    createServer((req, res) => {
      calls++;
      req.resume();
      res.end();
    }),
  );
  const controller = new AbortController();
  const turn = createAliaTurnControl(new AliaServerClient({ baseUrl }), { controller });
  controller.abort();
  await turn.stop();
  await turn.finish();
  expect(calls).toBe(0);
});

it('bounds credential preparation within Stop and never dispatches after late resolution', async () => {
  const timeout = new AbortController();
  const timeoutFactory = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
  let release!: (value: Record<string, string>) => void;
  const headers = new Promise<Record<string, string>>((resolve) => {
    release = resolve;
  });
  const fetchClient = vi.fn<typeof fetch>();
  const client = new AliaServerClient({ headers: () => headers, fetch: fetchClient });
  const turn = createAliaTurnControl(client, { controller: new AbortController() });
  try {
    const stopped = turn.stop();
    const rejected = expect(stopped).rejects.toThrow('deadline');
    expect(timeoutFactory).toHaveBeenCalledWith(10_000);
    timeout.abort(new Error('deadline'));
    await rejected;
    await turn.finish();
    release({ 'X-Test': 'late' });
    await Promise.resolve();
    expect(fetchClient).not.toHaveBeenCalled();
  } finally {
    timeoutFactory.mockRestore();
    await turn.finish();
  }
});
