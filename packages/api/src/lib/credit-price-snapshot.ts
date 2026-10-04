import type { CREDIT_PRICE_BOOK_SOURCES } from '../domain/credit-operation.js';
import { createHash } from 'node:crypto';
import { listCatalogueModels, type CatalogueModel, type ModelPricing } from './models/catalogue.js';

/** Existing offer and arithmetic; changes require a new formula version. */
export const CREDITS_CONFIG = Object.freeze({
  USD_PER_CREDIT: 0.001,
  TOKENS_PER_CREDIT: 1000,
  MIN_CREDITS_PER_REQUEST: 1,
  INITIAL_RESERVATION: 1,
});
export const CREDIT_FORMULA_VERSION = 'catalogue-usd-ceil-1e9-system-input-excluded-v1' as const;
export interface CreditFormulaConfig {
  readonly USD_PER_CREDIT: number;
  readonly TOKENS_PER_CREDIT: number;
  readonly MIN_CREDITS_PER_REQUEST: number;
  readonly INITIAL_RESERVATION: number;
}
export interface CreditPriceBook {
  readonly id: string;
  readonly capturedAt: string;
  readonly source: (typeof CREDIT_PRICE_BOOK_SOURCES)[number];
  readonly formulaVersion: typeof CREDIT_FORMULA_VERSION;
  readonly fallbackRule: 'unpriced-or-unknown-model-base-rate';
  readonly roundingScale: number;
  readonly config: CreditFormulaConfig;
  readonly models: Readonly<Record<string, ModelPricing | null>>;
}

export function createCreditPriceBook(
  models: readonly Pick<CatalogueModel, 'id' | 'pricing'>[],
  source: CreditPriceBook['source'] = 'oxy_catalogue_cache',
): CreditPriceBook {
  const prices: Record<string, ModelPricing | null> = Object.create(null);
  for (const model of [...models].sort((a, b) => a.id.localeCompare(b.id))) {
    prices[model.id] =
      model.pricing === null
        ? null
        : Object.freeze({
            inputPerMTok: model.pricing.inputPerMTok,
            outputPerMTok: model.pricing.outputPerMTok,
            ...(model.pricing.priceVersionId === undefined
              ? {}
              : { priceVersionId: model.pricing.priceVersionId }),
          });
  }
  const terms = {
    source,
    formulaVersion: CREDIT_FORMULA_VERSION,
    fallbackRule: 'unpriced-or-unknown-model-base-rate' as const,
    roundingScale: 1e9,
    config: CREDITS_CONFIG,
    models: Object.freeze(prices),
  };
  return Object.freeze({
    id: createHash('sha256').update(JSON.stringify(terms)).digest('hex'),
    capturedAt: new Date().toISOString(),
    ...terms,
  });
}

/** The existing unavailable-catalogue fallback is pinned before any forward. */
export async function captureCreditPriceBook(): Promise<CreditPriceBook> {
  try {
    return createCreditPriceBook(await listCatalogueModels());
  } catch {
    return createCreditPriceBook([], 'catalogue_unavailable_base_rate');
  }
}
