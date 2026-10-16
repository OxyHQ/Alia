import { describe, expect, it, vi } from 'vitest';

vi.mock('@oxy.so/services/ui/client', () => ({
  useOxy: () => ({}),
}));

import { createAliaApi, type LinkableOxy } from '../../src/runtime/api';

/**
 * Every REST request carries the host's app assertion (ADR 0021): opening an agent's profile, its
 * features, a conversation with it — each is a reach Alia decides from the app the person is in.
 */

function recordingOxy() {
  const sent: Array<{ method: string; url: string; headers?: Record<string, string> }> = [];
  const oxy: LinkableOxy = {
    createLinkedClient: () => ({
      client: {
        requestAuthenticatedResponse: async (config) => {
          sent.push({ method: config.method, url: config.url, headers: config.headers });
          return new Response('{}', { status: 200 });
        },
      },
      dispose: () => {},
    }),
  };
  return { oxy, sent };
}

describe('the REST API sends X-Oxy-App-Assertion', () => {
  it('on a read and on a write, beside the JSON content type', async () => {
    const { oxy, sent } = recordingOxy();
    const api = createAliaApi(oxy, 'https://api.alia.test', async () => ({
      'X-Oxy-App-Assertion': 'clarity-assertion',
    }));

    await api.get('/v1/agents/agent-1/profile');
    await api.post('/v1/conversations/new', { agentId: 'agent-1' });

    expect(sent[0]?.headers).toEqual({ 'X-Oxy-App-Assertion': 'clarity-assertion' });
    expect(sent[1]?.headers).toEqual({
      'X-Oxy-App-Assertion': 'clarity-assertion',
      'Content-Type': 'application/json',
    });
  });

  it('sends nothing extra when the host has no assertion', async () => {
    const { oxy, sent } = recordingOxy();
    const api = createAliaApi(oxy, 'https://api.alia.test');

    await api.get('/v1/agents/agent-1/profile');
    await api.delete('/v1/conversations/c-1');
    await api.patch('/v1/conversations/c-1', { title: 'x' });

    expect(sent[0]?.headers).toBeUndefined();
    expect(sent[1]?.headers).toBeUndefined();
    expect(sent[2]?.headers).toEqual({ 'Content-Type': 'application/json' });
  });
});
