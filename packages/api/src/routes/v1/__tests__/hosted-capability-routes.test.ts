import type { Router } from 'express';
import { describe, expect, it } from 'vitest';

import audioRouter from '../audio.js';
import imagesRouter from '../images.js';
import voiceRouter from '../voice.js';

interface RouteAnswer {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function invoke(router: Router, route: string, authenticated = true): Promise<RouteAnswer> {
  const layer = router.stack.find((candidate) => candidate.route?.path === route);
  if (layer?.route?.stack[0]?.handle === undefined) throw new Error(`missing POST ${route}`);

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
  const request = authenticated ? { user: { id: 'user-1' }, body: {} } : { body: {} };
  await layer.route.stack[0].handle(request as never, response as never, () => undefined);
  return { status, body };
}

function errorOf(answer: RouteAnswer): Record<string, unknown> {
  const error = answer.body.error;
  if (typeof error !== 'object' || error === null) throw new Error('response omitted typed error');
  return error as Record<string, unknown>;
}

describe('hosted modalities without a Kaana seam', () => {
  const cases = [
    { router: audioRouter, route: '/speech', capability: 'speech synthesis' },
    { router: audioRouter, route: '/generate', capability: 'audio generation' },
    { router: imagesRouter, route: '/generations', capability: 'image generation' },
    { router: voiceRouter, route: '/token', capability: 'voice session' },
    { router: voiceRouter, route: '/transcribe', capability: 'speech transcription' },
  ] as const;

  for (const testCase of cases) {
    it(`fails ${testCase.route} closed with the stable Kaana error`, async () => {
      const answer = await invoke(testCase.router, testCase.route);
      expect(answer.status).toBe(503);
      expect(errorOf(answer)).toMatchObject({
        code: 'KAANA_CAPABILITY_UNAVAILABLE',
        retryable: false,
      });
      expect(errorOf(answer).message).toContain(testCase.capability);
    });
  }

  it('authenticates before reporting capability availability', async () => {
    const answer = await invoke(imagesRouter, '/generations', false);
    expect(answer.status).toBe(401);
    expect(answer.body).toEqual({ error: 'Authentication required' });
  });
});
