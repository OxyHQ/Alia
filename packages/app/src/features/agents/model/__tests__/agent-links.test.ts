import { describe, expect, it, vi } from 'vitest';

// The share builder lives beside the screen's hooks; only its pure half is
// under test, so the hooks' own dependencies are not loaded for real.
vi.mock('@/features/agents/runtime/use-agent-thread-actions', () => ({}));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({}) }));
vi.mock('react-native', () => ({ Share: { share: async () => ({}) } }));

import { agentCategoryLabel } from '@/features/agents/model/category';
import { agentChatRoute } from '@/features/agents/model/identity';
import { agentShareMessage } from '@/features/agents/runtime/use-agent-detail-actions';
import { translator } from '@/shared/testing/translate';

/**
 * Where an agent's buttons go, as data (#608, rule 6): each of these was a
 * control whose press did something other than what it said.
 */

describe('Chat, on a catalogue card', () => {
  it('opens the agent’s own thread, not the profile the card already opens', () => {
    expect(agentChatRoute({ _id: 'a1', name: 'Pepe', handle: 'pepe' })).toEqual({
      pathname: '/(app)/[username]',
      params: { username: '@pepe' },
    });
  });

  it('falls back to the profile only when the thread has no address', () => {
    expect(agentChatRoute({ _id: 'a1', name: 'Pepe', handle: null })).toEqual({
      pathname: '/(app)/agents/[id]',
      params: { id: 'a1' },
    });
    expect(agentChatRoute({ _id: 'a1', name: 'Pepe', handle: '  ' })).toMatchObject({
      pathname: '/(app)/agents/[id]',
    });
  });
});

describe('Share', () => {
  it('links to the agent on Alia’s own domain', () => {
    const message = agentShareMessage({ _id: 'a1', name: 'Pepe', handle: 'pepe', tagline: 'Finds flights' });
    expect(message).toBe('Pepe — Finds flights\nhttps://alia.onl/agents/a1');
    expect(message).not.toContain('alia.app');
  });

  it('never prints a null name', () => {
    const message = agentShareMessage({ _id: 'a1', name: null, handle: 'pepe', tagline: '' });
    expect(message).toBe('pepe\nhttps://alia.onl/agents/a1');
  });
});

describe('an agent’s category', () => {
  it('is shown in the reader’s language, and an unknown one as stored', () => {
    expect(agentCategoryLabel('Research', translator('es'))).toBe('Investigación');
    expect(agentCategoryLabel('Research', translator('en'))).toBe('Research');
    expect(agentCategoryLabel('Gardening', translator('es'))).toBe('Gardening');
  });
});
