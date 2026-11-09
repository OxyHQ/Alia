import { createContext, useContext } from 'react';
import type { BubbleColors } from './bubble-colors';

/**
 * How a thread draws its turns when they are chat bubbles, as an agent's thread does.
 *
 * `null` is the thread's ordinary look, where the person's question is Bloom's own bubble and the
 * replies are plain. With a value, the person's turn is a bubble in the agent's colour (`colors`,
 * absent when the lead has no colour to take) and every reply is a neutral one.
 */
export interface BubblesValue {
  readonly colors: BubbleColors | null;
}

const BubblesContext = createContext<BubblesValue | null>(null);

export const BubblesProvider = BubblesContext.Provider;

export function useBubbles(): BubblesValue | null {
  return useContext(BubblesContext);
}
