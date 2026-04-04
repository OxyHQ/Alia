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

  // Chat routes
  chat: {
    clarity: '/clarity/search',
  },

  // Skills routes
  skills: {
    list: '/skills',
    me: '/skills/me',
    get: (skillId: string) => `/skills/${skillId}`,
    prompt: (skillId: string) => `/skills/${skillId}/prompt`,
    create: '/skills',
    update: (skillId: string) => `/skills/${skillId}`,
    delete: (skillId: string) => `/skills/${skillId}`,
    generate: '/skills/generate',
  },

  // Trigger routes
  triggers: {
    list: '/triggers',
    create: '/triggers',
    update: (id: string) => `/triggers/${id}`,
    delete: (id: string) => `/triggers/${id}`,
    run: (id: string) => `/triggers/${id}/run`,
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
    generateAvatar: '/agents/avatar/generate',
    generate: '/agents/generate',
    teams: {
      list: '/agents/teams',
      get: (id: string) => `/agents/teams/${id}`,
      create: '/agents/teams',
      update: (id: string) => `/agents/teams/${id}`,
      delete: (id: string) => `/agents/teams/${id}`,
      addAgent: (id: string) => `/agents/teams/${id}/agents`,
      removeAgent: (id: string, agentId: string) => `/agents/teams/${id}/agents/${agentId}`,
    },
  },

  // Accessories routes
  accessories: {
    list: '/accessories',
    me: '/accessories/me',
    purchase: (id: string) => `/accessories/${id}/purchase`,
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

  // API v1 routes (OpenAI compatible)
  v1: {
    chatCompletions: '/v1/chat/completions',
    models: '/v1/models',
    audioSpeech: '/v1/audio/speech',
    audioGenerate: '/v1/audio/generate',
    imagesGenerations: '/v1/images/generations',
    shows: {
      generate: '/v1/shows/generate',
      list: '/v1/shows',
      get: (id: string) => `/v1/shows/${id}`,
      delete: (id: string) => `/v1/shows/${id}`,
      voices: '/v1/shows/voices',
    },
  },
} as const;
