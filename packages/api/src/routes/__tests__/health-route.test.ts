import { afterEach, describe, expect, it, vi } from 'vitest';

interface Probe {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function probe(
  route: '/' | '/live' | '/ready',
  options: { readonly postgresReady?: boolean; readonly inferenceConfigured?: boolean } = {},
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
  vi.doMock('../../lib/inference/oxy-inference.js', () => ({
    unsetOxyInferenceVariables: () => options.inferenceConfigured === false ? ['credential'] : [],
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
  vi.doUnmock('../../lib/inference/oxy-inference.js');
});

describe('health routes after the Kaana cutover', () => {
  it('reports the Oxy path without pretending to probe Kaana', async () => {
    const result = await probe('/');
    expect(result.status).toBe(200);
    expect(result.body.status).toBe('healthy');
    expect(result.body.postgres).toBe('connected');
    expect(kaana(result.body)).toEqual({ path: 'oxy', credentials: 'configured' });
    expect(result.body).not.toHaveProperty('providers');
  });

  it('reports incomplete inference configuration without faking an outage', async () => {
    const result = await probe('/', { inferenceConfigured: false });
    expect(result.status).toBe(200);
    expect(kaana(result.body)).toEqual({ path: 'oxy', credentials: 'not_configured' });
  });

  it('readiness is decided by this task database and still reports Kaana', async () => {
    const ready = await probe('/ready', { inferenceConfigured: false });
    expect(ready.status).toBe(200);
    expect(ready.body.status).toBe('ready');
    expect(kaana(ready.body)).toEqual({ path: 'oxy', credentials: 'not_configured' });

    const unavailable = await probe('/ready', { postgresReady: false });
    expect(unavailable).toEqual({
      status: 503,
      body: { status: 'not_ready', reason: 'database_unavailable' },
    });
  });

  it('liveness consults no dependency', async () => {
    const result = await probe('/live', { postgresReady: false, inferenceConfigured: false });
    expect(result).toEqual({ status: 200, body: { status: 'alive' } });
  });
});
