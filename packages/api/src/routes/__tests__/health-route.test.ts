import { afterEach, describe, expect, it, vi } from 'vitest';

interface Probe {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

type KaanaState = 'unknown' | 'reachable' | 'unreachable';

async function probe(
  route: '/' | '/live' | '/ready',
  options: { readonly postgresReady?: boolean; readonly kaana?: KaanaState } = {},
): Promise<Probe> {
  vi.resetModules();
  const postgresReady = options.postgresReady ?? true;

  vi.doMock('../../db/index.js', () => ({
    getDb: () => ({
      execute: () =>
        postgresReady ? Promise.resolve([]) : Promise.reject(new Error('pool exhausted')),
    }),
  }));
  vi.doMock('../../lib/task-queue.js', () => ({ isQueueActive: () => true }));
  vi.doMock('../../lib/inference/kaana-connectivity.js', () => ({
    kaanaConnectivity: () => options.kaana ?? 'unknown',
  }));
  vi.doMock('../../lib/inference/kaana.js', () => ({
    unsetKaanaVariables: () => [],
  }));

  const { default: router } = await import('../health.js');
  const layer = router.stack.find((candidate) => candidate.route?.path === route);
  if (layer?.route?.stack[0]?.handle === undefined) throw new Error(`missing health route ${route}`);

  let status = 200;
  let body: Record<string, unknown> = {};
  const response = {
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: Record<string, unknown>) {
      body = payload;
      return this;
    },
  };

  await layer.route.stack[0].handle({} as never, response as never, () => undefined);
  return { status, body };
}

function kaana(body: Record<string, unknown>): Record<string, unknown> {
  const value = body.kaana;
  if (typeof value !== 'object' || value === null) throw new Error('health response omitted Kaana');
  return value as Record<string, unknown>;
}

afterEach(() => {
  vi.doUnmock('../../db/index.js');
  vi.doUnmock('../../lib/task-queue.js');
  vi.doUnmock('../../lib/inference/kaana-connectivity.js');
  vi.doUnmock('../../lib/inference/kaana.js');
});

describe('health routes after the Kaana cutover', () => {
  it('reports a healthy configured Kaana snapshot without provider telemetry', async () => {
    const result = await probe('/', { kaana: 'reachable' });
    expect(result.status).toBe(200);
    expect(result.body.status).toBe('healthy');
    expect(result.body.postgres).toBe('connected');
    expect(kaana(result.body)).toEqual({ credentials: 'configured', client: 'reachable' });
    expect(result.body).not.toHaveProperty('providers');
  });

  it('degrades the detailed snapshot when Kaana is known unreachable', async () => {
    const result = await probe('/', { kaana: 'unreachable' });
    expect(result.status).toBe(503);
    expect(result.body.status).toBe('degraded');
    expect(kaana(result.body).client).toBe('unreachable');
  });

  it('keeps a cold Kaana observation distinct from an outage', async () => {
    const result = await probe('/', { kaana: 'unknown' });
    expect(result.status).toBe(200);
    expect(kaana(result.body).client).toBe('unknown');
  });

  it('readiness is decided by this task database and still reports Kaana', async () => {
    const ready = await probe('/ready', { kaana: 'unreachable' });
    expect(ready.status).toBe(200);
    expect(ready.body.status).toBe('ready');
    expect(kaana(ready.body).client).toBe('unreachable');

    const unavailable = await probe('/ready', { postgresReady: false });
    expect(unavailable).toEqual({
      status: 503,
      body: { status: 'not_ready', reason: 'database_unavailable' },
    });
  });

  it('liveness consults no dependency', async () => {
    const result = await probe('/live', { postgresReady: false, kaana: 'unreachable' });
    expect(result).toEqual({ status: 200, body: { status: 'alive' } });
  });
});
