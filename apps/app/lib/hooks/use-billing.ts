import { useQuery, useMutation } from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import apiClient from '../api/client';

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
    queryKey: ['credit-packages'],
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
    queryKey: ['subscription-plans', product],
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
    queryKey: ['subscription', product],
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
    queryKey: ['subscription-poll', product],
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

async function fetchTransactions(limit: number = 20, offset: number = 0): Promise<{ transactions: Transaction[]; total: number }> {
  const response = await apiClient.get(`/billing/transactions?limit=${limit}&offset=${offset}`);
  return response.data;
}

export function useTransactions(limit: number = 20, offset: number = 0) {
  const { isAuthenticated } = useOxy();

  return useQuery({
    queryKey: ['transactions', limit, offset],
    queryFn: () => fetchTransactions(limit, offset),
    staleTime: 1000 * 60, // 1 minute
    retry: 1,
    enabled: isAuthenticated,
  });
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
  const { isAuthenticated } = useOxy();

  return useQuery({
    queryKey: ['credit-price'],
    queryFn: async (): Promise<CreditPriceInfo> => {
      const response = await apiClient.get('/billing/credit-price');
      return response.data;
    },
    staleTime: 1000 * 60 * 10,
    enabled: isAuthenticated,
  });
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

export function useCancelSubscription() {
  return useMutation({
    mutationFn: async () => {
      const response = await apiClient.post('/billing/subscription/cancel');
      return response.data;
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

async function fetchEntitlements(): Promise<Entitlements> {
  const response = await apiClient.get('/billing/entitlements');
  return response.data;
}

export function useEntitlements() {
  const { isAuthenticated } = useOxy();

  return useQuery({
    queryKey: ['entitlements'],
    queryFn: fetchEntitlements,
    staleTime: 1000 * 60 * 5, // 5 minutes
    retry: 2,
    enabled: isAuthenticated,
    placeholderData: FREE_ENTITLEMENTS,
  });
}
