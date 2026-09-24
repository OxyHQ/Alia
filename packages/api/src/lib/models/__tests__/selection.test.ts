import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CatalogueModel } from '../catalogue.js';

const listChatModels = vi.fn<() => Promise<CatalogueModel[]>>();
const listCatalogueModels = vi.fn<() => Promise<CatalogueModel[]>>();
vi.mock('../catalogue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../catalogue.js')>()),
  listChatModels: () => listChatModels(),
  listCatalogueModels: () => listCatalogueModels(),
}));

const aggregateModelTurnsSince = vi.fn();
const findLastUsedModel = vi.fn();
vi.mock('../../../db/usage/chatAnalyticsRepository.js', () => ({
  aggregateModelTurnsSince: (...args: unknown[]) => aggregateModelTurnsSince(...args),
  findLastUsedModel: (...args: unknown[]) => findLastUsedModel(...args),
}));
vi.mock('../../../db/index.js', () => ({ getDb: () => ({}) }));

const {
  getDefaultModelId,
  getFeaturedModelIds,
  getSpeechModelId,
  getUtilityModelId,
  resetModelSelectionCache,
  NoModelAvailableError,
} = await import('../selection.js');

function model(id: string, overrides: Partial<CatalogueModel> = {}): CatalogueModel {
  return {
    id,
    name: id,
    publisher: { id: id.split('/')[0], name: id.split('/')[0] },
    description: null,
    contextWindow: 128_000,
    maxOutput: null,
    inputModalities: ['text'],
    outputModalities: ['text'],
    tools: true,
    reasoningEfforts: [],
    pricing: { inputPerMTok: '1', outputPerMTok: '1' },
    releasedAt: '2026-01-01',
    ...overrides,
  };
}

afterEach(() => {
  resetModelSelectionCache();
  vi.clearAllMocks();
});

describe('live selection', () => {
  it('computes featured from usage once, then serves the day’s ranking filtered by the current catalogue', async () => {
    listChatModels.mockResolvedValue([model('a/x'), model('b/y')]);
    aggregateModelTurnsSince.mockResolvedValue([{ modelId: 'b/y', turns: 5 }]);
    expect(await getFeaturedModelIds()).toEqual(['b/y', 'a/x']);

    listChatModels.mockResolvedValue([model('a/x')]);
    expect(await getFeaturedModelIds()).toEqual(['a/x']);
    expect(aggregateModelTurnsSince).toHaveBeenCalledTimes(1);
  });

  it('a person’s default is their last-used model; a usage outage is a cold start, not an error', async () => {
    listChatModels.mockResolvedValue([model('a/x', { pricing: { inputPerMTok: '9', outputPerMTok: '9' } }), model('b/y')]);
    aggregateModelTurnsSince.mockRejectedValue(new Error('db down'));
    findLastUsedModel.mockResolvedValue('a/x');
    expect(await getDefaultModelId('user-1')).toBe('a/x');

    findLastUsedModel.mockRejectedValue(new Error('db down'));
    expect(await getDefaultModelId('user-1')).toBe('b/y');
    expect(await getDefaultModelId(null)).toBe('b/y');
  });

  it('refuses with NoModelAvailableError when nothing fits', async () => {
    listChatModels.mockResolvedValue([]);
    listCatalogueModels.mockResolvedValue([]);
    aggregateModelTurnsSince.mockResolvedValue([]);
    await expect(getDefaultModelId(null)).rejects.toBeInstanceOf(NoModelAvailableError);
    await expect(getUtilityModelId()).rejects.toBeInstanceOf(NoModelAvailableError);
    await expect(getSpeechModelId()).rejects.toBeInstanceOf(NoModelAvailableError);
  });

  it('picks utility and speech from the catalogue', async () => {
    listChatModels.mockResolvedValue([model('a/cheap', { pricing: { inputPerMTok: '0.1', outputPerMTok: '0.1' } }), model('b/dear')]);
    listCatalogueModels.mockResolvedValue([model('v/voice', { outputModalities: ['audio'], tools: false })]);
    expect(await getUtilityModelId()).toBe('a/cheap');
    expect(await getSpeechModelId()).toBe('v/voice');
  });
});
