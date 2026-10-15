import { type ProductPlanCatalogue, oxyAccountIdSchema } from '@oxy.so/contracts';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useOxy, useDisplayCurrency } from '@oxy.so/services';
import { authenticatedApiCall } from '@oxy.so/core';
import {
  getProductCheckoutKey,
  clearProductCheckoutKey,
  productCheckoutStorageKey,
} from './product-checkout';
import apiClient from '@/shared/api/client';
import { queryKeys } from '@/shared/api/query-keys';
import { useAuthQuery } from '@/shared/api/create-query';

export interface CreditPackage {
  id: string;
  name: string;
  credits: number;
  price: number;
  currency: string;
}

export interface PlanFeatureItem {
  label: string;
  description?: string;
}

export interface PlanFeatureGroup {
  category: string;
  items: PlanFeatureItem[];
}

export interface SubscriptionPlan {
  id: string;
  name: string;
  product: 'alia' | 'codea';
  creditsPerMonth: number;
  monthlyPrice: number;
  annualPrice: number;
  currency: string;
  features?: PlanFeatureGroup[];
  subtitle?: string;
  creditsLabel?: string;
  isFeatured?: boolean;
  isFree?: boolean;
  sortOrder?: number;
}

/**
 * What `GET /billing/subscription` serves — the API's `serializeSubscription`,
 * field for field.
 *
 * It used to claim the Stripe and owner ids too, which the API had already
 * stopped sending and nothing here ever read.
 */
export interface Subscription {
  status: 'active' | 'canceled' | 'past_due' | 'unpaid' | 'trialing';
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  /** A complimentary plan: not billed, and neither changeable nor cancellable. */
  isComped: boolean;
  plan: {
    planId: string | null;
    name: string;
    product: 'alia' | 'codea';
    creditsPerMonth: number;
    price: number;
    currency: string;
    billingPeriod: 'monthly' | 'annual';
  };
  createdAt: string;
}

export interface Transaction {
  _id: string;
  userId: string;
  stripeCustomerId?: string;
  stripePaymentIntentId?: string;
  type: 'credit_purchase' | 'subscription_payment' | 'refund';
  amount: number;
  currency: string;
  credits: number;
  status: 'pending' | 'completed' | 'failed' | 'refunded';
  description?: string;
  createdAt: string;
  updatedAt: string;
}

// ======================
// Credit Packages
// ======================

async function fetchPackages(): Promise<CreditPackage[]> {
  const response = await apiClient.get('/billing/packages');
  return response.data.packages;
}

export function useCreditPackages() {
  const { isAuthenticated } = useOxy();

  return useQuery({
    queryKey: queryKeys.billing.packages,
    queryFn: fetchPackages,
    staleTime: 1000 * 60 * 5, // 5 minutes
    retry: 2,
    enabled: isAuthenticated,
  });
}

// ======================
// Subscription Plans
// ======================

async function fetchPlans(product?: 'alia' | 'codea'): Promise<SubscriptionPlan[]> {
  const params = product ? `?product=${product}` : '';
  const response = await apiClient.get(`/billing/plans${params}`);
  return response.data.plans;
}

export function useSubscriptionPlans(product?: 'alia' | 'codea') {
  const { isAuthenticated } = useOxy();

  return useQuery({
    queryKey: queryKeys.billing.plans(product),
    queryFn: () => fetchPlans(product),
    staleTime: 1000 * 60 * 5, // 5 minutes
    retry: 2,
    enabled: isAuthenticated,
  });
}

// ======================
// Current Subscription
// ======================

async function fetchSubscription(product?: 'alia' | 'codea'): Promise<Subscription | null> {
  const params = product ? `?product=${product}` : '';
  const response = await apiClient.get(`/billing/subscription${params}`);
  return response.data.subscription;
}

export function useSubscription(product?: 'alia' | 'codea') {
  const { isAuthenticated, user, activeSessionId } = useOxy();

  return useQuery({
    queryKey: [...queryKeys.billing.subscription(product), user?.id, activeSessionId],
    queryFn: () => fetchSubscription(product),
    staleTime: 0,
    gcTime: 0, // 2 minutes
    retry: 2,
    enabled: isAuthenticated && !!user?.id && !!activeSessionId,
  });
}

// ======================
// Subscription Polling (after checkout redirect)
// ======================

