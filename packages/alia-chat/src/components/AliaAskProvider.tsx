/**
 * The ask provider of the root entry (`@alia.onl/sdk`): its sheet is a static import.
 *
 * The root entry already holds the whole chat, so loading `AliaAskSheet` lazily here would save
 * nothing and cost a lot on web: it is an async chunk boundary inside the SDK, and Metro hoists
 * every module two async chunks share into `__common.js`, which loads at first paint. An app that
 * lazy-loads its Alia sheet would then get the chat (and the Bloom it draws with) in its first
 * paint. An app that wants the chat out of its entry bundle mounts the provider from
 * `@alia.onl/sdk/ask` (`AliaAskProviderLazy`) instead. See `AliaAskCore` for the provider itself.
 */

import { createAskProvider } from './AliaAskCore';
import { AliaAskSheet } from './AliaAskSheet';

export type { AliaAsk, AliaAskAgents, AliaAskProviderProps } from './AliaAskCore';
export { useAskAgent } from './AliaAskCore';

export const AliaAskProvider = createAskProvider(AliaAskSheet);
