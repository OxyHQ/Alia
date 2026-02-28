export interface ProviderKey {
  _id: string;
  name: string;
  provider: string;
  keyPrefix: string;
  environment: string;
  isActive: boolean;
  isPaid: boolean;
  tier: string;
  currentPriority: number;
  originalPriority: number;
  lastUsedAt?: string;
  lastSuccessAt?: string;
  totalRequests: number;
  totalTokens: number;
  successCount: number;
  consecutiveFailures: number;
  totalFailures: number;
  lastFailureAt?: string;
  lastFailureReason?: string;
  maxTotalFailures: number;
  isArchived: boolean;
  archivedAt?: string;
  archivedReason?: string;
  creditLimitUSD?: number | null;
  rateLimitResetMs?: number | null;
  rateLimit: {
    rps?: number;
    rpm?: number;
    rph?: number;
    rpd?: number;
    tps?: number;
    tpm?: number;
    tph?: number;
    tpd?: number;
  };
  createdAt: string;
  updatedAt: string;
}

export interface ModelConfig {
  _id: string;
  modelId: string;
  provider: string;
  displayName?: string;
  aliaTier?: string;
  priority?: number;
  qualityScore?: number;
  capabilities: {
    maxInputTokens: number;
    maxOutputTokens: number;
    supportsStreaming: boolean;
    supportsTools: boolean;
    supportsVision: boolean;
    supportsJsonMode: boolean;
    supportsPdf: boolean;
    urlContext: boolean;
    thinkingLevel: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';
  };
  pricing: {
    inputCostPerMillion: number;
    outputCostPerMillion: number;
  };
  isActive?: boolean;
  isDeprecated?: boolean;
  deprecationDate?: string;
  replacementModelId?: string;
  description?: string;
  providerUrl?: string;
  notes?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface AliaModel {
  _id: string;
  aliasModelId: string;
  displayName: string;
  tier: string;
  description?: string;
  features?: string[];
  providerMappings: Array<{
    modelConfigId?: string;
    provider: string;
    modelId: string;
    priority: number;
    qualityScore: number;
    isActive: boolean;
  }>;
  creditMultiplier: number;
  isFreeTier: boolean;
  aggregatedCapabilities: {
    vision: boolean;
    audio: boolean;
    codeExecution: boolean;
    webSearch: boolean;
    thinking: boolean;
  };
  isActive: boolean;
  isDeprecated: boolean;
  totalRequests: number;
  totalTokens: number;
  averageLatencyMs: number;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface HealthMetrics {
  provider: string;
  modelId: string;
  successCount: number;
  failureCount: number;
  totalRequests: number;
  successRate: number;
  averageLatencyMs: number;
  lastSuccess: string | null;
  lastFailure: string | null;
  lastRequestAt: string;
  consecutiveFailures: number;
  circuitState: 'closed' | 'open' | 'half-open';
  lastHealthCheck: string;
  isHealthy: boolean;
}

// ─── Plans ──────────────────────────────────────────────────

export interface SubscriptionPlan {
  _id: string;
  planId: string;
  name: string;
  product: 'alia' | 'codea';
  creditsPerMonth: number;
  dailyFreeCredits: number;
  monthlyPrice: number;
  annualPrice: number;
  currency: string;
  subtitle: string;
  creditsLabel: string;
  isFeatured: boolean;
  isFree: boolean;
  sortOrder: number;
  modelIds: string[];
  isActive: boolean;
  stripeMonthlyPriceId?: string;
  stripeAnnualPriceId?: string;
  description?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Features ──────────────────────────────────────────────

export interface AdminFeature {
  _id: string;
  featureId: string;
  label: string;
  description?: string;
  icon?: string;
  category: string;
  featureType: 'boolean' | 'limit';
  sortOrder: number;
  isVisibleOnPricing: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdminPlanFeature {
  _id: string;
  planId: string;
  featureId: string;
  enabled: boolean;
  limitValue?: number;
  displayLabel?: string;
  displayDescription?: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Credit Packages ────────────────────────────────────────

export interface CreditPackage {
  _id: string;
  packageId: string;
  name: string;
  credits: number;
  price: number;
  currency: string;
  stripePriceId?: string;
  sortOrder: number;
  isActive: boolean;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Billing Admin ─────────────────────────────────────────

export interface AdminTransaction {
  _id: string;
  oxyUserId: string;
  stripeCustomerId?: string;
  stripePaymentIntentId?: string;
  type: 'credit_purchase' | 'subscription_payment' | 'refund';
  amount: number;
  currency: string;
  credits: number;
  status: 'pending' | 'completed' | 'failed' | 'refunded';
  description?: string;
  metadata?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface AdminSubscription {
  _id: string;
  oxyUserId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  stripePriceId: string;
  status: 'active' | 'canceled' | 'past_due' | 'unpaid' | 'trialing' | 'incomplete' | 'incomplete_expired';
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  planId?: string;
  billingPeriod: 'monthly' | 'annual';
  plan: {
    planId?: string;
    name: string;
    product: 'alia' | 'codea';
    creditsPerMonth: number;
    price: number;
    currency: string;
    billingPeriod: 'monthly' | 'annual';
  };
  createdAt: string;
  updatedAt: string;
}

// ─── Providers & Tiers ──────────────────────────────────────

export const PROVIDERS = [
  'openai',
  'anthropic',
  'google',
  'groq',
  'mistral',
  'deepseek',
  'together',
  'replicate',
  'cerebras',
  'cloudflare',
  'openrouter',
  'cohere',
  'fireworks',
  'perplexity',
  'xai',
  'sambanova',
  'hyperbolic',
  'novita',
  'digitalocean',
] as const;

export type Provider = typeof PROVIDERS[number];

export const ALIA_TIERS = [
  'lite',
  'v1',
  'v1-codea',
  'v1-cowork',
  'v1-browser',
  'v1-vision',
  'v1-audio',
  'v1-multimodal',
  'v1-pro',
  'v1-pro-max',
  'v1-voice',
  'v1-voice-pro',
] as const;

export type AliaTier = typeof ALIA_TIERS[number];
