// @alia.onl/sdk/ask — the app's one Alia sheet, without the chat in the entry bundle
// `AliaAskProvider` and `useAskAgent` alone: the sheet they open is loaded with the first `ask`.
// An app mounts the provider at its root from here rather than from the root entry, which
// would bring the whole chat along with it.

export { AliaAskProvider, useAskAgent } from './components/AliaAskProvider';
export type { AliaAsk, AliaAskAgents, AliaAskProviderProps } from './components/AliaAskProvider';
