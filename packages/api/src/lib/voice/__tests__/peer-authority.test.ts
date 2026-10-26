import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ALIA_API_WORKLOAD_ID,
  ALIA_APPLICATION_ID,
  ALIA_SERVICE_AUDIENCE,
} from '@alia.onl/server/internal';

const state = vi.hoisted(() => ({ introspect: vi.fn(), create: vi.fn() }));
vi.mock('../../oxy-service-client.js', () => ({
  oxyServiceClient: () => ({
    introspectServiceToken: state.introspect,
    createServiceClient: state.create,
  }),
}));
const { productionVoicePeerAuth } = await import('../peer-relay.js');
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

describe('private voice peer authority uses shared Oxy verification', () => {
  const own = {
    active: true,
    authority: 'first_party',
    applicationId: ALIA_APPLICATION_ID,
    credentialId: ALIA_API_WORKLOAD_ID,
    audience: ALIA_SERVICE_AUDIENCE,
  };
  it('accepts only the exact live API workload and canonical recipient', async () => {
    vi.stubEnv('ALIA_API_WORKLOAD_ID', ALIA_API_WORKLOAD_ID);
    state.introspect.mockResolvedValue(own);
    expect(await productionVoicePeerAuth.verify('opaque-proof')).toBe(true);
    expect(state.introspect).toHaveBeenCalledWith('opaque-proof');
    for (const delta of [
      { active: false },
      { authority: 'external' },
      { credentialId: 'another-workload' },
      { applicationId: 'another-product' },
      { audience: 'oxy-api' },
    ]) {
      state.introspect.mockResolvedValue({ ...own, ...delta });
      expect(await productionVoicePeerAuth.verify('opaque-proof')).toBe(false);
    }
    state.introspect.mockRejectedValue(new Error('verifier unavailable'));
    expect(await productionVoicePeerAuth.verify('opaque-proof')).toBe(false);
  });
  it('uses the shared audience-bound transport and disposes it even if mint fails', async () => {
    const getAccessToken = vi.fn().mockResolvedValue('opaque-proof');
    const dispose = vi.fn();
    state.create.mockReturnValue({ getAccessToken, dispose });
    const signal = new AbortController().signal;
    const url = 'ws://10.20.1.2:3001/internal/voice/relay';
    expect(await productionVoicePeerAuth.token(url, signal)).toBe('opaque-proof');
    expect(state.create).toHaveBeenCalledWith({
      baseURL: 'http://10.20.1.2:3001',
      audience: ALIA_SERVICE_AUDIENCE,
    });
    expect(getAccessToken).toHaveBeenCalledWith(url, { signal });
    expect(dispose).toHaveBeenCalledTimes(1);
    getAccessToken.mockRejectedValue(new Error('mint unavailable'));
    await expect(productionVoicePeerAuth.token(url, signal)).rejects.toThrow('mint unavailable');
    expect(dispose).toHaveBeenCalledTimes(2);
  });
});
