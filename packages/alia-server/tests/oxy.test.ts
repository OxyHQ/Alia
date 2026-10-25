import { describe, expect, it, vi } from 'vitest';
import { createAliaForOxyService, createAliaTransportForOxyService } from '../src/oxy.js';
import { ALIA_SERVICE_AUDIENCE } from '../src/identity.js';

describe('Oxy product transport', () => {
  it('owns the canonical recipient and forwards requester proof to core', () => {
    const transport = { fetch: vi.fn() as unknown as typeof fetch, dispose: vi.fn() };
    const oxy = { createServiceClient: vi.fn(() => transport) };
    const requester = { accountId: 'account', token: 'proof' };
    const client = createAliaForOxyService(oxy, { requester });
    expect(oxy.createServiceClient).toHaveBeenCalledWith({
      baseURL: 'https://api.alia.onl',
      audience: ALIA_SERVICE_AUDIENCE,
      requester,
    });
    client.dispose();
    expect(transport.dispose).toHaveBeenCalledOnce();
  });
  it('carries durable task authority without a retained bearer', () => {
    const transport = { fetch: vi.fn() as unknown as typeof fetch, dispose: vi.fn() };
    const oxy = { createServiceClient: vi.fn(() => transport) };
    createAliaForOxyService(oxy, { requester: { accountId: 'account', taskId: 'task' } });
    expect(oxy.createServiceClient).toHaveBeenCalledWith(
      expect.objectContaining({ requester: { accountId: 'account', taskId: 'task' } }),
    );
  });
  it('exposes the same core fetch for product-specific REST endpoints', () => {
    const transport = { fetch: vi.fn() as unknown as typeof fetch, dispose: vi.fn() };
    const oxy = { createServiceClient: vi.fn(() => transport) };
    expect(createAliaTransportForOxyService(oxy, { baseURL: 'http://localhost:4150' })).toBe(
      transport,
    );
    expect(oxy.createServiceClient).toHaveBeenCalledWith({
      baseURL: 'http://localhost:4150',
      audience: ALIA_SERVICE_AUDIENCE,
    });
  });
});
