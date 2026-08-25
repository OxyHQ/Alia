import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/**
 * The one failure the main suite cannot reach: `expo-audio` itself not loading.
 *
 * It is imported lazily so it stays out of the bundle a first paint needs, which
 * means on web it is a separate chunk — and a chunk request that 404s after a
 * deploy, while a tab is still open on the old build, is the ordinary way this
 * happens. Without the catch around it the rejection is unhandled and the row
 * spins at `loading` forever, which is the same silence this whole fix exists to
 * remove.
 *
 * It needs its own file because vitest's module registry is per-file: the mock
 * that makes the import fail cannot coexist with the one that makes it succeed.
 */

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

vi.mock('@oxyhq/services', () => ({
  useOxy: () => ({ oxyServices: { getAccessToken: () => 'oxy-access-token' } }),
}));

vi.mock('expo-audio', () => {
  throw new Error('Loading chunk expo-audio failed');
});

import { useEpisodeAudio, type EpisodeAudio } from '../use-episode-audio';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let latest: EpisodeAudio | null = null;
let renderer: ReactTestRenderer | null = null;

function Probe() {
  latest = useEpisodeAudio('syra-ep-3');
  return null;
}

function audio(): EpisodeAudio {
  if (latest === null) throw new Error('useEpisodeAudio never rendered');
  return latest;
}

beforeEach(() => {
  latest = null;
});

afterEach(() => {
  if (renderer !== null) {
    act(() => renderer?.unmount());
    renderer = null;
  }
});

it('says the episode would not play when the player itself cannot be loaded', async () => {
  act(() => {
    renderer = create(<Probe />);
  });

  act(() => audio().toggle());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(audio().state).toBe('unplayable');
  expect(audio().problem).toBe('unavailable');
});
