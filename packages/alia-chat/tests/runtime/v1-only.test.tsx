import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The SDK talks to Alia's product API, `/v1`, and to nothing else.
 *
 * It is embedded by every Oxy app on that app's own web origin, and only `/v1` answers a browser
 * from any origin (bearer, no cookies). A route outside it would work in Alia's own apps and fail
 * the preflight in every other one. So this drives every request the runtime can make — each
 * conversation call and a streamed turn — through a recording Oxy client, and fails on any URL
 * that does not land under `/v1/`. A second test reads the source for a path literal that names
 * a cookie-era route, so a new call cannot slip past the first by not being driven.
 */

const wire = vi.hoisted(() => ({ urls: [] as string[] }));

vi.mock('@oxy.so/services/ui/client', async () => ({
  ...(await import('../support/app-assertion-host')).hostWithoutAppAssertion,
  useOxy: () => ({
    isAuthenticated: true,
    user: { id: 'u1' },
    oxyServices: {
      createLinkedClient: ({ baseURL }: { baseURL: string }) => ({
        client: {
          requestAuthenticatedResponse: async (config: { url: string; method: string }) => {
            wire.urls.push(new URL(config.url, baseURL).pathname);
            // A conversation for the reads, a stream for the turn; both well-formed.
            if (config.url.endsWith('/chat/completions')) {
              const body = new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(
                    new TextEncoder().encode(
                      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'hi' } }] })}\n\ndata: [DONE]\n\n`,
                    ),
                  );
                  controller.close();
                },
              });
              return { ok: true, status: 200, body };
            }
            return new Response(
              JSON.stringify({
                id: 'c1',
                title: 'T',
                createdAt: '2026-01-01T00:00:00Z',
                updatedAt: '2026-01-01T00:00:00Z',
                conversations: [],
                nextCursor: null,
                hasMore: false,
                messages: [],
              }),
              { status: 200 },
            );
          },
        },
        dispose: () => {},
      }),
    },
  }),
}));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: { error: vi.fn() } }));

import { AliaRuntimeProvider } from '../../src/runtime/config';
import {
  useClearConversation,
  useConversation,
  useConversations,
  useCreateConversation,
  useDeleteConversation,
  useRenameConversation,
} from '../../src/runtime/conversations';
import { useConversationStream } from '../../src/runtime/use-conversation-stream';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  wire.urls = [];
});
afterEach(() => {
  renderer?.unmount();
  renderer = undefined;
});

describe('every request the runtime makes', () => {
  it('lands under /v1, on the origin the host configured', async () => {
    let api: {
      create: ReturnType<typeof useCreateConversation>;
      rename: ReturnType<typeof useRenameConversation>;
      remove: ReturnType<typeof useDeleteConversation>;
      clear: ReturnType<typeof useClearConversation>;
      stream: ReturnType<typeof useConversationStream>;
    };
    function Probe() {
      useConversations();
      useConversation('c1');
      api = {
        create: useCreateConversation(),
        rename: useRenameConversation(),
        remove: useDeleteConversation(),
        clear: useClearConversation(),
        stream: useConversationStream({ conversationId: 'c1' }),
      };
      return null;
    }
    await act(async () => {
      renderer = create(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <AliaRuntimeProvider apiUrl="https://api.example">
            <Probe />
          </AliaRuntimeProvider>
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await api.create.mutateAsync({});
      await api.rename.mutateAsync({ id: 'c1', title: 'Renamed' });
      await api.clear.mutateAsync('c1');
      await api.remove.mutateAsync('c1');
      await api.stream.append({ role: 'user', content: 'hello' });
    });

    // The list, one conversation, create, rename (read + save), clear, delete and the turn.
    expect(wire.urls.length).toBeGreaterThanOrEqual(8);
    expect(wire.urls.filter((path) => !path.startsWith('/v1/'))).toEqual([]);
    expect(wire.urls).toContain('/v1/chat/completions');
    expect(wire.urls).toContain('/v1/conversations');
    expect(wire.urls).toContain('/v1/conversations/c1/messages');
  });
});

describe('the source', () => {
  const SRC = join(__dirname, '..', '..', 'src');
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
    });

  it('names no cookie-era route in a path literal (those answer Alia’s own origins only)', () => {
    const forbidden = /['"`]\/(?:alia\/chat|conversations|catalogue|credits|memory|suggestions)\b/;
    const offenders = files(SRC).filter((file) => {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      return forbidden.test(code);
    });
    expect(offenders).toEqual([]);
    expect(files(SRC).length).toBeGreaterThan(50);
  });
});
