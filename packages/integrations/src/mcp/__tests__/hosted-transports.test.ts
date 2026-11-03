/**
 * The integrations host is shared by every account, so a connector it runs is
 * only ever a remote server it reaches over the network. It never starts a
 * process a person named, and it never connects to an address inside the
 * network it runs in.
 *
 * Nothing here executes a command or opens a connection: the SDK's transports
 * and client are replaced, so a regression shows up as a constructed transport
 * rather than as a process.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  stdio: vi.fn(),
  streamable: vi.fn(),
  sse: vi.fn(),
  connect: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: sdk.stdio,
  getDefaultEnvironment: () => ({}),
}));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: sdk.streamable,
}));
vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({ SSEClientTransport: sdk.sse }));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn(function Client() {
    return {
      connect: sdk.connect,
      listTools: async () => ({ tools: [] }),
      getServerCapabilities: () => ({}),
      close: async () => undefined,
    };
  }),
}));

import { connectorFetch } from '../connector-fetch';
import * as manager from '../manager';
import { mcpRouter } from '../routes';

type Handler = (req: unknown, res: unknown) => Promise<void> | void;

function startRoute(): Handler {
  const layer = (
    mcpRouter as unknown as {
      stack: Array<{
        route?: {
          path: string;
          methods: Record<string, boolean>;
          stack: Array<{ handle: Handler }>;
        };
      }>;
    }
  ).stack.find((l) => l.route?.path === '/servers/:id/start' && l.route.methods.post);
  const handle = layer?.route?.stack.at(-1)?.handle;
  if (!handle) throw new Error('POST /servers/:id/start is not mounted');
  return handle;
}

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
  };
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('a command-based connector', () => {
  it('is refused by the start route before anything is constructed', async () => {
    const res = mockRes();
    await startRoute()(
      {
        params: { id: 'srv-cmd' },
        body: {
          oxyUserId: 'user-a',
          transport: 'stdio',
          config: { command: 'node', args: ['--version'] },
        },
      },
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(sdk.stdio).not.toHaveBeenCalled();
  });

  it('is refused by the manager, so no other caller can start one either', async () => {
    await expect(
      manager.startServer(
        'srv-cmd',
        'user-a',
        // The type no longer admits it; a caller that forces it is still refused.
        'stdio' as unknown as 'streamable-http',
        { command: 'node', args: ['--version'] } as never,
      ),
    ).rejects.toThrow(/transport/);
    expect(sdk.stdio).not.toHaveBeenCalled();
    expect(manager.getSession('srv-cmd')).toBeUndefined();
  });
});

describe('a remote connector', () => {
  it('reaches its server through the address-checked fetch', async () => {
    await manager.startServer('srv-remote', 'user-a', 'streamable-http', {
      url: 'https://mcp.example.com/mcp',
    });

    expect(sdk.streamable).toHaveBeenCalledTimes(1);
    const [url, options] = sdk.streamable.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://mcp.example.com/mcp');
    expect(options.fetch).toBe(connectorFetch);
    await manager.stopServer('srv-remote');
  });

  it('reaches an SSE server through the same fetch', async () => {
    await manager.startServer('srv-sse', 'user-a', 'sse', { url: 'https://mcp.example.com/sse' });

    expect(sdk.sse.mock.calls[0]?.[1]?.fetch).toBe(connectorFetch);
    await manager.stopServer('srv-sse');
  });
});

describe('connectorFetch', () => {
  it.each([
    ['plain http', 'http://mcp.example.com/mcp'],
    ['loopback', 'https://127.0.0.1/mcp'],
    ['the cloud metadata service', 'https://169.254.169.254/latest/meta-data/'],
    ['a private range', 'https://10.0.0.5/mcp'],
    ['IPv6 loopback', 'https://[::1]/mcp'],
  ])('refuses %s without connecting', async (_label, url) => {
    await expect(connectorFetch(url)).rejects.toThrow();
  });
});
