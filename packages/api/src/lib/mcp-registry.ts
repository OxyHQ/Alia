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
  category: 'data' | 'development' | 'productivity' | 'search' | 'communication' | 'filesystem';
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
];
