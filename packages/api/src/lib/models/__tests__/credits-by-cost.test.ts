import { describe, expect, it, vi } from 'vitest';

import type { CatalogueModel } from '../catalogue.js';

const findCatalogueModel = vi.fn<(id: string) => Promise<CatalogueModel | null>>();
vi.mock('../catalogue.js', () => ({ findCatalogueModel: (id: string) => findCatalogueModel(id) }));

const { calculateCredits, creditsForCost, CREDITS_CONFIG } = await import('../../credits-manager.js');

function priced(inputPerMTok: string, outputPerMTok: string): CatalogueModel {
  return {
    id: 'acme/m',
    name: 'M',
    publisher: { id: 'acme', name: 'Acme' },
    description: null,
    contextWindow: null,
    maxOutput: null,
    inputModalities: ['text'],
    outputModalities: ['text'],
    tools: true,
    reasoningEfforts: [],
    pricing: { inputPerMTok, outputPerMTok },
    releasedAt: null,
  };
}

describe('credits are charged by real cost', () => {
  it('converts USD at USD_PER_CREDIT, rounding up, with a floor', () => {
    expect(CREDITS_CONFIG.USD_PER_CREDIT).toBe(0.001);
    expect(creditsForCost(0.0105)).toBe(11);
    expect(creditsForCost(0.003)).toBe(3);
    expect(creditsForCost(0)).toBe(CREDITS_CONFIG.MIN_CREDITS_PER_REQUEST);
  });

  it('prices input and output tokens at the model’s own catalogue prices, net of Alia’s system prompt', async () => {
    findCatalogueModel.mockResolvedValue(priced('3', '15'));
    // (11,000 - 1,000) input × $3/M + 1,000 output × $15/M = $0.03 + $0.015 = $0.045 → 45 credits.
    await expect(calculateCredits(
      { promptTokens: 11_000, completionTokens: 1_000, totalTokens: 12_000, systemPromptTokens: 1_000 },
      'acme/m',
    )).resolves.toBe(45);
  });

  it('a dearer model costs more for the same tokens', async () => {
    const usage = { promptTokens: 10_000, completionTokens: 2_000, totalTokens: 12_000 };
    findCatalogueModel.mockResolvedValue(priced('0.1', '0.4'));
    const cheap = await calculateCredits(usage, 'acme/m');
    findCatalogueModel.mockResolvedValue(priced('15', '75'));
    const dear = await calculateCredits(usage, 'acme/m');
    expect(cheap).toBe(2);
    expect(dear).toBe(300);
  });

  it('falls back to the base rate when nothing prices the model, or no model is named', async () => {
    findCatalogueModel.mockResolvedValue(null);
    await expect(calculateCredits({ promptTokens: 1500, completionTokens: 500, totalTokens: 2000 }, 'gone/model')).resolves.toBe(2);
    await expect(calculateCredits({ promptTokens: 1500, completionTokens: 500, totalTokens: 2000 })).resolves.toBe(2);
    await expect(calculateCredits({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }, 'acme/m')).resolves.toBe(1);
  });
});