/**
 * Polls for subscription until it exists and is active, or timeout.
 * Used after checkout redirect to wait for webhook processing.
 */
export function useSubscriptionPolling(
  product?: 'alia' | 'codea',
  options?: { enabled?: boolean; intervalMs?: number; maxAttempts?: number },
) {
  const { enabled = false, intervalMs = 2000, maxAttempts = 15 } = options || {};
  const { user, activeSessionId, isAuthenticated } = useOxy();

  return useQuery({
    queryKey: [...queryKeys.billing.subscriptionPoll(product), user?.id, activeSessionId],
    queryFn: () => fetchSubscription(product),
    enabled: enabled && isAuthenticated && !!user?.id && !!activeSessionId,
    gcTime: 0,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data && (data.status === 'active' || data.status === 'trialing')) {
        return false;
      }
      if (query.state.dataUpdateCount >= maxAttempts) {
        return false;
      }
      return intervalMs;
    },
    staleTime: 0,
    retry: 1,
  });
}

// ======================
// Transactions
// ======================

export function useTransactions(limit: number = 20, offset: number = 0) {
  return useAuthQuery<{ transactions: Transaction[]; total: number }>(
    queryKeys.billing.transactions(limit, offset),
    '/billing/transactions',
    { limit, offset },
    { staleTime: 60_000, retry: 1 },
  );
}

// ======================
// Checkout
// ======================

export function useCreateCheckout() {
  return useMutation({
    mutationFn: async ({
      packageId,
      successUrl,
      cancelUrl,
    }: {
      packageId: string;
      successUrl: string;
      cancelUrl: string;
    }) => {
      const response = await apiClient.post('/billing/checkout/credits', {
        packageId,
        successUrl,
        cancelUrl,
      });
      return response.data;
    },
  });
}

export function useCreateCustomCheckout() {
  return useMutation({
    mutationFn: async ({
      credits,
      successUrl,
      cancelUrl,
    }: {
      credits: number;
      successUrl: string;
      cancelUrl: string;
    }) => {
      const response = await apiClient.post('/billing/checkout/custom-credits', {
        credits,
        successUrl,
        cancelUrl,
      });
      return response.data;
    },
  });
}

export interface CreditPriceInfo {
  pricePerCreditCents: number;
  minCredits: number;
  maxCredits: number;
}

export function useCreditPrice() {
  return useAuthQuery<CreditPriceInfo>(
    queryKeys.credits.price,
    '/billing/credit-price',
    undefined,
    { staleTime: 600_000 },
  );
}

interface ProductCheckoutConfig {
  productId: string | null;
  plans: Array<{
    planId: string;
    billingPeriod: 'monthly' | 'annual';
    offerId: string;
    offerVersion: number;
  }>;
}

export function useProductCheckoutOptions() {
  const { oxyServices, isAuthenticated, user, activeSessionId } = useOxy();
  return useQuery({
    queryKey: ['billing', 'product-checkout', user?.id, activeSessionId],
    enabled: isAuthenticated && !!user?.id,
    staleTime: 0,
    gcTime: 0,
    queryFn: async () => {
      const { data } = await apiClient.get<ProductCheckoutConfig>('/billing/product-checkout');
      if (!data.productId)
        return {
          available: false,
          plans: [] as Array<
            ProductCheckoutConfig['plans'][number] & {
              price: ProductPlanCatalogue['plans'][number]['price'];
            }
          >,
          productId: null,
          currentPlan: null as { planId: string; sourceId: string } | null,
        };
      const catalogue = await oxyServices.billing.productPlans(data.productId);
      if (!user?.id || !activeSessionId) throw new Error('Sign in to continue');
      const subscriptions = await authenticatedApiCall(oxyServices, activeSessionId, () =>
        oxyServices.billing.productSubscriptions(user.id),
      );
      const held = subscriptions
        .filter((source) => ['active', 'past_due', 'unpaid', 'incomplete'].includes(source.status))
        .flatMap((source) =>
          source.offers.flatMap((offer) => {
            const binding = data.plans.find(
              (plan) =>
                offer.origin === 'individual' &&
                offer.offerId === plan.offerId &&
                offer.offerVersion === plan.offerVersion,
            );
            return binding ? [{ planId: binding.planId, sourceId: source.sourceId }] : [];
          }),
        );
      return {
        productId: data.productId,
        currentPlan: held[0] ?? null,
        available: catalogue.purchase === 'available',
        plans: data.plans.flatMap((binding) => {
          const offer = catalogue.plans.find(
            (offer) =>
              offer.offerId === binding.offerId &&
              offer.offerVersion === binding.offerVersion &&
              offer.price.interval === (binding.billingPeriod === 'annual' ? 'year' : 'month'),
          );
          return offer ? [{ ...binding, price: offer.price }] : [];
        }),
      };
    },
  });
}

