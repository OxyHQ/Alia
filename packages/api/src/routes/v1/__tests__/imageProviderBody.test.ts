import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Image generation has no Kaana seam yet. The route must fail closed before
 * legacy provider selection, billing reservations or storage can run.
 */

const H = vi.hoisted(() => ({
  gatewayCalls: [] as string[],
  billingCalls: [] as string[],
  storageCalls: [] as string[],
}));

vi.mock('../../../lib/gateway-client.js', () => ({
  getModelMappingsForTier: vi.fn(async () => {
    H.gatewayCalls.push('mappings');
    return [];
  }),
  callProviderAPI: vi.fn(async () => {
    H.gatewayCalls.push('provider');
    return null;
  }),
}));

vi.mock('../../../lib/credits-manager.js', () => ({
  reserveCredits: vi.fn(async () => {
    H.billingCalls.push('reserve');
    return null;
  }),
  finalizeCredits: vi.fn(async () => {
    H.billingCalls.push('finalize');
    return null;
  }),
  refundReservation: vi.fn(async () => {
    H.billingCalls.push('refund');
  }),
}));

vi.mock('../../../lib/s3.js', () => ({
  uploadToS3: vi.fn(async () => {
    H.storageCalls.push('upload');
    return '';
  }),
}));

const { default: imagesRouter } = await import('../images.js');

interface RouteLayer {
  route?: {
    path?: string;
    methods?: Record<string, boolean>;
    stack: Array<{
      handle: (request: unknown, response: unknown, next: unknown) => Promise<void> | void;
    }>;
  };
}

function handler() {
  const stack = (imagesRouter as unknown as { stack: RouteLayer[] }).stack;
  const layer = stack.find((candidate) =>
    candidate.route?.path === '/generations' && candidate.route.methods?.post,
  );
  const handle = layer?.route?.stack.at(-1)?.handle;
  if (handle === undefined) throw new Error('POST /generations not mounted');
  return handle;
}

interface CapturedResponse {
  readonly statusCode: number;
  readonly body: unknown;
}

async function invoke(authenticated = true): Promise<CapturedResponse> {
  let statusCode = 200;
  let body: unknown;
  const response = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: unknown) {
      body = payload;
      return this;
    },
  };
  const request = authenticated
    ? { user: { id: 'user-1' }, body: { prompt: 'a red apple' } }
    : { body: { prompt: 'a red apple' } };
  await handler()(request, response, () => undefined);
  return { statusCode, body };
}

beforeEach(() => {
  H.gatewayCalls.length = 0;
  H.billingCalls.length = 0;
  H.storageCalls.length = 0;
});

describe('POST /v1/images/generations without a Kaana image seam', () => {
  it('returns the stable typed 503 refusal', async () => {
    const answer = await invoke();
    expect(answer.statusCode).toBe(503);
    expect(answer.body).toEqual({
      error: {
        code: 'KAANA_CAPABILITY_UNAVAILABLE',
        message: 'The image generation capability is not available through Kaana.',
        type: 'server_error',
        retryable: false,
      },
    });
  });

  it('does not resolve a provider or make provider egress', async () => {
    await invoke();
    expect(H.gatewayCalls).toEqual([]);
  });

  it('does not reserve, settle or refund credits', async () => {
    await invoke();
    expect(H.billingCalls).toEqual([]);
  });

  it('does not upload a fabricated provider result', async () => {
    await invoke();
    expect(H.storageCalls).toEqual([]);
  });

  it('authenticates before revealing capability availability', async () => {
    const answer = await invoke(false);
    expect(answer).toEqual({ statusCode: 401, body: { error: 'Authentication required' } });
    expect(H.gatewayCalls).toEqual([]);
    expect(H.billingCalls).toEqual([]);
    expect(H.storageCalls).toEqual([]);
  });
});
