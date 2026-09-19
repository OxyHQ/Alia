import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * One owner for ghost, agent mode and deep research.
 *
 * They were owned twice: a `Set<Mode>` inside `ChatPageContent`, which drew the
 * menu's checkmarks, and the global store, which is what `use-streaming-chat`
 * reads when it builds the request. A remount emptied the `Set` and left the
 * store untouched, so the menu and the payload disagreed — and the payload is
 * the one that decides what actually happens.
 *
 * The first case below is that divergence, written as the sequence that
 * produced it: turn a capability on, remount, and ask what the menu would draw.
 * Before this hook the answer was "off" while the request still carried it.
 *
 * The rest are the behaviours the toggle owes: a plan gate that stops a
 * capability being switched ON without the entitlement, and — the case worth
 * stating out loud — that the same gate never stops it being switched OFF. A
 * plan that lapsed while deep research was on would otherwise leave the flag
 * welded into every request, with the only control over it bouncing the person
 * to a subscribe page.
 */

const store = vi.hoisted(() => ({
  ghostMode: false,
  agentMode: false,
  deepResearchMode: false,
}));

const env = vi.hoisted(() => ({
  features: {} as Record<string, boolean>,
  pushed: [] as string[],
  toasts: [] as string[],
}));

/**
 * A stand-in that notifies its readers, because the real one does.
 *
 * Zustand re-renders every component subscribed to a slice the moment a setter
 * writes it — that is the whole reason the store can be the single owner. A
 * mock that only holds the value would make the hook look stale in a way
 * nothing about the hook causes, and the test would be measuring the mock.
 */
vi.mock('@/lib/stores/global-store', async () => {
  const { useSyncExternalStore } = await import('react');
  const listeners = new Set<() => void>();
  const notify = () => { listeners.forEach((fn) => fn()); };
  const state = {
    get ghostMode() { return store.ghostMode; },
    get agentMode() { return store.agentMode; },
    get deepResearchMode() { return store.deepResearchMode; },
    setGhostMode: (v: boolean) => { store.ghostMode = v; notify(); },
    setAgentMode: (v: boolean) => { store.agentMode = v; notify(); },
    setDeepResearchMode: (v: boolean) => { store.deepResearchMode = v; notify(); },
  };
  const subscribe = (fn: () => void) => {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  };
  const useStore = (selector: (s: typeof state) => unknown) => useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(state),
  );
  useStore.getState = () => state;
  return { useStore };
});

vi.mock('@/lib/hooks/use-billing', () => ({
  useEntitlements: () => ({ data: { features: env.features } }),
}));

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: (path: string) => { env.pushed.push(path); } }),
}));

vi.mock('@oxy.so/bloom/toast', () => ({
  toast: {
    info: (message: string) => { env.toasts.push(message); },
    error: vi.fn(),
    success: vi.fn(),
  },
}));

import { useCapabilityModes, type CapabilityModes } from '@/lib/chat/use-capability-modes';

/** A fresh mount of the hook — the act the old `Set` could not survive. */
function mount() {
  let api: CapabilityModes | null = null;
  function Probe() {
    api = useCapabilityModes();
    return null;
  }
  act(() => { create(React.createElement(Probe)); });
  return {
    get active() {
      if (!api) throw new Error('hook did not render');
      return api.active;
    },
    toggle(mode: Parameters<CapabilityModes['toggle']>[0]) {
      if (!api) throw new Error('hook did not render');
      const { toggle } = api;
      act(() => { toggle(mode); });
    },
  };
}

beforeEach(() => {
  store.ghostMode = false;
  store.agentMode = false;
  store.deepResearchMode = false;
  env.features = { 'agent-mode': true, 'deep-research': true };
  env.pushed = [];
  env.toasts = [];
});

describe('useCapabilityModes', () => {
  it('still reports a capability as on after a remount', () => {
    const first = mount();
    first.toggle('agent');
    expect(first.active.agent).toBe(true);
    expect(store.agentMode).toBe(true);

    // What the drawer does when it swaps screens, and what the old local `Set`
    // silently reset while the request body kept carrying the flag.
    const second = mount();
    expect(second.active.agent).toBe(true);
  });

  it('turns a capability back off in one press', () => {
    const screen = mount();
    screen.toggle('deepResearch');
    expect(store.deepResearchMode).toBe(true);

    screen.toggle('deepResearch');
    expect(store.deepResearchMode).toBe(false);
    expect(screen.active.deepResearch).toBe(false);
  });

  it('refuses to switch on a capability the plan does not include', () => {
    env.features = {};
    const screen = mount();

    screen.toggle('agent');

    expect(store.agentMode).toBe(false);
    expect(env.pushed).toEqual(['/(biglayout)/subscribe']);
  });

  it('still switches one off after the plan that allowed it has gone', () => {
    store.deepResearchMode = true;
    env.features = {};
    const screen = mount();

    screen.toggle('deepResearch');

    expect(store.deepResearchMode).toBe(false);
    expect(env.pushed).toEqual([]);
  });

  it('gates nothing on ghost, which no plan sells', () => {
    env.features = {};
    const screen = mount();

    screen.toggle('ghost');

    expect(store.ghostMode).toBe(true);
    expect(env.pushed).toEqual([]);
  });

  it('announces the direction it actually moved', () => {
    const screen = mount();
    screen.toggle('agent');
    screen.toggle('agent');

    expect(env.toasts).toEqual(['modes.agentOn', 'modes.agentOff']);
  });
});
