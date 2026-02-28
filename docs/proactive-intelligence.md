# Proactive Intelligence

Alia's proactive intelligence system transforms the platform from a reactive chatbot into an autonomous assistant that reaches out, monitors, and takes action without being asked.

## Architecture

```
User chats with Alia
    |
    v
Proactive Hook (after-chat analysis, 20% sample)
    |  Detects: reminders, monitoring, routines
    |
    v
Suggestion created ---> Welcome screen
    |
    v
User creates Trigger (via chat tools or API)
    |
    v
Trigger Engine (cron scheduler)
    |  Executes AI prompt with full tool access
    |  (web search, integrations, browser, etc.)
    |
    v
Notification Service
    |  Fan-out to all connected channels
    |
    +---> In-app (Socket.io real-time)
    +---> Push (Expo push notifications — iOS/Android)
    +---> Telegram
    +---> Discord
    +---> WhatsApp
    +---> Slack
```

## Trigger Engine

**Source:** `apps/api/src/lib/trigger-engine.ts`

The trigger engine is a cron-based scheduler that loads all enabled schedule triggers from the database, schedules them with `node-cron`, and executes them when they fire.

### Trigger Types

| Type | How it fires | Config |
|------|-------------|--------|
| `schedule` | Cron expression, daily time, or interval | `schedule.type`: `cron`, `daily`, or `interval` |
| `webhook` | External HTTP POST to `/triggers/webhook/:token` | Auto-generated token, optional HMAC secret |
| `integration_event` | Connected service emits event | `service` + `event` (e.g. `github` + `push`) |

### Trigger Action

Each trigger has an `action` that defines what Alia does when triggered:

```typescript
{
  prompt: string;       // AI instructions (e.g. "Check my GitHub PRs and summarize")
  agentId?: string;     // Specific agent to use
  useTools: boolean;    // Whether AI gets tool access (web search, integrations, etc.)
  notify?: boolean;     // Send notification with result
  channelId?: string;   // Specific channel for notification (telegram, discord, etc.)
}
```

### Schedule Types

- **Cron**: Raw cron expression (e.g. `"0 9 * * 1-5"` for weekdays at 9am)
- **Daily**: Time + optional day filter (e.g. `time: "08:00"`, `days: ["Monday", "Wednesday", "Friday"]`)
- **Interval**: Every N minutes (e.g. `intervalMinutes: 60`)

All schedule types support IANA timezone (e.g. `"America/New_York"`).

### Execution Flow

1. Trigger fires (cron tick, webhook POST, or integration event)
2. Engine resolves an AI model and builds a system prompt
3. AI executes with tools if `useTools: true` (web search, scraping, integrations, etc.)
4. Result is saved to `TriggerExecution` collection
5. If `action.notify: true`, a notification is sent via the notification service

## Notification System

**Source:** `apps/api/src/lib/notification-service.ts`, `apps/api/src/models/notification.ts`

### Notification Types

| Type | Source |
|------|--------|
| `trigger_result` | A trigger completed execution |
| `proactive_insight` | After-chat analysis detected an opportunity |
| `daily_briefing` | Personalized morning summary |
| `price_alert` | Price monitoring trigger |
| `integration_event` | Connected service event |
| `reminder` | User-set reminder |

### Delivery Channels

The notification service resolves which channels to use:

1. **Explicit channels** — If the trigger specifies a channel, use it
2. **Auto-detection** — Otherwise, default to `in_app` + any active push tokens + any linked messaging channels

Supported channels:
- **in_app** — Socket.io real-time event
- **push** — Expo push notifications (iOS/Android), delivered via `expo-server-sdk`
- **telegram** — Sent via linked Telegram bot account
- **discord / whatsapp / slack** — Via connected messaging accounts

Channel delivery happens in parallel via `Promise.allSettled()`. Each channel's delivery status is tracked independently (`pending`, `sent`, `failed`).

### Real-time In-App Delivery

In-app notifications use Socket.io:

```javascript
// Client subscribes to notifications
socket.emit('subscribe-notifications');

// Client receives notifications in real-time
socket.on('notification', (notification) => {
  // { id, type, title, body, priority, data, createdAt }
});
```

The server emits to a room `user:{userId}`, which the client joins on `subscribe-notifications`.

### REST API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/notifications` | GET | List notifications (paginated, filterable by `status`, `type`) |
| `/notifications/unread-count` | GET | Get unread count |
| `/notifications/:id/read` | PATCH | Mark as read |
| `/notifications/read-all` | POST | Mark all as read |
| `/notifications/:id/dismiss` | PATCH | Dismiss notification |

## Natural Language Automation

**Source:** `apps/api/src/lib/tools/trigger-management.ts`

Users create and manage triggers directly in chat using four tools:

| Tool | Description |
|------|-------------|
| `createTrigger` | Parse natural language into a trigger config and create it |
| `listTriggers` | Show user's active triggers |
| `updateTrigger` | Modify schedule, prompt, or enable/disable |
| `deleteTrigger` | Remove a trigger |

