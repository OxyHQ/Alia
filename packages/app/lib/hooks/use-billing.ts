import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import apiClient from '../api/client';
import { queryKeys } from './query-keys';
import { useAuthQuery } from './create-query';

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

export interface Subscription {
  _id: string;
  userId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  stripePriceId: string;
  status: 'active' | 'canceled' | 'past_due' | 'unpaid' | 'trialing';
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  plan: {
    planId?: string;
    name: string;
    product: 'alia' | 'codea';
    creditsPerMonth: number;
    price: number;
    currency: string;
    billingPeriod?: 'monthly' | 'annual';
  };
  createdAt: string;
  updatedAt: string;
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
  const { isAuthenticated } = useOxy();

  return useQuery({
    queryKey: queryKeys.billing.subscription(product),
    queryFn: () => fetchSubscription(product),
    staleTime: 1000 * 60 * 2, // 2 minutes
    retry: 2,
    enabled: isAuthenticated,
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
  options?: { enabled?: boolean; intervalMs?: number; maxAttempts?: number }
) {
  const { enabled = false, intervalMs = 2000, maxAttempts = 15 } = options || {};

  return useQuery({
    queryKey: queryKeys.billing.subscriptionPoll(product),
    queryFn: () => fetchSubscription(product),
    enabled,
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
  return useAuthQuery<CreditPriceInfo>(queryKeys.credits.price, '/billing/credit-price', undefined, { staleTime: 600_000 });
}

export function useCreateSubscriptionCheckout() {
  return useMutation({
    mutationFn: async ({
      planId,
      billingPeriod,
      successUrl,
      cancelUrl,
    }: {
      planId: string;
      billingPeriod: 'monthly' | 'annual';
      successUrl: string;
      cancelUrl: string;
    }) => {
      const response = await apiClient.post('/billing/checkout/subscription', {
        planId,
        billingPeriod,
        successUrl,
        cancelUrl,
      });
      return response.data;
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
      queryClient.invalidateQueries({ queryKey: queryKeys.billing.entitlements });
      queryClient.invalidateQueries({ queryKey: queryKeys.billing.subscription() });
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
      queryClient.invalidateQueries({ queryKey: queryKeys.billing.entitlements });
      queryClient.invalidateQueries({ queryKey: queryKeys.billing.subscription() });
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
  allowedModelIds: string[];
  features: Record<string, boolean | number>;
  planId: string | null;
}

const FREE_ENTITLEMENTS: Entitlements = {
  allowedModelIds: ['alia-lite', 'alia-v1', 'alia-v1-audio'],
  features: {},
  planId: 'free',
};

export function useEntitlements() {
  return useAuthQuery<Entitlements>(queryKeys.billing.entitlements, '/billing/entitlements', undefined, {
    placeholderData: FREE_ENTITLEMENTS,
  });
}
