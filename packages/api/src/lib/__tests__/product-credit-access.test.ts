import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ service: vi.fn(), user: vi.fn(), reserve: vi.fn() }));
vi.mock('../../lib/oxy.js', () => ({
  oxy: {
    productGrantSnapshotForService: state.service,
    productGrantSnapshotForUser: state.user,
  },
}));
vi.mock('../credits-manager', () => ({ reserveCredits: state.reserve }));
vi.mock('../credit-price-snapshot', () => ({
  captureCreditPriceBook: async () => ({ id: 'synthetic-only' }),
  createCreditPriceBook: () => ({ id: 'synthetic-fixed' }),
}));
import { OxyApiError } from '@oxy.so/core';
import {
  ProductCreditAuthorityUnavailableError,
  readConfiguredProductCreditSnapshotForService,
  reserveBackgroundProductCredits,
  reserveUserProductCredits,
} from '../product-credit-access';
const adapter = {
  productId: 'synthetic-alia',
  quotaKey: 'monthly_credits',
  unit: 'alia_credit',
  combination: 'maximum',
  planId: 'pro',
};
afterEach(() => {
  delete process.env.ALIA_OXY_PRODUCT_CREDIT_ADAPTER;
  vi.resetAllMocks();
});
it('retains legacy free and individual funding when unconfigured without an authority call', async () => {
  await reserveBackgroundProductCredits('account-a');
  expect(state.reserve).toHaveBeenCalledWith('account-a');
  expect(state.service).not.toHaveBeenCalled();
});
it('uses only exact service subject/product and never impersonates a user session', async () => {
  process.env.ALIA_OXY_PRODUCT_CREDIT_ADAPTER = JSON.stringify(adapter);
  state.service.mockResolvedValue({ synthetic: true });
  await readConfiguredProductCreditSnapshotForService('account-a');
  expect(state.service).toHaveBeenCalledWith({
    schemaVersion: 1,
    subjectAccountId: 'account-a',
    productId: 'synthetic-alia',
  });
  expect(state.user).not.toHaveBeenCalled();
});
const oxyRefusal = (status: number) =>
  new OxyApiError(`Oxy answered ${status}`, { status, code: `HTTP_${status}` });

it.each([403, 404])(
  'an account Oxy answers %i for (no offline consent, no grant) keeps legacy sources',
  async (status) => {
    process.env.ALIA_OXY_PRODUCT_CREDIT_ADAPTER = JSON.stringify(adapter);
    state.service.mockRejectedValue(oxyRefusal(status));
    state.reserve.mockResolvedValue(null);
    expect(await reserveBackgroundProductCredits('account-b', 3)).toBeNull();
    expect(state.reserve).toHaveBeenCalledWith(
      'account-b',
      3,
      expect.objectContaining({ productCreditSnapshot: undefined }),
    );
  },
);

it.each([
  ['a 5xx', () => oxyRefusal(503)],
  ['a 401', () => oxyRefusal(401)],
  [
    'a network failure',
    () => new OxyApiError('fetch failed', { status: 0, code: 'NETWORK_ERROR' }),
  ],
  ['an unreadable answer', () => new Error('Product grant response attribution differs')],
])('%s is an outage: typed, never legacy funding, and asked again next time', async (_, fault) => {
  process.env.ALIA_OXY_PRODUCT_CREDIT_ADAPTER = JSON.stringify(adapter);
  state.service.mockRejectedValueOnce(fault());
  await expect(reserveBackgroundProductCredits('account-c', 3)).rejects.toBeInstanceOf(
    ProductCreditAuthorityUnavailableError,
  );
  expect(state.reserve).not.toHaveBeenCalled();

  // Nothing was remembered: the next reservation asks Oxy again and is funded.
  state.service.mockResolvedValueOnce({ synthetic: true });
  state.reserve.mockResolvedValue({ reservationId: 'r-1' });
  await reserveBackgroundProductCredits('account-c', 3);
  expect(state.service).toHaveBeenCalledTimes(2);
  expect(state.reserve).toHaveBeenCalledTimes(1);
});

it('a user-present job refuses on an outage rather than falling back', async () => {
  process.env.ALIA_OXY_PRODUCT_CREDIT_ADAPTER = JSON.stringify(adapter);
  state.user.mockRejectedValue(oxyRefusal(502));
  await expect(reserveUserProductCredits('account-d', 5, 'bearer-d')).rejects.toBeInstanceOf(
    ProductCreditAuthorityUnavailableError,
  );
  expect(state.reserve).not.toHaveBeenCalled();
});

it('a user-present job with no grant (403) keeps legacy sources', async () => {
  process.env.ALIA_OXY_PRODUCT_CREDIT_ADAPTER = JSON.stringify(adapter);
  state.user.mockRejectedValue(oxyRefusal(403));
  state.reserve.mockResolvedValue({ reservationId: 'r-2' });
  await reserveUserProductCredits('account-e', 5, 'bearer-e');
  expect(state.reserve).toHaveBeenCalledWith(
    'account-e',
    5,
    expect.objectContaining({ productCreditSnapshot: undefined }),
  );
});

it('attaches a fresh exact-subject service read to admitted bundle operations', async () => {
  process.env.ALIA_OXY_PRODUCT_CREDIT_ADAPTER = JSON.stringify(adapter);
  state.service.mockResolvedValue({ synthetic: true });
  state.reserve.mockResolvedValue({ productAllocationId: 'grant-a' });
  const held = await reserveBackgroundProductCredits('account-a');
  await held?.refreshProductCreditSnapshot?.();
  expect(state.service).toHaveBeenCalledTimes(2);
  expect(state.user).not.toHaveBeenCalled();
});
