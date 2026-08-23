import { describe, expect, it, vi } from 'vitest';

/**
 * What the caller is told when there is no credential to try.
 *
 * This is here because the answer was `unknown`, and `unknown` is what a
 * provider that fell over also produces. Read-aloud returned 503 for hours
 * while a working ElevenLabs key sat unused in SSM, and the only line anyone
 * had to go on was
 *
 *     Provider API exhausted: elevenlabs/eleven_multilingual_v2 (unknown)
 *
 * which names the provider, the model, and nothing that distinguishes "we never
 * asked" from "it said no".
 */

vi.mock('../key-manager.js', () => ({
  // The whole subject: no key for this provider, so the loop never runs.
  getBestKeyForModel: async () => null,
  recordKeySuccess: async () => {},
  recordKeyFailure: async () => {},
  recordKeyUsage: async () => {},
  markKeyCreditExhausted: async () => {},
}));

import { callProviderAPI } from '../provider-api.js';

describe('no credential for the provider', () => {
  it('says so, rather than blaming an upstream that was never called', async () => {
    const error = await callProviderAPI({
      provider: 'elevenlabs',
      modelId: 'eleven_multilingual_v2',
      endpoint: '/v1/audio/speech',
      body: { input: 'hola' },
    }).then(() => null, (err: Error & { reason?: string; providerMessage?: string }) => err);

    expect(error).not.toBeNull();
    expect(error?.reason).toBe('no_credential');
    // The negative control that gives the case its point: the reason it used to
    // carry is the one an upstream failure carries too.
    expect(error?.reason).not.toBe('unknown');
    expect(error?.message).toContain('no_credential');
    expect(error?.providerMessage).toContain('elevenlabs');
  });

  it('does not ask the caller to retry something that cannot change', async () => {
    // A retry re-reads the same empty key list. Reported as retryable, it spends
    // a caller's patience on an outcome that needs a person to fix.
    const { toAliaError } = await import('../../../../lib/errors/failover-error.js');
    const error = await callProviderAPI({
      provider: 'elevenlabs',
      modelId: 'eleven_multilingual_v2',
      endpoint: '/v1/audio/speech',
      body: { input: 'hola' },
    }).catch((err: unknown) => err);

    expect(toAliaError(error).retryable).toBe(false);
  });
});
