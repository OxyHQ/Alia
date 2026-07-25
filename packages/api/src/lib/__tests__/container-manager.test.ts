import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  log: {
    agents: {
      error: vi.fn(),
      warn: vi.fn(),
    },
  },
}));

describe('container-manager health', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = originalEnv;
  });

  it('reports unavailable when docker host config is missing', async () => {
    delete process.env.DOCKER_HOST_URL;
    delete process.env.DOCKER_HOST_SECRET;

    const { checkContainerSystemHealth, isContainerSystemAvailable } = await import('../container-manager.js');

    expect(isContainerSystemAvailable()).toBe(false);
    await expect(checkContainerSystemHealth()).resolves.toBe(false);
  });

  it('pings the docker host health endpoint when configured', async () => {
    process.env.DOCKER_HOST_URL = 'https://docker-host.example';
    process.env.DOCKER_HOST_SECRET = 'secret';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const { checkContainerSystemHealth, isContainerSystemAvailable } = await import('../container-manager.js');

    expect(isContainerSystemAvailable()).toBe(true);
    await expect(checkContainerSystemHealth()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://docker-host.example/health',
      expect.objectContaining({
        headers: { Authorization: 'Bearer secret' },
      }),
    );
  });

  it('returns false when the docker host health check fails', async () => {
    process.env.DOCKER_HOST_URL = 'https://docker-host.example';
    process.env.DOCKER_HOST_SECRET = 'secret';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const { checkContainerSystemHealth } = await import('../container-manager.js');

    await expect(checkContainerSystemHealth()).resolves.toBe(false);
  });
});
