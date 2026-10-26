import { createServer } from 'node:http';
import { OxyServices } from '@oxy.so/core';
import { describe, expect, it, vi } from 'vitest';
import { createChatTurnControl } from '../../src/runtime/chat-turn-control';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function token(userId: string) {
  return `e30.${Buffer.from(JSON.stringify({ userId, operatorId: 'operator', sessionId: `session-${userId}`, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.sig`;
}

describe('explicit Stop with the shared transport', () => {
  it('knows its id before metadata, waits for the surface proof and one remote acknowledgement, then detaches', async () => {
    const arrived = deferred<void>();
    const acknowledge = deferred<void>();
    const requests: { path?: string; body: unknown; surface?: string }[] = [];
    const server = createServer(async (req, res) => {
      const parts: Buffer[] = [];
      for await (const part of req) parts.push(Buffer.from(part));
      requests.push({
        path: req.url,
        body: JSON.parse(Buffer.concat(parts).toString()),
        surface: String(req.headers['x-oxy-app-assertion']),
      });
      arrived.resolve();
      await acknowledge.promise;
      res.setHeader('content-type', 'application/json');
      res.end('{"state":"cancelled"}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    const baseURL = `http://127.0.0.1:${address.port}`;
    const oxy = new OxyServices({ baseURL });
    oxy.session.setAccessToken(token('A'));
    const headers = deferred<Record<string, string>>();
    const controller = new AbortController();
    const turn = createChatTurnControl(
      oxy.createLinkedClient({ baseURL }),
      headers.promise,
      'owned-conversation',
      controller,
    );
    try {
      expect(turn.id).toMatch(/^[a-f0-9-]{36}$/);
      const stopped = turn.stop();
      expect(turn.stop()).toBe(stopped);
      expect(requests).toHaveLength(0);
      headers.resolve({ 'X-Oxy-App-Assertion': 'synthetic-surface-proof' });
      await arrived.promise;
      expect(controller.signal.aborted).toBe(false);
      acknowledge.resolve();
      await stopped;
      expect(controller.signal.aborted).toBe(true);
      expect(requests).toEqual([
        {
          path: `/v1/chat/turns/${turn.id}/cancel`,
          body: { conversationId: 'owned-conversation' },
          surface: 'synthetic-surface-proof',
        },
      ]);
      await turn.stop();
      expect(requests).toHaveLength(1);
    } finally {
      acknowledge.resolve();
      await turn.finish();
      oxy.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('does not deliver an old turn Stop under a newly selected account while its surface proof is pending', async () => {
    let deliveries = 0;
    const server = createServer((_req, res) => {
      deliveries++;
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    const baseURL = `http://127.0.0.1:${address.port}`;
    const oxy = new OxyServices({ baseURL });
    oxy.session.setAccessToken(token('A'));
    const headers = deferred<Record<string, string>>();
    const controller = new AbortController();
    const turn = createChatTurnControl(
      oxy.createLinkedClient({ baseURL }),
      headers.promise,
      undefined,
      controller,
    );
    try {
      const stopped = turn.stop();
      const rejection = expect(stopped).rejects.toThrow('account changed');
      oxy.session.setAccessToken(token('B'));
      headers.resolve({});
      await rejection;
      expect(controller.signal.aborted).toBe(true);
      expect(deliveries).toBe(0);
    } finally {
      await turn.finish();
      oxy.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

it('bounds Stop and finish even when surface preparation never resolves, with no late dispatch', async () => {
  const timeout = new AbortController();
  const timeoutFactory = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
  const oxy = new OxyServices({ baseURL: 'http://127.0.0.1:9' });
  oxy.session.setAccessToken(token('A'));
  const linked = oxy.createLinkedClient({ baseURL: 'http://127.0.0.1:9' });
  const request = vi.spyOn(linked.client, 'requestAuthenticatedResponse');
  const headers = deferred<Record<string, string>>();
  const turn = createChatTurnControl(linked, headers.promise, undefined, new AbortController());
  try {
    const stopped = turn.stop();
    const rejected = expect(stopped).rejects.toThrow('deadline');
    expect(timeoutFactory).toHaveBeenCalledWith(10_000);
    timeout.abort(new Error('deadline'));
    await rejected;
    await turn.finish();
    headers.resolve({});
    await Promise.resolve();
    expect(request).not.toHaveBeenCalled();
  } finally {
    await turn.finish();
    oxy.dispose();
    timeoutFactory.mockRestore();
  }
});

it('observes an immediately rejected proof before a host presses Stop', async () => {
  const oxy = new OxyServices({ baseURL: 'http://127.0.0.1:9' });
  oxy.session.setAccessToken(token('A'));
  const linked = oxy.createLinkedClient({ baseURL: 'http://127.0.0.1:9' });
  const request = vi.spyOn(linked.client, 'requestAuthenticatedResponse');
  const turn = createChatTurnControl(
    linked,
    Promise.reject(new Error('surface unavailable')),
    undefined,
    new AbortController(),
  );
  try {
    // Cross an event-loop boundary: an unobserved rejection would fail this suite.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(turn.stop()).rejects.toThrow('surface unavailable');
    expect(request).not.toHaveBeenCalled();
  } finally {
    await turn.finish();
    oxy.dispose();
  }
});
