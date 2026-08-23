import { beforeEach, describe, expect, it, vi } from 'vitest';

const listRunnableMcpServersForUser = vi.fn();
const getLocalTools = vi.fn();

vi.stubEnv('INTEGRATIONS_URL', 'https://integrations.example.test');
vi.stubEnv('INTEGRATIONS_SECRET', 'test-secret');

vi.mock('ai', () => ({ tool: (definition: unknown) => definition }));
vi.mock('../../../db/index.js', () => ({ getDb: () => ({ marker: 'db' }) }));
vi.mock('../../../db/integrations/mcpServerRepository.js', () => ({
  listRunnableMcpServersForUser: (...args: unknown[]) => listRunnableMcpServersForUser(...args),
}));
vi.mock('../../mcp-relay.js', () => ({
  getLocalTools: (...args: unknown[]) => getLocalTools(...args),
  callLocalTool: vi.fn(),
}));
vi.mock('../../logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));
vi.mock('../mcp-schema.js', () => ({ jsonSchemaToZod: () => ({}) }));

const { buildMcpTools } = await import('../mcp.js');

const hostedServer = {
  id: 'server-hosted',
  name: 'hosted-app',
  displayName: 'Hosted App',
  tools: [{ name: 'search', description: 'Search', inputSchema: {} }],
};

const localTool = {
  serverId: 'server-local',
  serverName: 'local-app',
  tool: { name: 'open', description: 'Open', inputSchema: {} },
};

beforeEach(() => {
  vi.clearAllMocks();
  listRunnableMcpServersForUser.mockResolvedValue([hostedServer]);
  getLocalTools.mockReturnValue([localTool]);
});

describe('per-turn MCP selection', () => {
  it('uses null as an explicit empty allow-list without reading connector state', async () => {
    expect(await buildMcpTools('user-none', null)).toEqual({});
    expect(listRunnableMcpServersForUser).not.toHaveBeenCalled();
    expect(getLocalTools).not.toHaveBeenCalled();
  });

  it('passes one hosted id to the repository and excludes local relay tools', async () => {
    const tools = await buildMcpTools('user-selected', 'server-hosted');

    expect(Object.keys(tools)).toEqual(['mcp_hosted_app__search']);
    expect(listRunnableMcpServersForUser).toHaveBeenCalledWith(
      { marker: 'db' },
      'user-selected',
      'server-hosted',
    );
    expect(getLocalTools).not.toHaveBeenCalled();
  });

  it('keeps omitted selection as the legacy hosted-plus-local path', async () => {
    const tools = await buildMcpTools('user-legacy');

    expect(Object.keys(tools)).toEqual([
      'mcp_hosted_app__search',
      'mcp_local_app__open',
    ]);
    expect(listRunnableMcpServersForUser).toHaveBeenCalledWith(
      { marker: 'db' },
      'user-legacy',
      undefined,
    );
    expect(getLocalTools).toHaveBeenCalledWith('user-legacy');
  });

  it('does not reuse an all-connectors cache entry for a selected turn', async () => {
    const all = await buildMcpTools('user-cache');
    const selected = await buildMcpTools('user-cache', 'server-hosted');

    expect(Object.keys(all)).toContain('mcp_local_app__open');
    expect(Object.keys(selected)).not.toContain('mcp_local_app__open');
    expect(listRunnableMcpServersForUser).toHaveBeenCalledTimes(2);
  });
});
