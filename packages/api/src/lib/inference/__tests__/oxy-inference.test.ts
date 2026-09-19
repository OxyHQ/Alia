import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clientOptions: [] as unknown[],
  serviceOptions: [] as unknown[],
  configuredCredentials: [] as Array<readonly [string, string]>,
}));

vi.mock('@oxy.so/core', () => ({
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
  buildOxyInferenceClientForServiceToken,
  oxyInferenceEndpointRefusal,
  resetOxyInferenceClient,
} from '../oxy-inference.js';

const configured = {
  NODE_ENV: 'production',
  OXY_API_URL: 'https://api.oxy.so',
  OXY_SERVICE_API_KEY: 'credential-key',
  OXY_SERVICE_API_SECRET: 'credential-secret',
} as NodeJS.ProcessEnv;

describe('Oxy inference client', () => {
  beforeEach(() => {
    mocks.clientOptions.length = 0;
    mocks.serviceOptions.length = 0;
    mocks.configuredCredentials.length = 0;
    resetOxyInferenceClient();
  });

  it('fails closed when the Oxy service credential is incomplete', () => {
    expect(buildOxyInferenceClient({ ...configured, OXY_SERVICE_API_SECRET: '' })).toBeNull();
    expect(mocks.clientOptions).toEqual([]);
  });

  /**
   * A deployed Alia carries neither half of the pair (oxy ADR 0026), and this is
   * the assertion that says the SDK is left to attest rather than handed a
   * credential it cannot use.
   *
   * `configureServiceAuth` being UNCALLED is the whole property: `getServiceToken()`
   * falls back to the task role only when nothing was configured, so calling it
   * with a blank or half credential would replace a working attestation with one
   * that cannot mint — and the failure would arrive as one `authentication_failed`
   * per user request rather than at boot.
   */
  it('builds against an attested task role, arming no credential', async () => {
    const attesting = {
      NODE_ENV: 'production',
      OXY_API_URL: 'https://api.oxy.so',
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/9f0c',
    } as NodeJS.ProcessEnv;

    expect(buildOxyInferenceClient(attesting)).not.toBeNull();
    expect(mocks.serviceOptions).toEqual([{ baseURL: 'https://api.oxy.so' }]);
    expect(mocks.configuredCredentials).toEqual([]);

    const options = mocks.clientOptions[0] as { credential: () => Promise<string> };
    await expect(options.credential()).resolves.toBe('short-lived-oxy-service-token');
  });

  /**
   * Half a pair on a task that can attest is IGNORED, not armed.
   *
   * Left in the environment by a half-finished rollout, an api key with no
   * secret would otherwise reach `configureServiceAuth` and take the deployment
   * off the path that works.
   */
  it('ignores half a credential rather than arming it', () => {
    expect(
      buildOxyInferenceClient({
        NODE_ENV: 'production',
        OXY_API_URL: 'https://api.oxy.so',
        AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/9f0c',
        OXY_SERVICE_API_KEY: 'credential-key',
      } as NodeJS.ProcessEnv),
    ).not.toBeNull();
    expect(mocks.configuredCredentials).toEqual([]);
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

  it('builds a request-scoped client from the verified product token without Alia credentials', () => {
    expect(buildOxyInferenceClientForServiceToken(' product-service-token ', {
      NODE_ENV: 'production',
      OXY_API_URL: 'https://api.oxy.so',
    })).not.toBeNull();
    expect(mocks.serviceOptions).toEqual([]);
    expect(mocks.configuredCredentials).toEqual([]);
    expect(mocks.clientOptions).toEqual([{
      baseURL: 'https://api.oxy.so',
      credential: 'product-service-token',
    }]);
  });
});
