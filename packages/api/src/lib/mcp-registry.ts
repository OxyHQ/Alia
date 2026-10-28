/**
 * How Alia authenticates to a hosted connector, beyond what the MCP SDK finds on
 * its own (RFC 9728 → RFC 8414 → Dynamic Client Registration → PKCE).
 *
 * `client` names the environment variables holding a client the vendor issued
 * to Alia, for vendors without Dynamic Client Registration or with an approved
 * client list. They are read by the API on every call, sent to integrations over
 * the internal transport and never stored with a connector. While they are
 * unset the connector is listed as not available and cannot be started.
 *
 * `scope` is the least set Alia requests, when the vendor documents granular
 * scopes; absent, the SDK requests what the server's challenge or metadata asks.
 */
export interface McpRegistryOAuth {
  scope?: string;
  client?: { envClientId: string; envClientSecret?: string };
  /**
   * The vendor's documented RFC 7009 endpoint when its metadata does not
   * advertise one, and how it takes the client's credentials.
   */
  revocation?: { url: string; clientAuth: 'basic' | 'body' };
  /**
   * An environment variable that must be `true` before the entry is offered:
   * for a vendor that admits only clients it has approved by name, set once the
   * vendor approved Alia.
   */
  enabledBy?: string;
}

export interface McpRegistryEntry {
  id: string;
  name: string;
  description: string;
  icon: string;
  transport: 'stdio' | 'sse' | 'streamable-http';
  command?: string;
  args?: string[];
  url?: string;
  requiredEnv: string[];
  requiresOAuth?: boolean;
  oauth?: McpRegistryOAuth;
  /** The vendor's own documentation of this server, for the owner and for support. */
  docsUrl?: string;
  featured?: boolean;
  category:
    | 'data'
    | 'development'
    | 'productivity'
    | 'search'
    | 'communication'
    | 'filesystem'
    | 'featured';
}

