import { describe, expect, it } from 'vitest';
import {
  agentChatRoute,
  agentDetailsRoute,
  agentEditRoute,
  agentHandle,
  agentThreadHref,
} from '@/shared/routing/agent-address';

/**
 * An agent is addressed by its handle, as a STRING with the `@` written out: the object form
 * `{ pathname: '/(app)/[username]', params: { username: '@pepe' } }` is encoded by Expo Router and
 * put `/%40pepe` in the address bar.
 */

const pepe = { name: 'Pepe', handle: 'pepe' };
const nameless = { name: null, handle: null };

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

  it('do not exist for an agent with no handle: it has no address, and no route by id stands in', () => {
    expect(agentChatRoute(nameless)).toBeNull();
    expect(agentDetailsRoute(nameless)).toBeNull();
    expect(agentEditRoute(nameless)).toBeNull();
    expect(agentChatRoute({ name: 'Pepe', handle: '   ' })).toBeNull();
  });
});
