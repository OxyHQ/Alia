import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clientOptions: [] as unknown[],
  serviceOptions: [] as unknown[],
  configuredCredentials: [] as Array<readonly [string, string]>,
}));

vi.mock('@oxyhq/core', () => ({
  OxyInferenceClient: class {
    constructor(options: unknown) {
      mocks.clientOptions.push(options);
    }
  },
  OxyServices: class {
    constructor(options: unknown) {
      mocks.serviceOptions.push(options);
    }

    configureServiceAuth(key: string, secret: string): void {
      mocks.configuredCredentials.push([key, secret]);
    }

    async getServiceToken(): Promise<string> {
      return 'short-lived-oxy-service-token';
    }
  },
}));

import {
  buildOxyInferenceClient,
  oxyInferenceEndpointRefusal,
  resetOxyInferenceClient,
} from '../oxy-inference.js';

const configured = {
  NODE_ENV: 'production',
  OXY_API_URL: 'https://api.oxy.so',
  ALIA_KAANA_CREDENTIAL_KEY: 'credential-key',
  ALIA_KAANA_CREDENTIAL_SECRET: 'credential-secret',
} as NodeJS.ProcessEnv;

describe('Oxy inference client', () => {
  beforeEach(() => {
    mocks.clientOptions.length = 0;
    mocks.serviceOptions.length = 0;
    mocks.configuredCredentials.length = 0;
    resetOxyInferenceClient();
  });

  it('fails closed when the Oxy service credential is incomplete', () => {
    expect(buildOxyInferenceClient({ ...configured, ALIA_KAANA_CREDENTIAL_SECRET: '' })).toBeNull();
    expect(mocks.clientOptions).toEqual([]);
  });

  it('accepts only the canonical deployed Oxy API origin', () => {
    expect(oxyInferenceEndpointRefusal('https://api.oxy.so', 'production')).toBeNull();
    expect(oxyInferenceEndpointRefusal('https://kaana.ai', 'production')).toContain('not an approved Oxy');
    expect(oxyInferenceEndpointRefusal('https://api.oxy.so/internal/v1/inference', 'production')).toContain('not a path');
    expect(oxyInferenceEndpointRefusal('http://localhost:3000', 'development')).toBeNull();
    expect(oxyInferenceEndpointRefusal('http://localhost:3000', 'production')).toContain('not an approved Oxy');
  });

  it('hands the published SDK an Oxy service-token credential', async () => {
    expect(buildOxyInferenceClient(configured)).not.toBeNull();
    expect(mocks.serviceOptions).toEqual([{ baseURL: 'https://api.oxy.so' }]);
    expect(mocks.configuredCredentials).toEqual([['credential-key', 'credential-secret']]);
    expect(mocks.clientOptions).toHaveLength(1);

    const options = mocks.clientOptions[0] as { baseURL: string; credential: () => Promise<string> };
    expect(options.baseURL).toBe('https://api.oxy.so');
    await expect(options.credential()).resolves.toBe('short-lived-oxy-service-token');
  });
});
