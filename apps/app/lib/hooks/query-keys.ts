export const queryKeys = {
  conversations: {
    all: ['conversations'] as const,
    detail: (id: string) => ['conversation', id] as const,
  },
  credits: {
    info: ['credits'] as const,
    usage: (period?: string) => period ? ['credits-usage', period] as const : ['credits-usage'] as const,
    analytics: (period: string) => ['analytics', period] as const,
    price: ['credit-price'] as const,
    usageWarning: ['usage-warning'] as const,
  },
  billing: {
    packages: ['credit-packages'] as const,
    plans: (product?: string) => ['subscription-plans', product] as const,
    subscription: (product?: string) => ['subscription', product] as const,
    subscriptionPoll: (product?: string) => ['subscription-poll', product] as const,
    transactions: (limit?: number, offset?: number) => ['transactions', limit, offset] as const,
    entitlements: ['entitlements'] as const,
  },
  developer: {
    apps: ['developer-apps'] as const,
    app: (id: string) => ['developer-app', id] as const,
    keys: (appId: string) => ['developer-keys', appId] as const,
    usage: (appId: string, period: string) => ['developer-usage', appId, period] as const,
    keyUsage: (appId: string, keyId: string, period: string) => ['developer-key-usage', appId, keyId, period] as const,
    stats: ['developer-stats'] as const,
    modelsStats: ['models-stats'] as const,
  },
  organizations: {
    all: ['organizations'] as const,
    detail: (id: string) => ['organization', id] as const,
    members: (orgId: string) => ['organization-members', orgId] as const,
    agents: (orgId: string) => ['organization-agents', orgId] as const,
  },
  agentTeams: {
    all: ['agent-teams'] as const,
    detail: (id: string) => ['agent-team', id] as const,
  },
  referrals: {
    info: ['referral-info'] as const,
    history: ['referral-history'] as const,
  },
  suggestions: {
    welcome: ['suggestions', 'welcome'] as const,
    autocomplete: ['suggestions', 'autocomplete'] as const,
    search: (query: string) => ['suggestions', 'search', query] as const,
    me: ['suggestions', 'me'] as const,
  },
} as const;
