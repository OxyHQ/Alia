import { describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  reserveCredits: vi.fn(),
  finalizeCredits: vi.fn(),
  synthesizeSpeech: vi.fn(),
  callProviderAPI: vi.fn(),
}));

vi.mock('../../../lib/credits-manager.js', () => ({
  reserveCredits: H.reserveCredits,
  finalizeCredits: H.finalizeCredits,
}));
vi.mock('../../../lib/synthesize-speech.js', () => ({ synthesizeSpeech: H.synthesizeSpeech }));
vi.mock('../../../lib/gateway-client.js', () => ({ callProviderAPI: H.callProviderAPI }));
vi.mock('../../../db/index.js', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('../../../db/notifications/audioJobRepository.js', () => ({ findAudioJobStatus: vi.fn() }));
vi.mock('../../../lib/logger.js', () => ({
  log: { general: { error: vi.fn() } },
}));

const { default: audioRouter } = await import('../audio.js');

interface RouteLayer {
  route?: {
    path?: string;
    methods?: Record<string, boolean>;
    stack: Array<{ handle: (req: unknown, res: unknown, next: unknown) => Promise<void> | void }>;
  };
}

function handlerFor(path: string) {
  const stack = (audioRouter as unknown as { stack: RouteLayer[] }).stack;
  const layer = stack.find((entry) => entry.route?.path === path && entry.route.methods?.post);
  if (!layer?.route) throw new Error(`POST ${path} not mounted on the audio router`);
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

describe('POST /v1/audio/speech is a fail-closed Kaana capability boundary', () => {
  it('still rejects an anonymous caller before disclosing capability state', () => {
    const res = capturingRes();
    handlerFor('/speech')({ user: undefined, body: { input: 'hello' } }, res, undefined);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Authentication required' });
  });

  it('returns a stable 503 without synthesizing or touching Alia credits', () => {
    const res = capturingRes();
    handlerFor('/speech')({ user: { id: 'u1' }, body: { input: 'hello' } }, res, undefined);

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      error: {
        code: 'KAANA_CAPABILITY_UNAVAILABLE',
        message: 'The speech synthesis capability is not available through Kaana.',
        type: 'server_error',
        retryable: false,
      },
    });
    expect(H.synthesizeSpeech).not.toHaveBeenCalled();
    expect(H.callProviderAPI).not.toHaveBeenCalled();
    expect(H.reserveCredits).not.toHaveBeenCalled();
    expect(H.finalizeCredits).not.toHaveBeenCalled();
  });
});
