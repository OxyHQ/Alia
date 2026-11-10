export const EMAIL_ALERTS_MUTATION_KEY = ['email-alerts-update'] as const;
/**
 * Which of Alia's reads belong to the signed-in account and survive a restart, so the first frame
 * of a returning person is drawn from what they saw last (the cache is read at once and refreshed
 * behind it) instead of from a wait.
 *
 * Persisted, per account (`oxy_account_queries:<account id>`: another account can never hydrate
 * them, and a sign-out deletes them):
 *  - `agents`: the person's agents, an agent's page and the catalogue they browsed.
 *  - `agent-thread`: an agent's thread (its identity and the conversation it is on), which is what
 *    opens `/@handle` at once.
 *  - `spaces`: the folders that group the person's agents, which the sidebar draws.
 *  - `conversations`: the list the sidebar draws (titles and times, never the messages).
 *  - `alia-agent-profile`: the lead of an agent's chat (name, look, greeting, starters).
 *  - `skills`: the catalogue and the person's installed skills.
 *
 * NOT persisted, so they live in memory only: a conversation's messages, the thought panel's
 * reads, search results, billing (a subscription must never be shown from last week) and
 * anything signed. `useAccountLifecycle` drops all of Alia's queries when the account changes.
 */
export const ALIA_ACCOUNT_QUERIES = {
  roots: ['agents', 'agent-thread', 'spaces', 'conversations', 'alia-agent-profile', 'skills'],
  mutationKeys: [EMAIL_ALERTS_MUTATION_KEY],
} as const;

export const queryKeys = {
  /** "Avísame de emails importantes" for Alia and each owned agent. */
  emailAlerts: ['email-alerts'] as const,
  skills: {
    catalogue: (filters?: Record<string, string | undefined>) =>
      ['skills', 'catalogue', filters ?? {}] as const,
    installed: ['skills', 'installed'] as const,
    detail: (idOrName: string) => ['skills', 'detail', idOrName] as const,
  },
  agents: {
    /** The agents this person owns, which the sidebar lists. */
    mine: ['agents', 'mine'] as const,
    /**
     * The CATALOGUE: everything published, by anybody, narrowed by whatever the
     * screen is filtering on. A different question from `mine` — see the
     * docblock on `useMyAgents` — so a different key, and the filters are part
     * of it because two filters are two answers.
     */
    catalogue: (params?: object) => ['agents', 'catalogue', params ?? {}] as const,
    /** One agent, whole, as the detail and edit screens read it. */
    detail: (id: string) => ['agents', 'detail', id] as const,
    /** One agent's reviews, and the caller's own among them. */
    reviews: (id: string) => ['agents', 'reviews', id] as const,
    /** What one agent remembers about the caller: its files, and one file's content. */
    memory: (id: string) => ['agents', 'memory', id] as const,
    memoryFile: (id: string, path: string) => ['agents', 'memory', id, path] as const,
    /** What one agent subscribes to, and what waits in its inbox (ADR 0026). */
    subscriptions: (id: string) => ['agents', 'subscriptions', id] as const,
    inbox: (id: string) => ['agents', 'inbox', id] as const,
    /** The agents that remember something about the caller. */
    /**
     * Keyed by the USERNAME the URL carries, not by the agent id, because the
     * id is part of what the query answers — `/a/pepe` is resolvable before
     * anything is known about who Pepe is.
     */
    thread: (username: string) => ['agent-thread', username] as const,
    /**
     * The thread's history, kept apart from the thread itself: re-reading which
     * conversation is active is cheap and happens whenever a new stretch
     * starts, while the pages behind it are immutable and expensive to refetch.
     */
    threadMessages: (username: string) => ['agent-thread-messages', username] as const,
  },
  automations: {
    overview: ['automations', 'overview'] as const,
    pause: ['automations', 'pause'] as const,
  },
  /** The person's spaces (ADR 0028), with their members and rooms. */
  spaces: {
    all: ['spaces'] as const,
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
