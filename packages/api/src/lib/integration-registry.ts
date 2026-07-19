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
