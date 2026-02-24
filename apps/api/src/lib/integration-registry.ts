export interface IntegrationProfileConfig {
  /** URL to fetch user profile after OAuth. If method is 'graphql', this is the GraphQL endpoint. */
  url: string;
  /** Extra headers to include in the profile request */
  headers?: Record<string, string>;
  /** HTTP method for the profile request (default: 'GET') */
  method?: 'GET' | 'POST';
  /** GraphQL query body (when method is 'POST') */
  body?: string;
  /** Mapping from response fields to Integration model fields */
  mapResponse: (data: any) => { accountId?: string; accountName?: string; avatarUrl?: string };
}

export interface IntegrationRegistryEntry {
  service: string;
  name: string;
  icon: string;
  description: string;
  category: 'development' | 'productivity' | 'communication' | 'calendar' | 'storage';
  oauthConfig: {
    authUrl: string;
    tokenUrl: string;
    scopes: string[];
    envClientId: string;
    envClientSecret: string;
    /** How to send credentials during token exchange. 'body' = POST body (default), 'basic' = Authorization header */
    authMethod?: 'body' | 'basic';
  };
  /** Optional profile fetching config to populate accountId/accountName/avatarUrl */
  profile?: IntegrationProfileConfig;
}

export const INTEGRATION_REGISTRY: IntegrationRegistryEntry[] = [
  {
    service: 'github',
    name: 'GitHub',
    icon: 'github',
    description: 'Access repositories, issues, and pull requests',
    category: 'development',
    oauthConfig: {
      authUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      scopes: ['repo', 'user'],
      envClientId: 'GITHUB_OAUTH_CLIENT_ID',
      envClientSecret: 'GITHUB_OAUTH_CLIENT_SECRET',
    },
    profile: {
      url: 'https://api.github.com/user',
      headers: { Accept: 'application/vnd.github.v3+json' },
      mapResponse: (data: any) => ({
        accountId: String(data.id),
        accountName: data.login,
        avatarUrl: data.avatar_url,
      }),
    },
  },
  {
    service: 'notion',
    name: 'Notion',
    icon: 'book-open',
    description: 'Search pages, create content, and manage workspaces',
    category: 'productivity',
    oauthConfig: {
      authUrl: 'https://api.notion.com/v1/oauth/authorize',
      tokenUrl: 'https://api.notion.com/v1/oauth/token',
      scopes: [],
      envClientId: 'NOTION_OAUTH_CLIENT_ID',
      envClientSecret: 'NOTION_OAUTH_CLIENT_SECRET',
      authMethod: 'basic',
    },
    profile: {
      url: 'https://api.notion.com/v1/users/me',
      headers: { 'Notion-Version': '2022-06-28' },
      mapResponse: (data: any) => ({
        accountId: data.id,
        accountName: data.name || data.person?.email,
        avatarUrl: data.avatar_url,
      }),
    },
  },
  {
    service: 'google-calendar',
    name: 'Google Calendar',
    icon: 'calendar',
    description: 'View events, create appointments, and manage calendars',
    category: 'calendar',
    oauthConfig: {
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: ['https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar.events'],
      envClientId: 'GOOGLE_OAUTH_CLIENT_ID',
      envClientSecret: 'GOOGLE_OAUTH_CLIENT_SECRET',
    },
    profile: {
      url: 'https://www.googleapis.com/oauth2/v2/userinfo',
      mapResponse: (data: any) => ({
        accountId: data.id,
        accountName: data.email,
        avatarUrl: data.picture,
      }),
    },
  },
  {
    service: 'linear',
    name: 'Linear',
    icon: 'layout-list',
    description: 'Manage issues, projects, and workflows',
    category: 'development',
    oauthConfig: {
      authUrl: 'https://linear.app/oauth/authorize',
      tokenUrl: 'https://api.linear.app/oauth/token',
      scopes: ['read', 'write'],
      envClientId: 'LINEAR_OAUTH_CLIENT_ID',
      envClientSecret: 'LINEAR_OAUTH_CLIENT_SECRET',
    },
    profile: {
      url: 'https://api.linear.app/graphql',
      method: 'POST',
      body: JSON.stringify({ query: '{ viewer { id name email } }' }),
      mapResponse: (data: any) => {
        const viewer = data.data?.viewer;
        return {
          accountId: viewer?.id,
          accountName: viewer?.name || viewer?.email,
        };
      },
    },
  },
  {
    service: 'google-drive',
    name: 'Google Drive',
    icon: 'hard-drive',
    description: 'Search, read, and manage files in Google Drive',
    category: 'storage',
    oauthConfig: {
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
      envClientId: 'GOOGLE_OAUTH_CLIENT_ID',
      envClientSecret: 'GOOGLE_OAUTH_CLIENT_SECRET',
    },
    profile: {
      url: 'https://www.googleapis.com/oauth2/v2/userinfo',
      mapResponse: (data: any) => ({
        accountId: data.id,
        accountName: data.email,
        avatarUrl: data.picture,
      }),
    },
  },
];
