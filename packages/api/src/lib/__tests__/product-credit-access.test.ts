import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ service: vi.fn(), user: vi.fn(), reserve: vi.fn() }));
vi.mock('../../middleware/auth', () => ({
  oxyClient: {
    productGrantSnapshotForService: state.service,
    productGrantSnapshotForUser: state.user,
  },
}));
vi.mock('../credits-manager', () => ({ reserveCredits: state.reserve }));
vi.mock('../credit-price-snapshot', () => ({
  captureCreditPriceBook: async () => ({ id: 'synthetic-only' }),
  createCreditPriceBook: () => ({ id: 'synthetic-fixed' }),
}));
import {
  readConfiguredProductCreditSnapshotForService,
  reserveBackgroundProductCredits,
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
it('missing offline authority offers no bundle admission but preserves legacy sources', async () => {
  process.env.ALIA_OXY_PRODUCT_CREDIT_ADAPTER = JSON.stringify(adapter);
  state.service.mockRejectedValue(new Error('No existing offline consent'));
  state.reserve.mockResolvedValue(null);
  expect(await reserveBackgroundProductCredits('account-b', 3)).toBeNull();
  expect(state.reserve).toHaveBeenCalledWith(
    'account-b',
    3,
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
