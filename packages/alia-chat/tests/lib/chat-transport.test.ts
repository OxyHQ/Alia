import { afterEach, describe, expect, it, vi } from 'vitest';
import { OxyServices } from '@oxyhq/core';
import { streamAliaChat } from '../../src/lib/chat-transport';

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function createJwt(expiresAt: number): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ userId: 'user-1', exp: expiresAt })}.signature`;
}

function successfulStream(): Response {
  const body = [
    'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"profile:v1","choices":[{"index":0,"delta":{"content":"Hola"},"finish_reason":null}]}\n\n',
    'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"profile:v1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ].join('');
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

function headersOf(init: RequestInit | undefined): Headers {
  return new Headers(init?.headers);
}

describe('streamAliaChat authentication boundary', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('refreshes an expiring session before the streaming fetch', async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return successfulStream();
    });
    const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });
    const expired = createJwt(Math.floor(Date.now() / 1000) - 30);
    const refreshed = createJwt(Math.floor(Date.now() / 1000) + 3600);
    oxy.setTokens(expired);
    const refresh = vi.fn(async () => refreshed);
    oxy.getClient().setAuthRefreshHandler(refresh);
    const linked = oxy.createLinkedClient({ baseURL: 'https://api.alia.onl' });

    await streamAliaChat(
      linked.client,
      { url: '/v1/chat/completions', model: 'profile:v1', messages: [{ role: 'user', content: 'Hola' }] },
      new AbortController().signal,
      () => undefined,
    );

    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledWith('preflight');
    expect(calls).toHaveLength(1);
    expect(headersOf(calls[0]?.init).get('authorization')).toBe(`Bearer ${refreshed}`);
    linked.dispose();
  });

  it('replays exactly once after a 401 and keeps auth out of caller headers', async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return calls.length === 1 ? new Response('expired', { status: 401 }) : successfulStream();
    });
    const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });
    const oldToken = createJwt(Math.floor(Date.now() / 1000) + 3600);
    const refreshed = createJwt(Math.floor(Date.now() / 1000) + 7200);
    oxy.setTokens(oldToken);
    const refresh = vi.fn(async () => refreshed);
    oxy.getClient().setAuthRefreshHandler(refresh);
    const linked = oxy.createLinkedClient({ baseURL: 'https://api.alia.onl' });
    const controller = new AbortController();

    await streamAliaChat(
      linked.client,
      { url: '/v1/chat/completions', model: 'profile:v1', messages: [{ role: 'user', content: 'Hola' }] },
      controller.signal,
      () => undefined,
    );

    expect(calls).toHaveLength(2);
    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledWith('response-401');
    expect(headersOf(calls[0]?.init).get('authorization')).toBe(`Bearer ${oldToken}`);
    expect(headersOf(calls[1]?.init).get('authorization')).toBe(`Bearer ${refreshed}`);
    expect(headersOf(calls[0]?.init).get('accept')).toBe('text/event-stream');
    expect(calls[0]?.init?.signal).toBe(controller.signal);
    expect(calls[1]?.init?.signal).toBe(controller.signal);
    expect(calls[0]?.init?.body).toBe(calls[1]?.init?.body);
    linked.dispose();
  });

  it('does not perform a second retry when the refreshed request is also unauthorized', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return new Response('unauthorized', { status: 401 });
    });
    const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });
    oxy.setTokens(createJwt(Math.floor(Date.now() / 1000) + 3600));
    const refresh = vi.fn(async () => createJwt(Math.floor(Date.now() / 1000) + 7200));
    oxy.getClient().setAuthRefreshHandler(refresh);
    const linked = oxy.createLinkedClient({ baseURL: 'https://api.alia.onl' });

    await expect(
      streamAliaChat(
        linked.client,
        { url: '/v1/chat/completions', model: 'profile:v1', messages: [{ role: 'user', content: 'Hola' }] },
        new AbortController().signal,
        () => undefined,
      ),
    ).rejects.toThrow('status 401');

    expect(calls).toBe(2);
    expect(refresh).toHaveBeenCalledOnce();
    linked.dispose();
  });
});
