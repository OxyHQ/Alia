# Alia App

Expo app for web, iOS, and Android.

## Current Focus

- Unified streaming chat client for the shared autonomy runtime.
- Trigger management UI (backed by `/triggers`).
- Agent activity + approval actions in real time.
- Memory, settings, billing, and organization features.

## Key Runtime Integrations

### Chat Streaming

`useStreamingChat` consumes named SSE events from `/v1/chat/completions`:

- `alia.reasoning`
- `alia.tool_result`
- `alia.plan_preview`
- `alia.approval_request`
- `alia.approval_result`
- `alia.research_progress`
- `alia.model_switch`
- `alia.agent_session`
- `alia.title`

All payloads include `eventVersion: 1`.

### Agent Approval UX

`agent-panel` + `use-agent-activity` handle:

- Approval request display
- Approve/deny actions
- Socket emission via `agent-approval-response`

### Trigger UI

Screen path remains `app/(app)/automations.tsx`, but the data source is now `/triggers` only.

## Main Routes

- `app/(app)/index.tsx` - entry chat
- `app/(app)/c/[id].tsx` - conversation view
- `app/(app)/agents.tsx` - agent directory
- `app/(app)/agents/[id].tsx` - agent detail/activity
- `app/(app)/automations.tsx` - trigger list and controls
- `app/(app)/notifications.tsx` - notification feed
- `app/(app)/settings/*` - settings area

## Development

```bash
# from repo root
bun run dev:app

# from apps/app
npm start
```

Platform targets:

```bash
bun run web
bun run ios
bun run android
```

## API Config

Configured in `apps/app/lib/config.ts`.

Expected production API:

- `https://api.alia.onl`

## Notes

- No `/automations` API calls remain in the app client.
- Public model selection uses Alia model IDs only.
