import { useQuery, useMutation } from '@tanstack/react-query';
import { useAuth } from '@oxyhq/auth';
import apiClient from '@/lib/api/client';

export interface CreditPackage {
  id: string;
  name: string;
  credits: number;
  price: number;
  currency: string;
}

export interface SubscriptionPlan {
  id: string;
  name: string;
  creditsPerMonth: number;
  price: number;
  stripePriceId: string;
  currency: string;
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
    name: string;
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

export interface Credits {
  credits: number;
  freeCredits: number;
  paidCredits: number;
  dailyRefresh: number;
  lastRefresh: string | null;
}

// ======================
// Credits
// ======================

async function fetchCredits(): Promise<Credits> {
  const response = await apiClient.get('/credits/');
  return response.data;
}

export function useCredits() {
  const { isAuthenticated, isReady } = useAuth();

  return useQuery({
    queryKey: ['credits'],
    queryFn: fetchCredits,
    staleTime: 1000 * 60, // 1 minute
    retry: 2,
    enabled: isReady && isAuthenticated,
  });
}

// ======================
// Credit Packages
// ======================

async function fetchPackages(): Promise<CreditPackage[]> {
  const response = await apiClient.get('/billing/packages');
  return response.data.packages;
}

export function useCreditPackages() {
  const { isAuthenticated, isReady } = useAuth();

  return useQuery({
    queryKey: ['credit-packages'],
    queryFn: fetchPackages,
    staleTime: 1000 * 60 * 60, // 1 hour
    retry: 2,
    enabled: isReady && isAuthenticated,
  });
}

// ======================
// Subscription Plans
// ======================

async function fetchPlans(): Promise<SubscriptionPlan[]> {
  const response = await apiClient.get('/billing/plans');
  return response.data.plans;
}

export function useSubscriptionPlans() {
  const { isAuthenticated, isReady } = useAuth();

  return useQuery({
    queryKey: ['subscription-plans'],
    queryFn: fetchPlans,
    staleTime: 1000 * 60 * 60, // 1 hour
    retry: 2,
    enabled: isReady && isAuthenticated,
  });
}

// ======================
// Current Subscription
// ======================

async function fetchSubscription(): Promise<Subscription | null> {
  const response = await apiClient.get('/billing/subscription');
  return response.data.subscription;
}

export function useSubscription() {
  const { isAuthenticated, isReady } = useAuth();

  return useQuery({
    queryKey: ['subscription'],
    queryFn: fetchSubscription,
    staleTime: 1000 * 60 * 2, // 2 minutes
    retry: 2,
    enabled: isReady && isAuthenticated,
  });
}

// ======================
// Transactions
// ======================

async function fetchTransactions(
  limit: number = 20,
  offset: number = 0
): Promise<{ transactions: Transaction[]; total: number }> {
  const response = await apiClient.get(`/billing/transactions?limit=${limit}&offset=${offset}`);
  return response.data;
}

export function useTransactions(limit: number = 20, offset: number = 0) {
  const { isAuthenticated, isReady } = useAuth();

  return useQuery({
    queryKey: ['transactions', limit, offset],
    queryFn: () => fetchTransactions(limit, offset),
    staleTime: 1000 * 60, // 1 minute
    retry: 1,
    enabled: isReady && isAuthenticated,
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
      successUrl,
      cancelUrl,
    }: {
      planId: string;
      successUrl: string;
      cancelUrl: string;
    }) => {
      const response = await apiClient.post('/billing/checkout/subscription', {
        planId,
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
