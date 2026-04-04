# Clarity API Reference

Last updated: 2026-03-07

## Base URL

`https://api.clarity.oxy.so`

## Authentication

Use one of:

- `Authorization: Bearer <session-token>`
- `Authorization: Bearer alia_sk_<api-key>`

## Models

### `GET /v1/models`
List available Clarity models.

Query params:
- `category` (optional): `general | coding | vision | audio | multimodal | voice`
- `chat` (optional): `true` to return chat-visible models only

Response shape:

```json
{
  "object": "list",
  "data": [
    {
      "id": "clarity-v1",
      "object": "model",
      "owned_by": "alia",
      "name": "Clarity V1",
      "category": "general",
      "is_default": true,
      "is_available": true,
      "capabilities": {
        "tools": true,
        "vision": true,
        "max_tokens": 8192
      },
      "pricing": {
        "credit_multiplier": 1
      }
    }
  ]
}
```

### `GET /v1/models/:modelId`
Return one model descriptor.

## Chat Completions

### `POST /v1/chat/completions`
Unified runtime for app, Codea, and Cowork.

Minimal request:

```json
{
  "model": "clarity-v1",
  "messages": [
    { "role": "user", "content": "Prepare my meeting with Sarah" }
  ],
  "stream": true
}
```

Supported extras (selected):
- `conversationId`
- `thinkingMode`
- `agentMode`
- `deepResearch`
- `tools`
- `stream_options.include_usage`

### `POST /alia/chat`
Same runtime and behavior as `/v1/chat/completions`.

## SSE Event Contract (streaming)

All named events include `eventVersion: 1`.

### `alia.plan_preview`

```json
{
  "eventVersion": 1,
  "planId": "plan-chatcmpl-...",
  "intent": "meeting_prep",
  "confidence": 0.8,
  "steps": ["Check calendar", "Check email", "Check notes"]
}
```

### `alia.approval_request`

```json
{
  "eventVersion": 1,
  "requestId": "...",
  "agentId": "...",
  "toolName": "sendTelegram",
  "args": {},
  "description": "External impact action",
  "severity": "high",
  "timeout": 60000
}
```

### `alia.approval_result`

```json
{
  "eventVersion": 1,
  "requestId": "...",
  "decision": "approved"
}
```

`decision` is `approved | denied | timeout`.

### `alia.research_progress`
Progress updates for deep research.

### `alia.agent_session`
Announces autonomous agent session creation from chat.

### `alia.reasoning`
Reasoning tokens/summary blocks.

### `alia.tool_result`
Tool execution result payload.

### `alia.title`
Conversation title updates.

### `alia.model_switch`
Runtime model switch notification.

## Triggers API

### `GET /triggers`
List current user triggers.

### `POST /triggers`
Create trigger.

Required fields:
- `name`
- `type`: `schedule | webhook | integration_event`
- `action.prompt`

### `PATCH /triggers/:id`
Update trigger.

### `DELETE /triggers/:id`
Delete trigger.

### `POST /triggers/:id/run`
Manual run.

### `GET /triggers/:id/executions`
Execution history.

### `POST /triggers/webhook/:token`
Run webhook trigger by token.

## Oxy Service Events

### `POST /webhooks/oxy/:serviceId`
Accepts service events with optional signature verification.

Runtime behavior:
- Idempotent by `eventId`.
- Creates persistent `AgentSession` before autonomous queueing.
- Falls back to notification if autonomous execution fails.

## Notifications API

### `GET /notifications`
List user notifications (paginated).

Query params:
- `status` (optional): `pending | sent | read | dismissed`
- `type` (optional): notification type filter
- `limit` (optional, default `30`, max `100`)
- `offset` (optional, default `0`)

### `GET /notifications/unread-count`
Returns `{ count: number }`.

### `PATCH /notifications/:id/read`
Mark single notification as read.

### `POST /notifications/read-all`
Mark all notifications as read.

### `PATCH /notifications/:id/dismiss`
Dismiss a notification.

### Push Token Management

#### `POST /notifications/push-token`
Register an Expo push token (mobile).

Body: `{ token, platform?, deviceId? }`

#### `DELETE /notifications/push-token`
Deactivate an Expo push token.

Body: `{ token }`

### Web Push (Browser)

#### `GET /notifications/vapid-public-key`
Returns VAPID public key for browser push subscription. **No auth required.**

Response: `{ publicKey: string }`

#### `POST /notifications/web-push-subscription`
Register a browser push subscription.

Body: `{ endpoint, keys: { p256dh, auth } }`

#### `DELETE /notifications/web-push-subscription`
Deactivate a browser push subscription.

Body: `{ endpoint }`

### Real-time (Socket.IO)

Connect to `config.apiUrl` via Socket.IO websocket. On connect, emit `subscribe-notifications` with userId. Listen for `notification` events to invalidate caches.

## Codea Endpoints

### `GET /codea/user`
Entitlement payload.

### `GET /codea/token`
Token/quota metadata.

### `GET /codea/mcp_registry`
MCP policy metadata.

### `GET /codea/me`
Current user summary.

## Removed Endpoints (no compatibility layer)

These now return `410 Gone`:

- `POST /v1/resolve-model`
- `POST /v1/report-usage`
- `POST /codea/resolve-model`
- `POST /codea/report-usage`

Also removed:
- All `/automations*` endpoints.

## Error Contract

- User-facing errors are sanitized.
- Public responses include only Clarity model identifiers.
