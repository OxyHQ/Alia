import { describe, expect, it, vi } from 'vitest';

/**
 * Which conversation an agent run belongs to.
 *
 * The store holds ONE active session for the whole app, and every visited chat
 * stays mounted. The inline run card reads the session only when the turn that
 * opened it came from its own conversation — so the store has to remember that
 * conversation, and forget it when a run is opened from somewhere without one
 * (an agent's own page).
 */

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => {}),
    removeItem: vi.fn(async () => {}),
  },
}));

import { useUIStore } from '@/features/chat/runtime/ui-store';

describe('openAgentPanel', () => {
  it('remembers the conversation whose turn opened the run', () => {
    useUIStore.getState().openAgentPanel('turn-1', 'agent-1', 'conv-1');
    const state = useUIStore.getState();
    expect(state.activeAgentSessionId).toBe('turn-1');
    expect(state.activeAgentConversationId).toBe('conv-1');
    expect(state.rightPanel).toBe('agent');
  });

  it('owns no conversation when opened from outside one', () => {
    useUIStore.getState().openAgentPanel('turn-1', 'agent-1', 'conv-1');
    useUIStore.getState().openAgentPanel('turn-2', 'agent-1');
    expect(useUIStore.getState().activeAgentConversationId).toBeNull();
  });
});
