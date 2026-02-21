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
  };
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
  },
];
