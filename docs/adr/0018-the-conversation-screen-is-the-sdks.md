# 18. The conversation screen is the SDK's; the app keeps its layout

*La pantalla de conversación es del SDK; la app conserva solo su layout.*

**Status:** Accepted; amended by 0020 (2026-10-16: any app embeds any agent, and the header's participants are one SDK component)

**Date:** 2026-10-15

**Builds on:** the conversation runtime of `@alia.onl/sdk` 17 ([chat runtime](../chat-runtime.mdx)) and
[ADR 0017](./0017-voice-is-a-realtime-session-through-kaana.md) (voice is part of the conversation).

## Context

**The owner's decision, 2026-10-15, is the source of this ADR.** The bottom sheet of `@alia.onl/sdk`
and the Alia app are the same product. They had already come to share the conversation's data and its
voice call (SDK 17); the thread itself was still drawn twice — the SDK's `AliaChatMessageList` (Bloom's
`AgentReply`, a reasoning disclosure, plain actions) and the app's `ChatInterface` (Bloom's AI Chat turns,
the work log, tool cards, the thought panel, history, search, a scroll window over long threads).
Every fix to a turn had to be made in two places and the two had stopped agreeing: the sheet could not
read a turn's steps, the app could not show an agent's avatar thinking.

## Decision

1. **Everything that is a conversation is the SDK's.** The thread (`AliaThread`, `ThreadRow`), the
   reply's Markdown and rich blocks, the work log, the tool cards, the thought panel, the canvas
   renderers, an agent's thread (history, search, jump), an agent's run, the composer's draft and
   edits and power-level selector, suggestions, the questions Alia asks, and the voice call are drawn
   by `AliaChatContent`, which the sheet, `AliaChatScreen` and the app all mount. There is no
   `AliaChatMessageList`, no `ThinkingBlock`, no second thread.
2. **The app keeps only what is its own:** the sidebar UI (it reads the SDK's runtime), the right
   panel, the column layout that mounts them, its routes, and the callbacks of a host. They reach the
   screen through data and slots — `chrome`, `addMenu`, `deviceModels`, `voice`, `renderUsageLimit`,
   `runtime` (`showThought`, `openAutomation`, `faviconUrl`, navigation, credits) — never through a
   second implementation, and `ui-store` is split on that line: what the thread selected (the thought
   panel's turn) is the SDK's `useThoughtStore`; the right panel, the sidebar and the canvas stay in
   the app.
3. **Tool cards are the SDK's.** The weather, market quote and FairCoin cards belong to tools that the
   pipeline offers every surface (`getWeather`, `getMarketQuote`, `getFairCoin`, on the `web` grant),
   and their numbers travel in the message. A surface that draws Alia's reply draws them. The
   scheduled-task card is the same card, and a link only where the host passes `openAutomation`.
4. **The add menu stays the host's**, behind a slot (`addMenu`) with photos as the default: its rows
   are capabilities, skills and connected apps with plan gates, a router and a library behind them.
   **Power levels are the SDK's** (ADR 0014's vocabulary is universal); which of the person's own
   devices run a model is the host's (`deviceModels`).
5. **One thread, held by tests.** `tests/components/thread/one-thread.test.tsx` mounts the chat as a
   sheet mounts it and as the app mounts it and holds the rows equal, and fails if anything but
   `AliaThread`/`ThreadRow` imports Bloom's thread or its turns.

## Consequences

- `@alia.onl/sdk` 18.0.0 is a major: `AliaChatMessageList`/`ThinkingBlock` and the `renderMarkdown`,
  `onEditMessage`, `onThumbsUp`/`onThumbsDown` props are gone, `header` is `chrome`, and the sheet gains
  everything the app's thread had (actions, work log, cards, a sheet for the work of a turn).
- The SDK gains peers (`expo-web-browser`, `react-native-css`; `expo-clipboard` is no longer optional)
  and the agent routes (`/agents/thread/…`, `/agents/sessions/…`), which answer Alia's own clients only.
  An embedding Oxy app has no agents of its own and passes no `threadHandle`.
- A new surface (Codea, Cowork) gets the app's conversation by mounting the SDK's, not by copying it.
- The cost is a larger public surface on `AliaChatContent`; it is organised in groups (conversation,
  level, words, frame, composer, sheet) and every member is typed, optional, and absent in the
  simplest host.