export const MCP_REGISTRY: McpRegistryEntry[] = [
  {
    id: 'github',
    name: 'GitHub',
    description: 'Manage repositories, issues, pull requests, and code',
    icon: 'github',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    requiredEnv: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    category: 'development',
  },
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Read and write files on your system',
    icon: 'folder',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
    requiredEnv: ['ALLOWED_DIRECTORIES'],
    category: 'filesystem',
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    description: 'Query and manage PostgreSQL databases',
    icon: 'database',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres'],
    requiredEnv: ['DATABASE_URL'],
    category: 'data',
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    description: 'Search the web using Brave Search API',
    icon: 'search',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    requiredEnv: ['BRAVE_API_KEY'],
    category: 'search',
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Read channels, send messages, and manage Slack workspace',
    icon: 'message-square',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    requiredEnv: ['SLACK_BOT_TOKEN'],
    category: 'communication',
  },
  {
    id: 'google-drive',
    name: 'Google Drive',
    description: 'Search and read files from Google Drive',
    icon: 'hard-drive',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-gdrive'],
    requiredEnv: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
    category: 'productivity',
  },
  {
    id: 'sqlite',
    name: 'SQLite',
    description: 'Query and manage SQLite databases',
    icon: 'database',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sqlite'],
    requiredEnv: ['SQLITE_DB_PATH'],
    category: 'data',
  },
  {
    id: 'memory',
    name: 'Memory',
    description: 'Persistent key-value memory for conversations',
    icon: 'brain',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    requiredEnv: [],
    category: 'productivity',
  },
  // Hosted remote OAuth connectors. These have no local command/args — they
  // connect to a provider-hosted MCP endpoint and authenticate interactively
  // via the OAuth flow (POST /mcp/:id/oauth/start → provider consent → complete).
  {
    id: 'notion',
    name: 'Notion',
    description: 'Search, read, and update your Notion pages and databases',
    icon: 'notion',
    transport: 'streamable-http',
    url: 'https://mcp.notion.com/mcp',
    requiredEnv: [],
    requiresOAuth: true,
    featured: true,
    category: 'productivity',
  },
  {
    id: 'github-remote',
    name: 'GitHub',
    description: 'Manage repositories, issues, and pull requests over the hosted GitHub MCP',
    icon: 'github',
    transport: 'streamable-http',
    url: 'https://api.githubcopilot.com/mcp/',
    requiredEnv: [],
    requiresOAuth: true,
    featured: true,
    category: 'development',
  },
  {
    id: 'linear',
    name: 'Linear',
    description: 'Track issues, projects, and cycles in your Linear workspace',
    icon: 'linear',
    transport: 'streamable-http',
    url: 'https://mcp.linear.app/mcp',
    requiredEnv: [],
    requiresOAuth: true,
    category: 'productivity',
  },
  {
    id: 'atlassian',
    name: 'Atlassian',
    description: 'Jira issues, Confluence pages and Loom videos on your Atlassian site',
    icon: 'atlassian',
    transport: 'streamable-http',
    url: 'https://mcp.atlassian.com/v2/mcp',
    requiredEnv: [],
    requiresOAuth: true,
    oauth: {
      scope: [
        'offline_access',
        'read:me',
        'read:account',
        'read:jira:agent-interface',
        'write:jira:agent-interface',
        'search:jira:agent-interface',
        'read:confluence:agent-interface',
        'write:confluence:agent-interface',
        'search:confluence:agent-interface',
        'read:loom:agent-interface',
        'write:loom:agent-interface',
        'search:rovo:agent-interface',
      ].join(' '),
    },
    docsUrl: 'https://developer.atlassian.com/cloud/rovo-mcp/guides/getting-started/',
    category: 'productivity',
  },
  {
    id: 'trello',
    name: 'Trello',
    description: 'Boards, lists and cards in your Trello workspace',
    icon: 'trello',
    transport: 'streamable-http',
    url: 'https://mcp.trello.com/v1',
    requiredEnv: [],
    requiresOAuth: true,
    oauth: {
      scope: [
        'offline_access',
        'read:me',
        'read:account',
        'read:board:trello',
        'write:board:trello',
        'read:organization:trello',
        'read:member:trello',
      ].join(' '),
    },
    docsUrl: 'https://trello.com/mcp',
    category: 'productivity',
  },
  {
    id: 'figma',
    name: 'Figma',
    description: 'Read designs, components and variables, and create FigJam diagrams',
    icon: 'figma',
    transport: 'streamable-http',
    url: 'https://mcp.figma.com/mcp',
    requiredEnv: [],
    requiresOAuth: true,
    oauth: { scope: 'mcp:connect', enabledBy: 'FIGMA_MCP_APPROVED' },
    docsUrl: 'https://developers.figma.com/docs/figma-mcp-server/remote-server-installation',
    category: 'productivity',
  },
  {
    id: 'canva',
    name: 'Canva',
    description: 'Search, create, edit and export your Canva designs',
    icon: 'canva',
    transport: 'streamable-http',
    url: 'https://api.canva.com/connect/v1/mcp',
    requiredEnv: [],
    requiresOAuth: true,
    oauth: {
      client: { envClientId: 'CANVA_MCP_CLIENT_ID', envClientSecret: 'CANVA_MCP_CLIENT_SECRET' },
      scope: [
        'profile:read',
        'design:meta:read',
        'design:content:read',
        'design:content:write',
        'folder:read',
        'folder:write',
        'comment:read',
        'comment:write',
        'asset:read',
        'asset:write',
        'brandkit:read',
        'brandtemplate:meta:read',
        'brandtemplate:content:read',
        'help:answers:read',
      ].join(' '),
      revocation: { url: 'https://api.canva.com/rest/v1/oauth/revoke', clientAuth: 'basic' },
    },
    docsUrl: 'https://www.canva.dev/docs/apps/mcp/access/',
    category: 'productivity',
  },
  {
    id: 'zoom',
    name: 'Zoom',
    description: 'Search meetings, read recordings, transcripts and notes, and schedule meetings',
    icon: 'zoom',
    transport: 'streamable-http',
    url: 'https://mcp.zoom.us/mcp/zoom/streamable',
    requiredEnv: [],
    requiresOAuth: true,
    oauth: {
      client: { envClientId: 'ZOOM_MCP_CLIENT_ID', envClientSecret: 'ZOOM_MCP_CLIENT_SECRET' },
      scope: [
        'meeting:read:search',
        'meeting:read:assets',
        'meeting:write:meeting',
        'meeting:update:meeting',
        'cloud_recording:read:content',
        'cloud_recording:read:list_user_recordings',
        'my_notes:read:content',
        'agentic_search:read:search',
        'agentic_search:read:ask',
        'docs:read:export',
        'docs:write:import',
        'hub:read:content',
        'hub:write:content',
      ].join(' '),
      revocation: { url: 'https://zoom.us/oauth/revoke', clientAuth: 'basic' },
    },
    docsUrl: 'https://developers.zoom.us/docs/mcp/servers/connect-to-zoom-mcp-servers/',
    category: 'communication',
  },
  {
    id: 'granola',
    name: 'Granola',
    description: 'Your meeting notes, transcripts and folders',
    icon: 'granola',
    transport: 'streamable-http',
    url: 'https://mcp.granola.ai/mcp',
    requiredEnv: [],
    requiresOAuth: true,
    oauth: { scope: 'mcp offline_access' },
    docsUrl: 'https://docs.granola.ai/help-center/sharing/integrations/mcp',
    category: 'productivity',
  },
  {
    id: 'amplitude',
    name: 'Amplitude',
    description: 'Charts, dashboards, experiments and product analytics (US data center)',
    icon: 'amplitude',
    transport: 'streamable-http',
    url: 'https://mcp.amplitude.com/mcp',
    requiredEnv: [],
    requiresOAuth: true,
    oauth: { scope: 'all:read all:write offline_access' },
    docsUrl: 'https://amplitude.com/docs/amplitude-ai/amplitude-mcp',
    category: 'data',
  },
  {
    id: 'amplitude-eu',
    name: 'Amplitude (EU)',
    description: 'Charts, dashboards, experiments and product analytics (EU data center)',
    icon: 'amplitude',
    transport: 'streamable-http',
    url: 'https://mcp.eu.amplitude.com/mcp',
    requiredEnv: [],
    requiresOAuth: true,
    oauth: { scope: 'all:read all:write offline_access' },
    docsUrl: 'https://amplitude.com/docs/amplitude-ai/amplitude-mcp',
    category: 'data',
  },
  {
    id: 'salesforce',
    name: 'Salesforce',
    description: 'Query, create and update records in your Salesforce org',
    icon: 'salesforce',
    transport: 'streamable-http',
    url: 'https://api.salesforce.com/platform/mcp/v1/platform/sobject-all',
    requiredEnv: [],
    requiresOAuth: true,
    oauth: {
      client: {
        envClientId: 'SALESFORCE_MCP_CLIENT_ID',
        envClientSecret: 'SALESFORCE_MCP_CLIENT_SECRET',
      },
      scope: 'mcp_api refresh_token',
    },
    docsUrl: 'https://github.com/forcedotcom/mcp-hosted/wiki',
    category: 'data',
  },
];
