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
    /**
     * PKCE (RFC 7636, S256) on top of the client secret. On unless a provider
     * refuses it to web clients.
     */
    pkce?: boolean;
    /** Provider-specific authorization parameters, such as Google's offline access. */
    authParams?: Record<string, string>;
    /** Send `scope` with a refresh, for a provider that documents it as required there. */
    refreshWithScope?: boolean;
  };
  /**
   * Where the person removes Alia's grant at the provider, for a provider with no
   * revocation endpoint: disconnecting deletes the tokens Alia holds, and this is
   * the rest of it.
   */
  revokeAt?: string;
  /** Optional profile fetching config to populate accountId/accountName/avatarUrl */
  profile?: IntegrationProfileConfig;
}

/**
 * Microsoft 365 is one Entra app registration (multi-tenant, a Web redirect URI
 * per service) with three connections, so each asks only for its own delegated
 * scopes and none needs an administrator's consent. Outlook signs in on the
 * `common` authority (work, school and personal accounts); Teams and SharePoint
 * exist only for work and school accounts, so they use `organizations`.
 */
const MICROSOFT_PROFILE: IntegrationProfileConfig = {
  url: 'https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName',
  mapResponse: (data: any) => ({
    accountId: data.id,
    accountName: data.mail || data.userPrincipalName || data.displayName,
  }),
};

const MICROSOFT_REVOKE_AT =
  'https://myapps.microsoft.com (work or school account) or https://account.live.com/consent/Manage (personal account)';

function microsoftOAuth(authority: 'common' | 'organizations', scopes: string[]) {
  return {
    authUrl: `https://login.microsoftonline.com/${authority}/oauth2/v2.0/authorize`,
    tokenUrl: `https://login.microsoftonline.com/${authority}/oauth2/v2.0/token`,
    scopes: ['offline_access', 'User.Read', ...scopes],
    envClientId: 'MICROSOFT_OAUTH_CLIENT_ID',
    envClientSecret: 'MICROSOFT_OAUTH_CLIENT_SECRET',
    authParams: { response_mode: 'query', prompt: 'select_account' },
    refreshWithScope: true,
  };
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
      scopes: [
        'https://www.googleapis.com/auth/calendar.readonly',
        'https://www.googleapis.com/auth/calendar.events',
      ],
      envClientId: 'GOOGLE_OAUTH_CLIENT_ID',
      envClientSecret: 'GOOGLE_OAUTH_CLIENT_SECRET',
      authParams: { access_type: 'offline' },
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
      authParams: { access_type: 'offline' },
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
    service: 'microsoft-outlook',
    name: 'Outlook',
    icon: 'mail',
    description: 'Read, search and send Outlook mail, and manage your Outlook calendar',
    category: 'communication',
    oauthConfig: microsoftOAuth('common', ['Mail.Read', 'Mail.Send', 'Calendars.ReadWrite']),
    profile: MICROSOFT_PROFILE,
    revokeAt: MICROSOFT_REVOKE_AT,
  },
  {
    service: 'microsoft-teams',
    name: 'Microsoft Teams',
    icon: 'message-square',
    description: 'Read and send Teams chat messages, and post in your teams’ channels',
    category: 'communication',
    oauthConfig: microsoftOAuth('organizations', [
      'Chat.Read',
      'ChatMessage.Send',
      'Team.ReadBasic.All',
      'Channel.ReadBasic.All',
      'ChannelMessage.Send',
    ]),
    profile: MICROSOFT_PROFILE,
    revokeAt: MICROSOFT_REVOKE_AT,
  },
  {
    service: 'microsoft-sharepoint',
    name: 'SharePoint and OneDrive',
    icon: 'hard-drive',
    description: 'Search and read files in SharePoint, OneDrive and Teams',
    category: 'storage',
    oauthConfig: microsoftOAuth('organizations', ['Files.Read.All', 'Sites.Read.All']),
    profile: MICROSOFT_PROFILE,
    revokeAt: MICROSOFT_REVOKE_AT,
  },
];
