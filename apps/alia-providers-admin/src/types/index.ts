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
  rateLimit: {
    rpm?: number;
    rph?: number;
    rpd?: number;
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

export interface PlanFeatureItem {
  label: string;
  description?: string;
}

export interface PlanFeatureGroup {
  category: string;
  items: PlanFeatureItem[];
}

export interface SubscriptionPlan {
  _id: string;
  planId: string;
  name: string;
  product: 'alia' | 'codea';
  creditsPerMonth: number;
  monthlyPrice: number;
  annualPrice: number;
  currency: string;
  subtitle: string;
  creditsLabel: string;
  isFeatured: boolean;
  isFree: boolean;
  sortOrder: number;
  features: PlanFeatureGroup[];
  modelIds: string[];
  isActive: boolean;
  stripeMonthlyPriceId?: string;
  stripeAnnualPriceId?: string;
  description?: string;
  notes?: string;
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
  'cerebras',
  'cloudflare',
  'openrouter',
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
] as const;

export type AliaTier = typeof ALIA_TIERS[number];
