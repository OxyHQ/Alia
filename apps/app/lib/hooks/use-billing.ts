import { useQuery, useMutation } from '@tanstack/react-query';
import { generateAPIUrl } from '../generate-api-url';
import { useAuthStore } from '../stores/auth-store';

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

function getAPIHeaders(): HeadersInit {
  const token = useAuthStore.getState().token;
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

// ======================
// Credit Packages
// ======================

async function fetchPackages(): Promise<CreditPackage[]> {
  const apiUrl = generateAPIUrl('/billing/packages');
  const response = await fetch(apiUrl, {
    method: 'GET',
    headers: getAPIHeaders(),
  });

  if (!response.ok) {
    throw new Error('Failed to fetch packages');
  }

  const data = await response.json();
  return data.packages;
}

export function useCreditPackages() {
  return useQuery({
    queryKey: ['credit-packages'],
    queryFn: fetchPackages,
    staleTime: 1000 * 60 * 60, // 1 hour
    retry: 2,
  });
}

// ======================
// Subscription Plans
// ======================

async function fetchPlans(): Promise<SubscriptionPlan[]> {
  const apiUrl = generateAPIUrl('/billing/plans');
  const response = await fetch(apiUrl, {
    method: 'GET',
    headers: getAPIHeaders(),
  });

  if (!response.ok) {
    throw new Error('Failed to fetch plans');
  }

  const data = await response.json();
  return data.plans;
}

export function useSubscriptionPlans() {
  return useQuery({
    queryKey: ['subscription-plans'],
    queryFn: fetchPlans,
    staleTime: 1000 * 60 * 60, // 1 hour
    retry: 2,
  });
}

// ======================
// Current Subscription
// ======================

async function fetchSubscription(): Promise<Subscription | null> {
  const apiUrl = generateAPIUrl('/billing/subscription');
  const response = await fetch(apiUrl, {
    method: 'GET',
    headers: getAPIHeaders(),
  });

  if (!response.ok) {
    throw new Error('Failed to fetch subscription');
  }

  const data = await response.json();
  return data.subscription;
}

export function useSubscription() {
  return useQuery({
    queryKey: ['subscription'],
    queryFn: fetchSubscription,
    staleTime: 1000 * 60 * 2, // 2 minutes
    retry: 2,
  });
}

// ======================
// Transactions
// ======================

async function fetchTransactions(limit: number = 20, offset: number = 0): Promise<{ transactions: Transaction[]; total: number }> {
  const apiUrl = generateAPIUrl(`/billing/transactions?limit=${limit}&offset=${offset}`);
  const response = await fetch(apiUrl, {
    method: 'GET',
    headers: getAPIHeaders(),
  });

  if (!response.ok) {
    throw new Error('Failed to fetch transactions');
  }

  return await response.json();
}

export function useTransactions(limit: number = 20, offset: number = 0) {
  return useQuery({
    queryKey: ['transactions', limit, offset],
    queryFn: () => fetchTransactions(limit, offset),
    staleTime: 1000 * 60, // 1 minute
    retry: 1,
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
      const apiUrl = generateAPIUrl('/billing/checkout/credits');
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: getAPIHeaders(),
        body: JSON.stringify({ packageId, successUrl, cancelUrl }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to create checkout session');
      }

      const data = await response.json();
      return data;
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
      const apiUrl = generateAPIUrl('/billing/checkout/subscription');
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: getAPIHeaders(),
        body: JSON.stringify({ planId, successUrl, cancelUrl }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to create checkout session');
      }

      const data = await response.json();
      return data;
    },
  });
}

export function useCancelSubscription() {
  return useMutation({
    mutationFn: async () => {
      const apiUrl = generateAPIUrl('/billing/subscription/cancel');
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: getAPIHeaders(),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to cancel subscription');
      }

      return await response.json();
    },
  });
}

export function useCreatePortalSession() {
  return useMutation({
    mutationFn: async (returnUrl: string) => {
      const apiUrl = generateAPIUrl('/billing/portal');
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: getAPIHeaders(),
        body: JSON.stringify({ returnUrl }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to create portal session');
      }

      const data = await response.json();
      return data.url;
    },
  });
}
