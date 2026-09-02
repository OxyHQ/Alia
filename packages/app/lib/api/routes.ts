/**
 * Centralized API routes configuration
 * All API endpoints are defined here for easy maintenance
 */

export const API_ROUTES = {
  // Auth routes
  auth: {
    login: '/auth/login',
    register: '/auth/register',
    forgotPassword: '/auth/forgot-password',
    resetPassword: '/auth/reset-password',
  },

  // Conversation routes
  conversations: {
    list: '/conversations',
    create: '/conversations',
    get: (id: string) => `/conversations/${id}`,
    update: (id: string) => `/conversations/${id}`,
    delete: (id: string) => `/conversations/${id}`,
  },

  // Folder routes
  folders: {
    list: '/folders',
    create: '/folders',
    delete: (id: string) => `/folders/${id}`,
  },

  // Memory routes
  memory: {
    get: '/memory',
    add: '/memory/add',
    update: (id: string) => `/memory/${id}`,
    delete: (id: string) => `/memory/${id}`,
    preferences: '/memory/preferences',
    context: '/memory/context',
  },

  // Upload routes
  upload: {
    avatar: '/upload/avatar',
  },

  // Credits routes
  credits: {
    get: '/credits',
  },

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
    mine: '/skills/mine',
    get: (idOrName: string) => `/skills/${idOrName}`,
    versions: (idOrName: string) => `/skills/${idOrName}/versions`,
    file: (idOrName: string, path: string) => `/skills/${idOrName}/files/${path}`,
    create: '/skills',
    newVersion: (id: string) => `/skills/${id}/versions`,
    update: (id: string) => `/skills/${id}`,
    delete: (id: string) => `/skills/${id}`,
    generate: '/skills/generate',
    import: '/skills/import',
    upload: '/skills/upload',
    install: (id: string) => `/skills/${id}/install`,
  },

  // Trigger routes
  triggers: {
    list: '/triggers',
    create: '/triggers',
    update: (id: string) => `/triggers/${id}`,
    delete: (id: string) => `/triggers/${id}`,
    run: (id: string) => `/triggers/${id}/run`,
  },

  // Structured automations. Legacy trigger-backed rows identify their source,
  // so the client can call the owning control plane throughout the migration.
  automations: {
    list: '/automations',
    runs: '/automations/runs',
    update: (id: string) => `/automations/${id}`,
    stop: (id: string) => `/automations/${id}`,
    run: (id: string) => `/automations/${id}/run`,
    steps: (runId: string) => `/automations/runs/${runId}/steps`,
  },

  // Analytics routes
  analytics: {
    usage: '/analytics/usage',
    models: '/analytics/models',
    credits: '/analytics/credits',
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
    threadMessages: (username: string) => `/agents/thread/${encodeURIComponent(username)}/messages`,
    /**
     * Everything said in the thread that matches, across every conversation in
     * it. Each hit carries the cursor that opens the window containing it,
     * which is what makes a result reachable rather than just visible.
     */
    threadSearch: (username: string) => `/agents/thread/${encodeURIComponent(username)}/search`,
    create: '/agents',
    update: (id: string) => `/agents/${id}`,
    delete: (id: string) => `/agents/${id}`,
    hire: (id: string) => `/agents/${id}/hire`,
    activity: (id: string) => `/agents/${id}/activity`,
    activityGrid: (id: string) => `/agents/${id}/activity-grid`,
    sessions: (id: string) => `/agents/${id}/sessions`,
    status: (id: string) => `/agents/${id}/status`,
    cancelSession: (id: string, sid: string) => `/agents/${id}/sessions/${sid}/cancel`,
    reviews: (id: string) => `/agents/${id}/reviews`,
    reports: (id: string) => `/agents/${id}/reports`,
    routingLogs: (id: string) => `/agents/${id}/routing-logs`,
    routingStats: (id: string) => `/agents/${id}/routing-stats`,
    generate: '/agents/generate',
    /**
     * The MCP connectors, Oxy apps, integrations and agents this owner can
     * grant. The agent being EDITED is passed so it is left out of its own
     * list — an agent cannot be granted a conversation with itself.
     */
    capabilityConnectors: (excludeAgentId: string) =>
      `/agents/capability-connectors?agent=${encodeURIComponent(excludeAgentId)}`,
  },

  // Library routes
  library: {
    list: '/library',
    upload: '/library/upload',
    get: (id: string) => `/library/${id}`,
    delete: (id: string) => `/library/${id}`,
  },

  // Suggestions routes
  suggestions: {
    list: '/suggestions/list',
    welcome: '/suggestions/welcome',
    me: '/suggestions/me',
    create: '/suggestions/create',
    generate: '/suggestions/generate',
    search: '/suggestions/search',
    update: (id: string) => `/suggestions/${id}`,
    delete: (id: string) => `/suggestions/${id}`,
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

  // API v1 routes (OpenAI compatible)
  v1: {
    models: '/v1/models',
    audioSpeech: '/v1/audio/speech',
    audioGenerate: '/v1/audio/generate',
    imagesGenerations: '/v1/images/generations',
  },
} as const;
