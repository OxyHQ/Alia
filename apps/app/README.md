# Clarity App

Expo app for web, iOS, and Android.

## Current Focus

- Unified streaming chat client for the shared autonomy runtime.
- Trigger management UI (backed by `/triggers`).
- Agent activity + approval actions in real time.
- Memory, settings, billing, and organization features.

## Key Runtime Integrations

### Chat Streaming

`useStreamingChat` consumes named SSE events from `/v1/chat/completions`:

- `clarity.reasoning`
- `clarity.tool_result`
- `clarity.plan_preview`
- `clarity.approval_request`
- `clarity.approval_result`
- `clarity.research_progress`
- `clarity.model_switch`
- `clarity.agent_session`
- `clarity.title`

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
npm run dev:app

# from apps/app
npm start
```

Platform targets:

```bash
npm run web
npm run ios
npm run android
```

## API Config

Configured in `apps/app/lib/config.ts`.

Expected production API:

- `https://api.clarity.oxy.so`

## Notes

- No `/automations` API calls remain in the app client.
- Public model selection uses Clarity model IDs only.
