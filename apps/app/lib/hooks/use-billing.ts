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
    staleTime: 1000 * 60 * 60, // 1 hour
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
    staleTime: 1000 * 60 * 60, // 1 hour
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
