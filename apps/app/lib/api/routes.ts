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
    alia: '/alia/chat',
  },

  // Skills routes
  skills: {
    list: '/skills',
    get: (skillId: string) => `/skills/${skillId}`,
    prompt: (skillId: string) => `/skills/${skillId}/prompt`,
  },

  // Automations routes
  automations: {
    list: '/automations',
    create: '/automations',
    update: (id: string) => `/automations/${id}`,
    delete: (id: string) => `/automations/${id}`,
    run: (id: string) => `/automations/${id}/run`,
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
    follow: (id: string) => `/agents/${id}/follow`,
    hire: (id: string) => `/agents/${id}/hire`,
    generateAvatar: '/agents/avatar/generate',
  },

  // Health check
  health: '/health',

  // API v1 routes (OpenAI compatible)
  v1: {
    chatCompletions: '/v1/chat/completions',
    models: '/v1/models',
  },
} as const;
