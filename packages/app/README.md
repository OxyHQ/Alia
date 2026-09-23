# Alia App

Expo app for web, iOS, and Android.

## Current Focus

- Unified streaming chat client for the shared autonomy runtime.
- Automations UI (backed by `/automations`).
- Agent activity + approval actions in real time.
- Memory, settings, billing, and organization features.

## Key Runtime Integrations

### Chat Streaming

`useStreamingChat` consumes named SSE events from `/alia/chat`, Alia's product
runtime (`/v1/chat/completions` is the same handler, kept for other callers):

- `alia.reasoning`
- `alia.tool_result`
- `alia.plan_preview`
- `alia.approval_request`
- `alia.approval_result`
- `alia.research_progress`
- `alia.model_switch`
- `alia.agent_turn`
- `alia.title`

All payloads include `eventVersion: 1`.

### Agent Approval UX

`agent-panel` + `use-agent-activity` handle:

- Approval request display
- Approve/deny actions
- Socket emission via `agent-approval-response`

### Automations UI

`app/(app)/automations.tsx` reads and writes the normalized `/automations` API.
Legacy `/triggers` writes return `410 Gone`.

## Main Routes

- `app/(app)/index.tsx` - entry chat
- `app/(app)/c/[id].tsx` - conversation view
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

Configured in `packages/app/lib/config.ts`.

Expected production API:

- `https://api.alia.onl`

## Notes

- Public hosted selection uses Kaana routing-profile IDs only.
