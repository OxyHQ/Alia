import { create } from 'zustand';
import type { AliaAvatarState } from '../components/AliaAvatar';

type Sources = Readonly<Record<string, AliaAvatarState>>;

/**
 * What Alia is doing, from every place that can know. Two sources feed it and neither owns it:
 *
 * - `local`: the turns running in THIS app, one entry per `useAliaChat` instance (the sheet);
 * - `remote`: runs the server reports for the person, one entry per agent session, so a button
 *   reacts to work that is not in any open chat.
 *
 * An idle source holds no entry, so neither map grows with use.
 */
interface AliaActivityStore {
  local: Sources;
  remote: Sources;
  setLocal(source: string, state: AliaAvatarState): void;
  setRemote(session: string, state: AliaAvatarState): void;
  clearRemote(): void;
}

function put(map: Sources, key: string, state: AliaAvatarState): Sources {
  if (state === 'idle') {
    if (!(key in map)) return map;
    const { [key]: _gone, ...rest } = map;
    return rest;
  }
  return map[key] === state ? map : { ...map, [key]: state };
}

export const useAliaActivityStore = create<AliaActivityStore>((set) => ({
  local: {},
  remote: {},
  setLocal: (source, state) => set((s) => ({ local: put(s.local, source, state) })),
  setRemote: (session, state) => set((s) => ({ remote: put(s.remote, session, state) })),
  clearRemote: () => set((s) => (Object.keys(s.remote).length === 0 ? s : { remote: {} })),
}));

/** The most telling thing any source is doing: a tool call outranks thinking, thinking outranks writing. */
const RANK: Record<AliaAvatarState, number> = { idle: 0, writing: 1, thinking: 2, working: 3 };

export function busiest(...maps: ReadonlyArray<Sources>): AliaAvatarState {
  let top: AliaAvatarState = 'idle';
  for (const map of maps) {
    for (const state of Object.values(map)) if (RANK[state] > RANK[top]) top = state;
  }
  return top;
}

/** A primitive, so a subscriber re-renders when the state changes and not when a session does. */
export const selectAliaActivity = (s: AliaActivityStore): AliaAvatarState =>
  busiest(s.local, s.remote);
