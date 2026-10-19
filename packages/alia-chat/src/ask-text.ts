// @alia.onl/sdk/ask/text — `@alia.onl/sdk/ask` without the voice call, and without bundling it
// The provider and its hook; the sheet loads with the first `ask`, and neither reaches the call's
// modules. `useAskAgent` is the same hook as `@alia.onl/sdk/ask`'s.

export { AliaAskProvider, useAskAgent } from './components/AliaAskProviderText';
export type {
  AliaAsk,
  AliaAskAgents,
  AliaAskProviderProps,
} from './components/AliaAskProviderText';
