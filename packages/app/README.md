# Alia App

Expo app for web, iOS, and Android.

## Current Focus

- Unified streaming chat client for the shared autonomy runtime.
- Automations UI (backed by `/automations`).
- Agent activity in real time. No agent asks for approval (ADR 0020 §3).
- Memory, settings, billing, and organization features.

## Key Runtime Integrations

### Chat Streaming

`useStreamingChat` consumes named SSE events from `/alia/chat`, Alia's product
runtime (`/v1/chat/completions` is the same handler, kept for other callers):

- `alia.reasoning`
- `alia.tool_result`
- `alia.plan_preview`
- `alia.agent_start` / `alia.agent_delta` / `alia.agent_tool` / `alia.agent_end`
- `alia.host_action`
- `alia.research_progress`
- `alia.model_switch`
- `alia.agent_turn`
- `alia.title`

All payloads include `eventVersion: 1`.

### Agent Activity

`agent-panel` + `use-agent-activity` show a run's steps, plan and sources as
they happen. There is no approval card: an agent's configuration is its
permission, enforced by Oxy per call.

### Automations UI

`app/(app)/automations.tsx` reads and writes the normalized `/automations` API.

## Main Routes

- `app/(app)/(own-header)/index.tsx` - entry chat
- `app/(app)/(own-header)/c/[id]/index.tsx` - conversation view

A screen that draws its own frame and header (a chat) lives in the `(own-header)` route group, which
adds nothing to its URL; the layout gives every other screen the shell's container and header.
`app/(app)/__tests__/one-header.test.ts` fails when a file is on the wrong side.
- `app/(app)/agents.tsx` - agent directory
- `app/(app)/agents/[id].tsx` - agent detail/activity
- `app/(app)/automations.tsx` - automation list and controls
- `app/(app)/notifications.tsx` - notification feed
- `app/(app)/settings/*` - settings area

## Development

```bash
# from repo root
bun run dev:app

# from packages/app
bun run start
```

Platform targets:

```bash
bun run web
bun run ios
bun run android
```

## API Config

Configured in `packages/app/src/shared/platform/config.ts`.

Expected production API:

- `https://api.gemies.ai` (Gemies' backend, ADR 0034)

## Notes

- Public hosted selection uses Kaana routing-profile IDs only.
