import { afterEach, describe, expect, it, vi } from 'vitest';

const listModels = vi.fn();
vi.mock('../../inference/oxy-inference.js', () => ({
  getOxyInferenceClient: () => ({ listModels }),
}));

const {
  isChatUsable,
  isSpeechCapable,
  listCatalogueModels,
  listChatModels,
  normalizeCatalogue,
  normalizeCatalogueEntry,
  resetCatalogueCache,
  scaleToPerMillion,
  CATALOGUE_TTL_MS,
  CatalogueUnavailableError,
} = await import('../catalogue.js');

/** An Oxy `GET /v1/models` entry, shaped as `@oxy.so/contracts` publishes it. */
function oxyEntry(overrides: Record<string, unknown> = {}, capabilities: Record<string, unknown> = {}) {
  return {
    schemaVersion: 3,
    modelId: 'acme/chat-1',
    publisher: { slug: 'acme', displayName: 'Acme' },
    displayName: 'Chat 1',
    description: 'A chat model.',
    currentRevision: '2026-01-01',
    availableRevisions: ['2026-01-01'],
    capabilities: {
      inputModalities: ['text'],
      outputModalities: ['text'],
      tools: true,
      parallelToolCalls: true,
      structuredOutput: true,
      jsonMode: true,
      reasoning: false,
      streaming: true,
      promptCaching: false,
      maxContextTokens: 128_000,
      maxOutputTokens: 8_192,
      ...capabilities,
    },
    releasedOn: '2026-01-01',
    pricing: {
      priceVersionId: 'pv-1',
      currency: 'USD',
      unitPrices: [
        { unit: 'input_tokens', amount: '0.00000015', per: 1, currency: 'USD' },
        { unit: 'output_tokens', amount: '0.0006', per: 1000, currency: 'USD' },
      ],
    },
    servingProviders: [{ slug: 'some-operator', displayName: 'Some Operator', regions: [], dataPolicy: {} }],
    deprecation: { status: 'active' },
    ...overrides,
  };
}

afterEach(() => {
  resetCatalogueCache();
  listModels.mockReset();
  vi.useRealTimers();
});

describe('normalizeCatalogueEntry', () => {
  it('maps an Oxy entry to the product shape, and never reads the serving operator', () => {
    const model = normalizeCatalogueEntry(oxyEntry());
    expect(model).toEqual({
      id: 'acme/chat-1',
      name: 'Chat 1',
      publisher: { id: 'acme', name: 'Acme' },
      description: 'A chat model.',
      contextWindow: 128_000,
      maxOutput: 8_192,
      inputModalities: ['text'],
      outputModalities: ['text'],
      tools: true,
      reasoningEfforts: [],
      pricing: { inputPerMTok: '0.15', outputPerMTok: '0.6' },
      releasedAt: '2026-01-01',
    });
    expect(JSON.stringify(model)).not.toContain('some-operator');
  });

  it('reads reasoningEfforts when Oxy sends them, and offers none when it does not', () => {
    expect(normalizeCatalogueEntry(oxyEntry({ reasoningEfforts: ['high', 'low', 'max'] }))?.reasoningEfforts)
      .toEqual(['low', 'high']);
    expect(normalizeCatalogueEntry(oxyEntry({}, { reasoningEfforts: ['medium'] }))?.reasoningEfforts)
      .toEqual(['medium']);
    // Oxy refuses a level it does not list, so `reasoning: true` alone offers none.
    expect(normalizeCatalogueEntry(oxyEntry({}, { reasoning: true }))?.reasoningEfforts)
      .toEqual([]);
  });

  it('prefers releasedAt over releasedOn, and null when neither is sent', () => {
    expect(normalizeCatalogueEntry(oxyEntry({ releasedAt: '2026-02-02' }))?.releasedAt).toBe('2026-02-02');
    expect(normalizeCatalogueEntry(oxyEntry({ releasedOn: undefined }))?.releasedAt).toBeNull();
  });

  it('prices null when a token price is missing', () => {
    expect(normalizeCatalogueEntry(oxyEntry({ pricing: undefined }))?.pricing).toBeNull();
    expect(
      normalizeCatalogueEntry(oxyEntry({
        pricing: { unitPrices: [{ unit: 'input_tokens', amount: '1', per: 1_000_000, currency: 'USD' }] },
      }))?.pricing,
    ).toBeNull();
  });

  it('drops entries without a publisher/model id, and retired ones', () => {
    expect(normalizeCatalogueEntry(oxyEntry({ modelId: 'no-slash' }))).toBeNull();
    expect(normalizeCatalogueEntry(oxyEntry({ deprecation: { status: 'retired' } }))).toBeNull();
    expect(normalizeCatalogueEntry(null)).toBeNull();
  });
});

