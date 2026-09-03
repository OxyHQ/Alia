import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findModelConfig: vi.fn(),
  getDb: vi.fn(() => ({ kind: 'test-db' })),
  info: vi.fn(),
  error: vi.fn(),
  upsertRoutingProfile: vi.fn(),
  upsertModelConfig: vi.fn(),
}));

vi.mock('../../../../db/index.js', () => ({ getDb: mocks.getDb }));
vi.mock('../../../../db/providers/modelConfigRepository.js', () => ({
  findModelConfig: mocks.findModelConfig,
  upsertModelConfig: mocks.upsertModelConfig,
}));
vi.mock('../../../../db/providers/routingProfileRepository.js', () => ({
  upsertRoutingProfile: mocks.upsertRoutingProfile,
}));
vi.mock('../../../../lib/logger.js', () => ({
  log: { seed: { info: mocks.info, error: mocks.error } },
}));
vi.mock('../provider-names.js', () => ({ PROVIDER_NAMES: ['openai'] }));
vi.mock('../routing-profile-catalogue.js', () => ({
  TIER_MODEL_MAPPINGS: {
    v1: [{ provider: 'openai', modelId: 'test-model', priority: 1, qualityScore: 1 }],
  },
  KAANA_ROUTING_PROFILES: {
    'kaana-test': {
      name: 'Test model',
      tier: 'v1',
      description: 'Test-only catalogue entry',
      creditMultiplier: 1,
    },
  },
}));

import { seedModelConfigs, seedRoutingProfiles } from '../seed-model-configs.js';

describe('PostgreSQL catalogue seeds fail closed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findModelConfig.mockResolvedValue({ id: 'model-config-id' });
  });

  it('propagates a model-config upsert failure instead of counting it as a duplicate', async () => {
    const failure = new Error('model_configs constraint failed');
    mocks.upsertModelConfig.mockRejectedValueOnce(failure);

    await expect(seedModelConfigs()).rejects.toBe(failure);

    expect(mocks.error).toHaveBeenCalledWith(
      { err: failure, uniqueKey: 'openai:test-model' },
      'Error seeding ModelConfig',
    );
  });

  it('propagates an Alia-model upsert failure instead of silently leaving a partial catalogue', async () => {
    const failure = new Error('alia_models transaction failed');
    mocks.upsertRoutingProfile.mockRejectedValueOnce(failure);

    await expect(seedRoutingProfiles()).rejects.toBe(failure);

    expect(mocks.error).toHaveBeenCalledWith(
      { err: failure, modelId: 'kaana-test' },
      'Error seeding RoutingProfile',
    );
  });
});
