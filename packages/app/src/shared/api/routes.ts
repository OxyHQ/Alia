/**
 * Centralized API routes configuration
 * All API endpoints are defined here for easy maintenance
 */

export const API_ROUTES = {
  // Auth routes
  auth: {
    forgotPassword: '/auth/forgot-password',
    resetPassword: '/auth/reset-password',
  },

  // Memory routes
  memory: {
    /** Every agent that remembers something about the caller (memory per actor). */
    agents: '/memory/agents',
  },

  /** "Avísame de emails importantes", per actor: Alia and each owned agent. */
  emailAlerts: '/notifications/email-alerts',

  /**
   * Chat routes.
   *
   * `/alia/chat` is the product runtime (ADR 0004) and is what every chat caller
   * in this app names. There is deliberately no `chatCompletions` entry beside
   * it: `/v1/chat/completions` is the bounded-window compatibility surface for
   * external callers, and a constant here pointing at it is how a product client
   * ends up on it again — epic #139 workstream 6.
   */
  chat: {
    alia: '/alia/chat',
  },

  // Skills routes. A skill is an Agent Skill (agentskills.io): a versioned
  // directory addressed by `name` in the app and by row id in write paths.
  skills: {
    catalogue: '/skills',
    installed: '/skills/installed',
    get: (idOrName: string) => `/skills/${idOrName}`,
    create: '/skills',
    newVersion: (id: string) => `/skills/${id}/versions`,
    update: (id: string) => `/skills/${id}`,
    delete: (id: string) => `/skills/${id}`,
    generate: '/skills/generate',
    import: '/skills/import',
    install: (id: string) => `/skills/${id}/install`,
  },

  // Structured automations are the only product control plane for proactive work.
  automations: {
    list: '/automations',
    runs: '/automations/runs',
    update: (id: string) => `/automations/${id}`,
    stop: (id: string) => `/automations/${id}`,
    run: (id: string) => `/automations/${id}/run`,
    /** Pause everything that would start on its own (ADR 0026). */
    pause: '/automations/pause',
  },

  // Agents routes
  agents: {
    list: '/agents',
    me: '/agents/me',
    get: (id: string) => `/agents/${id}`,
    /**
     * The permanent thread between the caller and one agent, resolved-or-created
     * from the agent's Oxy username. Answers 404 both for an agent that does not
     * exist and for one the caller cannot reach — a 403 would confirm it exists.
     */
    thread: (username: string) => `/agents/thread/${encodeURIComponent(username)}`,
    /**
     * A page of that thread, oldest-first, crossing the seams between the
     * conversations it is made of. `before=<cursor>` walks backwards; the
     * cursors come from the messages themselves.
     */
    /**
     * Everything said in the thread that matches, across every conversation in
     * it. Each hit carries the cursor that opens the window containing it,
     * which is what makes a result reachable rather than just visible.
     */
    create: '/agents',
    update: (id: string) => `/agents/${id}`,
    delete: (id: string) => `/agents/${id}`,
    threads: (id: string) => `/agents/${id}/threads`,
    threadById: (threadId: string) => `/agents/threads/${threadId}`,
    goals: (threadId: string) => `/agents/threads/${threadId}/goals`,
    memory: (id: string) => `/agents/${id}/memory`,
    /** What the agent subscribes to, and what is waiting in its inbox (ADR 0026). */
    subscriptions: (id: string) => `/agents/${id}/subscriptions`,
    subscription: (id: string, subscriptionId: string) =>
      `/agents/${id}/subscriptions/${subscriptionId}`,
    inbox: (id: string) => `/agents/${id}/inbox`,
    activityGrid: (id: string) => `/agents/${id}/activity-grid`,
    status: (id: string) => `/agents/${id}/status`,
    reviews: (id: string) => `/agents/${id}/reviews`,
    /** The agent's computer as the caller sees it — always the caller's own (`routes/agents/computer.ts`). */
    computer: (id: string) => `/agents/${id}/computer`,
    computerStart: (id: string) => `/agents/${id}/computer/start`,
    computerFiles: (id: string, path: string) =>
      `/agents/${id}/computer/files?path=${encodeURIComponent(path)}`,
    computerReceipts: (id: string) => `/agents/${id}/computer/receipts`,
    computerScreenshot: (id: string) => `/agents/${id}/computer/browser/screenshot`,
    computerBrowserOpen: (id: string) => `/agents/${id}/computer/browser/open`,
    computerBrowserNavigate: (id: string) => `/agents/${id}/computer/browser/navigate`,
    computerBrowserInput: (id: string) => `/agents/${id}/computer/browser/input`,
    computerBrowserControl: (id: string) => `/agents/${id}/computer/browser/control`,
  },

  // Library routes
  library: {
    list: '/library',
    upload: '/library/upload',
    delete: (id: string) => `/library/${id}`,
  },

  // Suggestions routes
  suggestions: {
    welcome: '/suggestions/welcome',
    search: '/suggestions/search',
    use: (id: string) => `/suggestions/${id}/use`,
  },

  // Audit routes
  audit: {
    export: '/audit/export',
    summary: '/audit/summary',
    threats: '/audit/threats',
  },

  // Health check
  health: '/health',

  /**
   * Show series and episodes.
   *
   * Under `/shows`, not `/v1/shows`. `/v1` is a frozen compatibility surface
   * that ADR 0004 closes to new routes, and shows are an Alia product resource
   * — so they moved beside `/conversations`, `/skills` and `/agents`, which is
   * where the workstream 1 inventory had already assigned them.
   */
  shows: {
    voices: '/shows/voices',
    preferences: '/shows/preferences',
    series: {
      list: '/shows/series',
      create: '/shows/series',
      get: (id: string) => `/shows/series/${id}`,
      update: (id: string) => `/shows/series/${id}`,
      delete: (id: string) => `/shows/series/${id}`,
    },
    episodes: {
      create: (seriesId: string) => `/shows/series/${seriesId}/episodes`,
      get: (id: string) => `/shows/episodes/${id}`,
      delete: (id: string) => `/shows/episodes/${id}`,
    },
  },
} as const;