describe('scaleToPerMillion', () => {
  it('moves the decimal point exactly for power-of-ten scales', () => {
    expect(scaleToPerMillion('0.00000015', 1)).toBe('0.15');
    expect(scaleToPerMillion('0.0015', 1000)).toBe('1.5');
    expect(scaleToPerMillion('3', 1_000_000)).toBe('3');
    expect(scaleToPerMillion('12', 1)).toBe('12000000');
    expect(scaleToPerMillion('0.5', 10_000_000)).toBe('0.05');
  });

  it('refuses what is not a decimal amount', () => {
    expect(scaleToPerMillion('-1', 1)).toBeNull();
    expect(scaleToPerMillion('abc', 1)).toBeNull();
    expect(scaleToPerMillion('1', 0)).toBeNull();
  });
});

describe('capability filters', () => {
  it('a chat model takes text in, gives text out and supports tools', () => {
    const chat = normalizeCatalogueEntry(oxyEntry())!;
    expect(isChatUsable(chat)).toBe(true);
    expect(isChatUsable({ ...chat, tools: false })).toBe(false);
    expect(isChatUsable({ ...chat, outputModalities: ['image'] })).toBe(false);
    expect(isChatUsable({ ...chat, inputModalities: ['audio'] })).toBe(false);
  });

  it('a speech model gives audio out', () => {
    const chat = normalizeCatalogueEntry(oxyEntry())!;
    expect(isSpeechCapable(chat)).toBe(false);
    expect(isSpeechCapable({ ...chat, outputModalities: ['audio'] })).toBe(true);
  });

  it('keeps the first entry per id, sorted by id', () => {
    const models = normalizeCatalogue([
      oxyEntry({ modelId: 'zeta/a' }),
      oxyEntry({ modelId: 'acme/b', displayName: 'first' }),
      oxyEntry({ modelId: 'acme/b', displayName: 'second' }),
    ]);
    expect(models.map((model) => [model.id, model.name])).toEqual([['acme/b', 'first'], ['zeta/a', 'Chat 1']]);
  });
});

describe('listCatalogueModels', () => {
  it('caches for the TTL and asks Oxy again after it', async () => {
    listModels.mockResolvedValue([oxyEntry()]);
    const now = Date.now();
    await listCatalogueModels(now);
    await listCatalogueModels(now + 1000);
    expect(listModels).toHaveBeenCalledTimes(1);
    vi.useFakeTimers();
    vi.setSystemTime(now + CATALOGUE_TTL_MS + 1);
    await listCatalogueModels(now + CATALOGUE_TTL_MS + 1);
    expect(listModels).toHaveBeenCalledTimes(2);
  });

  it('serves the last good catalogue when a refresh fails', async () => {
    listModels.mockResolvedValueOnce([oxyEntry()]);
    const now = Date.now();
    await listCatalogueModels(now);
    listModels.mockRejectedValueOnce(new Error('down'));
    const models = await listCatalogueModels(now + CATALOGUE_TTL_MS + 1);
    expect(models.map((model) => model.id)).toEqual(['acme/chat-1']);
  });

  it('throws CatalogueUnavailableError with nothing cached', async () => {
    listModels.mockRejectedValueOnce(new Error('down'));
    await expect(listCatalogueModels()).rejects.toBeInstanceOf(CatalogueUnavailableError);
  });

  it('listChatModels keeps only chat-usable models', async () => {
    listModels.mockResolvedValue([
      oxyEntry(),
      oxyEntry({ modelId: 'acme/voice-1' }, { outputModalities: ['audio'], tools: false }),
    ]);
    expect((await listChatModels()).map((model) => model.id)).toEqual(['acme/chat-1']);
  });
});
