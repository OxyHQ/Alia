import { createContext, useContext } from 'react';

/**
 * Whether a thread draws its turns as chat bubbles, as an agent's thread does.
 *
 * `false` is the thread's ordinary look, where the person's question is Bloom's own bubble and the
 * replies are plain. `true`: the person's turn is a bubble in the theme's primary (which the app
 * seeds with the agent's colour) and every reply is a neutral one.
 */
const BubblesContext = createContext(false);

export const BubblesProvider = BubblesContext.Provider;

export function useBubbles(): boolean {
  return useContext(BubblesContext);
}