export function useCreateSubscriptionCheckout() {
  const { oxyServices, user, activeSessionId } = useOxy();
  const { currency } = useDisplayCurrency();
  return useMutation({
    mutationFn: async ({
      planId,
      billingPeriod,
    }: {
      planId: string;
      billingPeriod: 'monthly' | 'annual';
    }) => {
      if (!user?.id || !activeSessionId) throw new Error('Sign in to continue');
      const { data } = await apiClient.get<ProductCheckoutConfig>('/billing/product-checkout');
      const binding = data.plans.find(
        (item) => item.planId === planId && item.billingPeriod === billingPeriod,
      );
      if (!data.productId || !binding) throw new Error('This subscription is unavailable');
      const productId = data.productId;
      const key = productCheckoutStorageKey(
        user.id,
        productId,
        binding.offerId,
        binding.offerVersion,
      );
      const idempotencyKey = await getProductCheckoutKey(key);
      const result = await authenticatedApiCall(oxyServices, activeSessionId, () =>
        oxyServices.billing.startProductPlanCheckout({
          expectedSubjectAccountId: oxyAccountIdSchema.parse(user.id),
          productId,
          offerId: binding.offerId,
          offerVersion: binding.offerVersion,
          idempotencyKey,
        }),
      );
      if (result.state === 'closed' || result.state === 'fulfilled')
        await clearProductCheckoutKey(key);
      if (result.state === 'unconfigured') throw new Error('This subscription is unavailable');
      if (result.state === 'closed')
        throw new Error('Checkout closed. Please request a new quote.');
      if (result.state === 'fulfilled') return { state: result.state };
      if (!result.checkoutUrl)
        throw new Error('Checkout is pending. Retry to continue the same payment.');
      const url = new URL(result.checkoutUrl);
      url.searchParams.set('displayCurrency', currency);
      return { state: result.state, url: url.toString() };
    },
  });
}

export function useChangePlan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      planId,
      billingPeriod,
    }: {
      planId: string;
      billingPeriod: 'monthly' | 'annual';
    }) => {
      const response = await apiClient.post('/billing/subscription/change-plan', {
        planId,
        billingPeriod,
      });
      return response.data as { subscription: Subscription; direction: 'upgrade' | 'downgrade' };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.billing.entitlements });
      void queryClient.invalidateQueries({ queryKey: queryKeys.billing.subscription() });
    },
  });
}

export function useCancelSubscription() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const response = await apiClient.post('/billing/subscription/cancel');
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.billing.entitlements });
      void queryClient.invalidateQueries({ queryKey: queryKeys.billing.subscription() });
    },
  });
}

export function useCreatePortalSession() {
  return useMutation({
    mutationFn: async (returnUrl: string) => {
      const response = await apiClient.post('/billing/portal', { returnUrl });
      return response.data.url;
    },
  });
}

// ======================
// Entitlements
// ======================

export interface Entitlements {
  subjectAccountId?: string;
  effectivePlanId?: string | null;
  features: Record<string, boolean | number>;
  planId: string | null;
}

const FREE_ENTITLEMENTS: Entitlements = {
  features: {},
  planId: 'free',
};

export function useEntitlements() {
  const { user, activeSessionId, isAuthenticated } = useOxy();
  return useAuthQuery<Entitlements>(
    [...queryKeys.billing.entitlements, user?.id, activeSessionId],
    '/billing/entitlements',
    undefined,
    {
      enabled: isAuthenticated && !!user?.id && !!activeSessionId,
      staleTime: 0,
      gcTime: 0,
      placeholderData: FREE_ENTITLEMENTS,
      queryFn: async () => {
        const { data } = await apiClient.get('/billing/entitlements');
        if (data.subjectAccountId !== user?.id) throw new Error('Entitlement account changed');
        return data;
      },
    },
  );
}
