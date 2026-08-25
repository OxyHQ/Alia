export const queryKeys = {
  catalogue: {
    // Keyed by caller: the entitlement annotations describe whoever asked, so a
    // signed-out catalogue must not survive a sign-in.
    list: (userId: string | null) => ['catalogue', userId] as const,
    /**
     * Not keyed by user, unlike `list`. A product mode is the same for
     * everybody — what a caller may USE is entitlement, annotated on the
     * catalogue entries a mode routes through rather than on the mode — so
     * keying this by user would refetch six unchanging rows on every sign-in.
     */
    modes: () => ['catalogue', 'modes'] as const,
  },
  agents: {
    /**
     * Keyed by the USERNAME the URL carries, not by the agent id, because the
     * id is part of what the query answers — `/a/pepe` is resolvable before
     * anything is known about who Pepe is.
     */
    thread: (username: string) => ['agent-thread', username] as const,
  },
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
    invites: (orgId: string) => ['organization-invites', orgId] as const,
  },
  referrals: {
    info: ['referral-info'] as const,
    history: ['referral-history'] as const,
  },
  suggestions: {
    welcome: ['suggestions', 'welcome'] as const,
    search: (query: string) => ['suggestions', 'search', query] as const,
    me: ['suggestions', 'me'] as const,
  },
} as const;
