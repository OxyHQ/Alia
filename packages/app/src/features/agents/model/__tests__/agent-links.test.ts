import { describe, expect, it, vi } from 'vitest';

// The share builder lives beside the screen's hooks; only its pure half is
// under test, so the hooks' own dependencies are not loaded for real.
vi.mock('@/features/agents/runtime/use-agent-thread-actions', () => ({}));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({}) }));
vi.mock('react-native', () => ({ Share: { share: async () => ({}) } }));

import { agentCategoryLabel } from '@/features/agents/model/category';
import { agentChatRoute, agentThreadHref } from '@/shared/routing/agent-address';
import { agentShareMessage } from '@/features/agents/runtime/use-agent-detail-actions';
import { translator } from '@/shared/testing/translate';

/**
 * Where an agent's buttons go, as data (#608, rule 6): each of these was a
 * control whose press did something other than what it said.
 */

describe('Chat, on a catalogue card', () => {
  it('opens the agent’s own thread, not the profile the card already opens', () => {
    expect(agentChatRoute({ name: 'Pepe', handle: 'pepe' })).toBe('/@pepe');
  });

  it('keeps the @ in the address: a path, not a route object whose value Expo Router encodes', () => {
    const route = agentChatRoute({ name: 'Pepe', handle: 'pepe' });
    expect(typeof route).toBe('string');
    expect(route).not.toContain('%40');
    expect(agentThreadHref('pepe', 'th 1')).toBe('/@pepe?threadId=th%201');
  });

  it('offers nothing when the thread has no address', () => {
    expect(agentChatRoute({ name: 'Pepe', handle: null })).toBeNull();
    expect(agentChatRoute({ name: 'Pepe', handle: '  ' })).toBeNull();
  });
});

describe('Share', () => {
  it('links to the agent on Alia’s own domain', () => {
    const message = agentShareMessage({
      _id: 'a1',
      name: 'Pepe',
      handle: 'pepe',
      tagline: 'Finds flights',
    });
    expect(message).toBe('Pepe — Finds flights\nhttps://alia.onl/@pepe/details');
    expect(message).not.toContain('alia.app');
  });

  it('shares an agent with no handle by who it is alone: it has no page to link to', () => {
    const message = agentShareMessage({ _id: 'a1', name: 'Pepe', handle: null, tagline: '' });
    expect(message).toBe('Pepe');
  });

  it('never prints a null name', () => {
    const message = agentShareMessage({ _id: 'a1', name: null, handle: 'pepe', tagline: '' });
    expect(message).toBe('pepe\nhttps://alia.onl/@pepe/details');
  });
});

describe('an agent’s category', () => {
  it('is shown in the reader’s language, and an unknown one as stored', () => {
    expect(agentCategoryLabel('Research', translator('es'))).toBe('Investigación');
    expect(agentCategoryLabel('Research', translator('en'))).toBe('Research');
    expect(agentCategoryLabel('Gardening', translator('es'))).toBe('Gardening');
  });
});
