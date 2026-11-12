export const EMAIL_ALERTS_MUTATION_KEY = ['email-alerts-update'] as const;
/**
 * Which of Alia's reads belong to the signed-in account and survive a restart, so the first frame
 * of a returning person is drawn from what they saw last (the cache is read at once and refreshed
 * behind it) instead of from a wait.
 *
 * Persisted, per account (`oxy_account_queries:<account id>`: another account can never hydrate
 * them, and a sign-out deletes them):
 *  - `conversations`: the list the sidebar draws (titles and times, never the messages).
 *  - `alia-agent-profile`: a gemie's profile as the SDK's chat draws it (name, look, greeting).
 *  - `skills`: the catalogue and the person's installed skills.
 *
 * NOT persisted, so they live in memory only: a conversation's messages, the thought panel's
 * reads, search results, billing (a subscription must never be shown from last week) and
 * anything signed. `useAccountLifecycle` drops all of Alia's queries when the account changes.
 */
export const ALIA_ACCOUNT_QUERIES = {
  roots: ['conversations', 'alia-agent-profile', 'skills'],
  mutationKeys: [EMAIL_ALERTS_MUTATION_KEY],
} as const;

export const queryKeys = {
  /** "Avísame de emails importantes" from Alia. */
  emailAlerts: ['email-alerts'] as const,
  skills: {
    catalogue: (filters?: Record<string, string | undefined>) =>
      ['skills', 'catalogue', filters ?? {}] as const,
    installed: ['skills', 'installed'] as const,
    detail: (idOrName: string) => ['skills', 'detail', idOrName] as const,
  },
  conversations: {
    all: ['conversations'] as const,
    detail: (id: string) => ['conversation', id] as const,
  },
  credits: {
    info: ['credits'] as const,
    price: ['credit-price'] as const,
    /** The last turn's spending warning, written by the stream and consumed when shown. */
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
  referrals: {
    info: ['referral-info'] as const,
    history: ['referral-history'] as const,
  },
  suggestions: {
    welcome: ['suggestions', 'welcome'] as const,
    search: (query: string) => ['suggestions', 'search', query] as const,
  },
} as const;