### Example Conversations

**Creating a routine:**
> User: "Every morning at 7am, check my GitHub PRs and send me a summary on Telegram"
>
> Alia creates a trigger with:
> - `type: "schedule"`, `schedule: { type: "daily", time: "07:00" }`
> - `action.prompt: "Check the user's GitHub PRs and write a summary"`
> - `action.useTools: true`, `action.notify: true`, `action.channelId: "telegram"`

**Creating a reminder:**
> User: "Remind me to review my quarterly goals every Sunday at 6pm"
>
> Alia creates a trigger with:
> - `schedule: { type: "cron", cron: "0 18 * * 0" }`
> - `action.prompt: "Remind the user to review their quarterly goals"`

**Managing triggers:**
> User: "What routines do I have set up?"
> User: "Disable the morning briefing"
> User: "Change my PR summary to run at 9am instead"

## Proactive Insights Hook

**Source:** `apps/api/src/lib/hooks/built-in/proactive-hook.ts`

After each chat conversation, a lightweight classification runs (on 20% of conversations to control costs) using the `alia-lite` model.

### Classification Categories

| Category | Example User Message |
|----------|---------------------|
| `reminder` | "I have a presentation next Friday" |
| `monitor` | "What's the current price of Bitcoin?" |
| `routine` | "Every week I have to check my analytics" |
| `none` | "What's the capital of France?" |

When a non-`none` category is detected, a personal `Suggestion` is created with:
- 7-day expiration
- Higher priority than regular suggestions
- Tags: `['proactive', category]`
- Shown on the user's welcome screen in their next session

### Hook Configuration

- **Priority**: 300 (runs after analytics at 100, style-learning at 200)
- **Sampling rate**: 20% of conversations
- **Minimum message length**: 20 characters (skips trivial messages)
- **Model**: `alia-lite` for cost efficiency
- **Non-blocking**: Failures don't affect the chat response

## Daily Briefing

**Source:** `apps/api/src/lib/daily-briefing.ts`

The daily briefing system creates a personalized morning summary trigger for each user.

### What's Included

The briefing prompt is personalized from `UserMemory`:
- **Interests**: Topics the user cares about
- **Occupation**: Professional context
- **Location**: Local relevance

The AI assembles a briefing using its available tools:
- Web search for relevant news
- Integration data (calendar events, GitHub activity, etc.)

### Defaults

- **Schedule**: Weekdays at 08:00
- **Timezone**: America/New_York (configurable)
- **Delivery**: Via notification service (in-app + linked channels)

### API

```typescript
import { createDailyBriefing, refreshBriefingPrompt } from './lib/daily-briefing.js';

// Create a daily briefing trigger for a user
await createDailyBriefing(userId, {
  time: '07:00',
  timezone: 'Europe/London',
  days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
});

// Update the briefing prompt as user context evolves
await refreshBriefingPrompt(userId);
```

## Frontend

### Notification Feed

**Source:** `apps/app/app/(app)/notifications.tsx`

The notifications screen shows a full feed with:
- Type icons (bell, clock, newspaper, tag, plug, megaphone)
- Priority indicators (colored left border: red=urgent, orange=high)
- Time-ago display
- Unread count badge
- "Mark all as read" button
- Dismiss (X) button per notification
- Tap to navigate to linked conversation

### React Query Hooks

**Source:** `apps/app/lib/hooks/use-notifications.ts`

| Hook | Purpose | Refresh Interval |
|------|---------|------------------|
| `useNotifications(limit)` | Paginated notification list | 60s |
| `useUnreadCount()` | Unread badge count | 30s |
| `useMarkAsRead()` | Mark single as read | - |
| `useMarkAllAsRead()` | Mark all as read | - |
| `useDismissNotification()` | Dismiss notification | - |

## Key Files

| File | Purpose |
|------|---------|
| `apps/api/src/lib/trigger-engine.ts` | Cron scheduler + AI trigger execution |
| `apps/api/src/lib/notification-service.ts` | Multi-channel notification delivery |
| `apps/api/src/lib/daily-briefing.ts` | Morning briefing generator |
| `apps/api/src/lib/hooks/built-in/proactive-hook.ts` | After-chat analysis |
| `apps/api/src/lib/tools/trigger-management.ts` | Chat tools for NL trigger CRUD |
| `apps/api/src/models/trigger.ts` | Trigger model |
| `apps/api/src/models/notification.ts` | Notification model |
| `apps/api/src/models/trigger-execution.ts` | Execution history model |
| `apps/api/src/routes/triggers.ts` | Trigger REST API |
| `apps/api/src/routes/notifications.ts` | Notification REST API |
| `apps/app/app/(app)/notifications.tsx` | Notification feed screen |
| `apps/app/lib/hooks/use-notifications.ts` | React Query hooks |
