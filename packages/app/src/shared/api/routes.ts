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

  /** "Avísame de emails importantes" from Alia, about the person's Inbox. */
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
   * — so they moved beside `/conversations` and `/skills`, which is
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
