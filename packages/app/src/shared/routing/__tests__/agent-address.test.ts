import { describe, expect, it } from 'vitest';
import {
  agentChatRoute,
  agentDetailsRoute,
  agentEditRoute,
  agentHandle,
  agentSharePath,
  agentThreadHref,
} from '@/shared/routing/agent-address';

/**
 * An agent is addressed by its handle, as a STRING with the `@` written out: the object form
 * `{ pathname: '/(app)/[username]', params: { username: '@pepe' } }` is encoded by Expo Router and
 * put `/%40pepe` in the address bar.
 */

const pepe = { _id: 'a1', name: 'Pepe', handle: 'pepe' };
const nameless = { _id: 'a2', name: null, handle: null };

describe('an agent’s addresses', () => {
  it('are strings with the @ in them: the thread, the page and the editor', () => {
    expect(agentChatRoute(pepe)).toBe('/@pepe');
    expect(agentDetailsRoute(pepe)).toBe('/@pepe/details');
    expect(agentEditRoute(pepe)).toBe('/@pepe/edit');
    for (const address of [agentChatRoute(pepe), agentDetailsRoute(pepe), agentEditRoute(pepe)]) {
      expect(typeof address).toBe('string');
      expect(address).not.toContain('%40');
    }
  });

  it('carry the stretch of a thread, encoded', () => {
    expect(agentThreadHref('pepe')).toBe('/@pepe');
    expect(agentThreadHref('pepe', 'th 1')).toBe('/@pepe?threadId=th%201');
  });

  it('read the handle trimmed, empty when Oxy resolved none', () => {
    expect(agentHandle({ name: null, handle: '  pepe ' })).toBe('pepe');
    expect(agentHandle(nameless)).toBe('');
    expect(agentHandle({ name: null, handle: '   ' })).toBe('');
  });

  it('fall back to the page by id only for an agent with no handle', () => {
    expect(agentDetailsRoute(nameless)).toEqual({
      pathname: '/(app)/agents/[id]',
      params: { id: 'a2' },
    });
    expect(agentEditRoute(nameless)).toEqual({
      pathname: '/(app)/agents/edit/[id]',
      params: { id: 'a2' },
    });
    // The thread has no id address at all: the agent's own page is where its chat falls back to.
    expect(agentChatRoute(nameless)).toEqual({
      pathname: '/(app)/agents/[id]',
      params: { id: 'a2' },
    });
  });

  it('give the link that leaves the app the same address as the page', () => {
    expect(agentSharePath(pepe)).toBe('/@pepe/details');
    expect(agentSharePath(nameless)).toBe('/agents/a2');
  });
});
