import { describe, expect, it, vi } from 'vitest';

const world = vi.hoisted(() => ({
  requests: [] as { body: { messages: { role: string; content: string }[] } }[],
  Request: class {
    constructor(public prompt: string) {}
  },
  Response: class {
    constructor(
      public response: unknown[],
      public result: { metadata?: { oxyAccountId: string } },
    ) {}
  },
  Markdown: class {
    constructor(public value: { value: string }) {}
  },
}));
vi.mock('vscode', () => ({
  chat: undefined,
  workspace: {
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  ChatRequestTurn: world.Request,
  ChatResponseTurn: world.Response,
  ChatResponseMarkdownPart: world.Markdown,
}));
vi.mock('../logger', () => ({ log: { info() {}, warn() {}, error() {} } }));
vi.mock('../catalogue', () => ({ resolveModelId: async () => undefined }));
vi.mock('../aliaChat', () => ({
  AliaChatError: Error,
  streamAliaChat: async function* (request: (typeof world.requests)[number]) {
    world.requests.push(request);
    yield { type: 'content', text: 'answer' };
  },
}));
import { AliaChatParticipant } from '../chatParticipant';
import { AliaInlineCompletionProvider } from '../inlineCompletionProvider';

function fixture() {
  world.requests.length = 0;
  const listeners = new Set<() => void>();
  const auth = {
    getAccessToken: vi.fn(async () => 'current-token'),
    getOxyServices: () => ({ session: { userId: 'b' } }),
    createLinkedClient: vi.fn(() => ({ fetch: globalThis.fetch, dispose() {} })),
    onSessionContextChange: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const participant = new AliaChatParticipant({ subscriptions: [] } as never, auth as never);
  const handler = participant as unknown as {
    handleChatRequest(
      request: unknown,
      context: unknown,
      stream: unknown,
      token: unknown,
    ): Promise<{ metadata: unknown } | undefined>;
  };
  const token = {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose() {} }),
  };
  const stream = { progress: vi.fn(), markdown: vi.fn() };
  return { auth, listeners, handler, token, stream };
}

describe('native editor account context', () => {
  it('forwards only matching-account completed history and stamps the new response', async () => {
    const f = fixture();
    const history = [
      new world.Request('secret A'),
      new world.Response([new world.Markdown({ value: 'private answer A' })], {
        metadata: { oxyAccountId: 'a' },
      }),
      new world.Request('unattributed legacy'),
      new world.Response([], {}),
      new world.Request('previous B'),
      new world.Response([new world.Markdown({ value: 'answer B' })], {
        metadata: { oxyAccountId: 'b' },
      }),
    ];
    const result = await f.handler.handleChatRequest(
      { prompt: 'new B' },
      { history },
      f.stream,
      f.token,
    );
    expect(result).toEqual({ metadata: { success: true, oxyAccountId: 'b' } });
    expect(world.requests[0].body.messages.slice(1)).toEqual([
      { role: 'user', content: 'previous B' },
      { role: 'assistant', content: 'answer B' },
      { role: 'user', content: 'new B' },
    ]);
    expect(f.listeners.size).toBe(0);
  });

  it.each(['chat', 'inline'] as const)(
    'does not start %s for a replacement account after pending auth',
    async (kind) => {
      const f = fixture();
      let resolve!: (token: string) => void;
      f.auth.getAccessToken.mockImplementation(
        () =>
          new Promise<string>((done) => {
            resolve = done;
          }),
      );
      const pending =
        kind === 'chat'
          ? f.handler.handleChatRequest(
              { prompt: 'old prompt' },
              { history: [] },
              f.stream,
              f.token,
            )
          : new AliaInlineCompletionProvider(f.auth as never).provideInlineCompletionItems(
              {} as never,
              {} as never,
              {} as never,
              f.token,
            );
      for (const listener of [...f.listeners]) listener();
      resolve('replacement-account-token');
      await pending;
      expect(f.auth.createLinkedClient).not.toHaveBeenCalled();
      expect(world.requests).toEqual([]);
      expect(f.stream.markdown).not.toHaveBeenCalled();
      expect(f.listeners.size).toBe(0);
    },
  );
});
