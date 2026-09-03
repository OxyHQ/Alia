import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import voiceRouter from '../voice.js';

const routeSource = readFileSync(fileURLToPath(new URL('../voice.ts', import.meta.url)), 'utf8');

interface RouteLayer {
  route?: {
    path?: string;
    methods?: Record<string, boolean>;
    stack: Array<{ handle: (req: unknown, res: unknown, next: unknown) => Promise<void> | void }>;
  };
}

function handlerFor(path: string) {
  const stack = (voiceRouter as unknown as { stack: RouteLayer[] }).stack;
  const layer = stack.find((entry) => entry.route?.path === path && entry.route.methods?.post);
  if (!layer?.route) throw new Error(`POST ${path} not mounted on the voice router`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function capturingRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { res.statusCode = code; return res; },
    json(body: unknown) { res.body = body; return res; },
  };
  return res;
}

describe.each([
  ['/token', 'voice session'],
  ['/transcribe', 'speech transcription'],
] as const)('POST /v1/voice%s is a fail-closed Kaana boundary', (path, capability) => {
  it('still rejects an anonymous caller before disclosing capability state', async () => {
    const res = capturingRes();
    await handlerFor(path)({ user: undefined, body: {} }, res, undefined);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Authentication required' });
  });

  it('returns a stable 503 without evaluating old Alia gates, billing, or providers', async () => {
    const res = capturingRes();
    await handlerFor(path)({ user: { id: 'user-ws13' }, body: {} }, res, undefined);

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      error: {
        code: 'KAANA_CAPABILITY_UNAVAILABLE',
        message: `The ${capability} capability is not available through Kaana.`,
        retryable: false,
      },
    });
    for (const forbidden of [
      'plan-access',
      'voice-usage',
      'user-context',
      'credits-manager',
      'gateway-client',
      'callProviderAPI',
      'getModelMappingsForTier',
    ]) {
      expect(routeSource).not.toContain(forbidden);
    }
  });
});
