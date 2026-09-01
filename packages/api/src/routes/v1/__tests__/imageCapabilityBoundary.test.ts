import { describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  reserveCredits: vi.fn(),
  finalizeCredits: vi.fn(),
  callProviderAPI: vi.fn(),
  getModelMappingsForTier: vi.fn(),
}));

vi.mock('../../../lib/credits-manager.js', () => ({
  reserveCredits: H.reserveCredits,
  finalizeCredits: H.finalizeCredits,
}));
vi.mock('../../../lib/gateway-client.js', () => ({
  callProviderAPI: H.callProviderAPI,
  getModelMappingsForTier: H.getModelMappingsForTier,
}));

const { default: imagesRouter } = await import('../images.js');

interface RouteLayer {
  route?: {
    path?: string;
    methods?: Record<string, boolean>;
    stack: Array<{ handle: (req: unknown, res: unknown, next: unknown) => Promise<void> | void }>;
  };
}

function handlerFor(path: string) {
  const stack = (imagesRouter as unknown as { stack: RouteLayer[] }).stack;
  const layer = stack.find((entry) => entry.route?.path === path && entry.route.methods?.post);
  if (!layer?.route) throw new Error(`POST ${path} not mounted on the images router`);
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

describe('POST /v1/images/generations is a fail-closed Kaana capability boundary', () => {
  it('still rejects an anonymous caller before disclosing capability state', () => {
    const res = capturingRes();
    handlerFor('/generations')({ user: undefined, body: { prompt: 'a red apple' } }, res, undefined);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Authentication required' });
  });

  it('returns a stable 503 without resolving providers or touching Alia credits', () => {
    const res = capturingRes();
    handlerFor('/generations')({ user: { id: 'u1' }, body: { prompt: 'a red apple' } }, res, undefined);

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      error: {
        code: 'KAANA_CAPABILITY_UNAVAILABLE',
        message: 'The image generation capability is not available through Kaana.',
        type: 'server_error',
        retryable: false,
      },
    });
    expect(H.getModelMappingsForTier).not.toHaveBeenCalled();
    expect(H.callProviderAPI).not.toHaveBeenCalled();
    expect(H.reserveCredits).not.toHaveBeenCalled();
    expect(H.finalizeCredits).not.toHaveBeenCalled();
  });
});
