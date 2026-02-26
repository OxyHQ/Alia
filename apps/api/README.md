# Alia API

Standalone API for Alia built with Express and TypeScript.

## Features

- RESTful API with Express
- MongoDB connection with Mongoose
- **Unified OpenAI-Compatible API**: All AI providers (Google, Anthropic, OpenAI, Groq, etc.) are exposed through an OpenAI-compatible API
- Support for multiple AI providers using AI SDK internally
- Authentication and user management
- Chat streaming with SSE (Server-Sent Events)
- Automatic conversion from Alia models to specific providers
- **Autonomous Agent Runtime** — event-driven state machine with Manus-inspired context engineering
- **Docker Container Sandbox** for secure agent code execution
- **Agent-to-Agent Delegation** with recursive session management
- **Event Stream** — append-only persistent log of all agent actions and observations
- **Structured Planning** — todo-based task tracking with attention-optimized context injection
- **Workspace Memory** — file-system-as-extended-context in containers
- **Proactive Intelligence** — triggers, notifications, daily briefings, after-chat analysis
- **Multi-Channel Notifications** — in-app (Socket.io), Telegram, Discord, WhatsApp, Slack delivery
- **Natural Language Automation** — create triggers and routines conversationally via chat tools

## Architecture

The API acts as a **unified gateway** that:

1. **Receives requests in OpenAI format** from any client
2. **Internally uses AI SDK** with official providers (Google, Anthropic, OpenAI, Groq, etc.)
3. **Converts everything to OpenAI format** in the response stream

```
Client (OpenAI SDK)
    |
API /v1/chat/completions (OpenAI format)
    |
AI SDK with official providers
    |
Google / Anthropic / OpenAI / Groq / etc.
    |
Conversion to OpenAI SSE stream
    |
Client receives standard OpenAI format
```

### Benefits

- **Simple clients**: All clients use OpenAI SDK (no need for AI SDK or custom providers)
- **Centralization**: Routing logic, credits, and provider management in a single place
- **Compatibility**: Any OpenAI-compatible tool works with Alia
- **Transparency**: Users don't need to know which internal provider is used (Gemini, Claude, etc.)

### Streaming Format

The API emits chunks in OpenAI format with extensions for reasoning:

```typescript
// Regular text chunk
{
  id: "chatcmpl-...",
  object: "chat.completion.chunk",
  created: 1234567890,
  model: "alia-v1-cowork",
  choices: [{
    index: 0,
    delta: { content: "text..." },
    finish_reason: null
  }]
}

// Reasoning chunk (chain-of-thought)
{
  choices: [{
    delta: { reasoning: "thinking..." }
  }]
}

// Tool call chunk
{
  choices: [{
    delta: {
      tool_calls: [{
        id: "call_...",
        type: "function",
        function: {
          name: "tool_name",
          arguments: "{...}"
        }
      }]
    }
  }]
}
```

## Alia Models

| ID | Name | Category | Multiplier | Max Tokens |
|----|------|----------|------------|------------|
| `alia-lite` | Alia Lite | General | 0.5x | 4,096 |
| `alia-v1` | Alia V1 | General | 1x | 8,192 |
| `alia-v1-codea` | Codea | Coding | 1.5x | 16,384 |
| `alia-v1-cowork` | Alia V1 Cowork | Desktop | 1.5x | 16,384 |
| `alia-v1-browser` | Alia V1 Browser | Browser | 1.5x | 16,384 |
| `alia-v1-vision` | Alia V1 Vision | Vision | 1.5x | 16,384 |
| `alia-v1-audio` | Alia V1 Audio | Audio | 1x | 8,192 |
| `alia-v1-multimodal` | Alia V1 Multimodal | Multimodal | 2x | 32,768 |
| `alia-v1-pro` | Codea Pro | Coding | 3x | 32,768 |
| `alia-v1-thinking` | Alia V1 Thinking | Coding | 5x | 128,000 |
| `alia-v1-pro-max` | Alia V1 Pro Max | General | 5x | 128,000 |
| `alia-v1-voice` | Alia V1 Voice | Voice | 2x | 8,192 |
| `alia-v1-voice-pro` | Alia V1 Voice Pro | Voice | 4x | 32,768 |

## Internal Model Mappings

Each Alia tier maps to real provider models with automatic fallback. Mappings are auto-generated from the provider admin database — see `src/internal/providers/lib/generate-model-mappings.ts` for the current source of truth.

### Provider Failover System

The API implements a multi-layer failover system that ensures the client **never** sees a provider error:

```
Request
  |
  v
Fallback Engine (iterates tier mappings by priority)
  |
  +-- Key Manager (selects best key, skips rate-limited/cooldown keys)
  |     |
  |     +-- Key fails? Try next key for same provider (up to 3)
  |     +-- All keys exhausted? Move to next provider
  |
  +-- Error Classification (classifies into FailoverReason)
  |     |
  |     +-- provider_unavailable (geo, service down) -> skip provider
  |     +-- rate_limit / auth                        -> try next key
  |     +-- billing                                  -> skip provider, mark key exhausted
  |     +-- timeout                                  -> retry once, then next provider
  |     +-- format / content_filter                  -> stop (non-retryable)
  |     +-- unknown                                  -> try next key, then next provider
  |
  +-- All providers exhausted?
        |
        +-- Synthetic response (friendly message, credits refunded)
```

**Key features**:
- **Dynamic retry budget**: tries every provider in the tier (not just 3)
- **Key-level retry**: failed keys are skipped, same provider retried with alternate keys
- **Provider-specific error parsing**: Google (`FAILED_PRECONDITION`), OpenAI (`billing_hard_limit_reached`), Anthropic (`overloaded_error`)
- **Retry-After propagation**: provider 429 headers feed into key cooldown duration
- **Mid-stream recovery**: if a provider fails after content was streamed, a graceful message is appended
- **Last-resort synthetic response**: when all providers fail, a friendly message is returned with `alia_meta: { synthetic: true, retryable: true }`
- **Key cache TTL**: 10 seconds to minimize stale-key window

Relevant source files:
- `src/lib/errors/failover-error.ts` — error classification and provider-specific data extraction
- `src/internal/providers/lib/fallback-engine.ts` — retry orchestration with reason-specific strategies
- `src/internal/providers/lib/key-manager.ts` — key selection, cooldowns, rate limits
- `src/routes/v1/chat-completions.ts` — retry loop, synthetic response, mid-stream recovery

## Credit System

**Formula**: `credits = Math.ceil(tokens / 1000) * multiplier`

**Example**:
- 1,500 tokens with `alia-v1` (1x) = 2 credits
- 1,500 tokens with `alia-v1-codea` (1.5x) = 3 credits
- 1,500 tokens with `alia-v1-pro-max` (5x) = 8 credits

**Minimum**: 1 credit per request

## Authentication

### JWT Sessions (Oxy)
```http
Authorization: Bearer <session-token>
```
or
```http
X-Session-Id: <session-token>
```

### API Keys (Developers)
```http
Authorization: Bearer alia_sk_<key>
```

### Telegram Bot (Internal)
```http
X-Telegram-Bot-Secret: <secret>
X-Oxy-User-Id: <user-id>
X-Telegram-Id: <telegram-id>
```

## Development

```bash
# From the monorepo root
npm run dev:api

# Or from apps/api
npm run dev
```

## Build

```bash
npm run build
npm run start
```

## Environment Variables

Create a `.env` file in `apps/api/`:

```env
API_PORT=3001
NODE_ENV=development
MONGODB_URI='mongodb://localhost:27017/alia'
WEB_URL='http://localhost:3000'

# API Keys
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GOOGLE_API_KEY=

# Auth
NEXTAUTH_SECRET=
NEXTAUTH_URL='http://localhost:3001'
```

## Endpoints

### Core

- `GET /` - API information
- `GET /health` - Health check

### Auth

- `POST /auth/register` - User registration
- `POST /auth/login` - User login
- `POST /auth/forgot-password` - Forgot password
- `POST /auth/reset-password` - Reset password

### Chat & AI (OpenAI-compatible)

- `POST /alia/chat` - Streaming chat with Alia (session auth)
- `POST /v1/chat/completions` - Chat completions (OpenAI-compatible)
- `POST /v1/responses` - Responses API (OpenAI-compatible)
- `GET /v1/models` - List available models
- `POST /v1/voice/token` - Get ephemeral voice session token
- `POST /v1/voice/transcription` - Audio transcription
- `GET /v1/realtime` - WebSocket endpoint for real-time voice

### Conversations

- `GET /conversations` - List conversations
- `POST /conversations` - Create conversation
- `GET /conversations/:id` - Get conversation
- `PUT /conversations/:id` - Update conversation
- `DELETE /conversations/:id` - Delete conversation

### Folders

- `GET /folders` - List folders
- `POST /folders` - Create folder
- `DELETE /folders/:id` - Delete folder

### Memory

- `GET /memory` - Get user memory
- `POST /memory/add` - Add memory
- `PUT /memory/:id` - Update memory
- `DELETE /memory/:id` - Delete memory
- `PUT /memory/preferences` - Update preferences
- `PUT /memory/context` - Update context
- `GET /memory/search` - Search memories
- `GET /memory/semantic-search` - Semantic search across memories
- `POST /memory/export/*` - Export memory data
- `POST /memory/import/*` - Import memory data

### Credits

- `GET /credits` - Get credit balance
- `GET /credits/usage` - Credit usage history

### Billing

- `GET /billing/plans` - List subscription plans
- `GET /billing/packages` - List credit packages
- `POST /billing/checkout/credits` - Create credit checkout (Stripe)
- `POST /billing/checkout/subscription` - Create subscription checkout (Stripe)
- `GET /billing/subscription` - Get current subscription
- `POST /billing/subscription/cancel` - Cancel subscription
- `GET /billing/transactions` - Transaction history
- `POST /billing/portal` - Create Stripe portal session
- `POST /billing/webhook` - Stripe webhook

### Developer API

- `GET /developer/apps` - List developer apps
- `POST /developer/apps` - Create app
- `GET /developer/apps/:id` - Get app details
- `PUT /developer/apps/:id` - Update app
- `DELETE /developer/apps/:id` - Delete app
- `POST /developer/apps/:id/keys` - Generate API key
- `DELETE /developer/apps/:id/keys/:keyId` - Revoke API key
- `GET /developer/stats` - Developer usage statistics

### Models

- `GET /models/stats` - Model usage statistics
- `GET /external-models` - Browse external model directory

### Skills

- `GET /skills` - List available skills
- `GET /skills/:id` - Get skill details

### Organization

- `POST /organization` - Create organization
- `GET /organization/:id` - Get organization
- `PUT /organization/:id` - Update organization
- `GET /organization/:id/members` - List members
- `POST /organization/:id/members` - Add member
- `DELETE /organization/:id/members/:memberId` - Remove member

### Automations

- `GET /automations` - List automations
- `POST /automations` - Create automation
- `PUT /automations/:id` - Update automation
- `DELETE /automations/:id` - Delete automation
- `POST /automations/:id/execute` - Execute automation

### Triggers

- `GET /triggers` - List user's triggers (filterable by type)
- `POST /triggers` - Create a trigger (schedule, webhook, or integration_event)
- `GET /triggers/:id` - Get trigger details
- `PATCH /triggers/:id` - Update a trigger
- `DELETE /triggers/:id` - Delete a trigger
- `POST /triggers/:id/run` - Manually execute a trigger
- `GET /triggers/:id/executions` - Get trigger execution history
- `POST /triggers/:id/regenerate-token` - Regenerate webhook token
- `POST /triggers/webhook/:token` - Receive webhook payload (public, token-based auth)

### Notifications

- `GET /notifications` - List notifications (paginated, filterable by status/type)
- `GET /notifications/unread-count` - Get unread notification count
- `PATCH /notifications/:id/read` - Mark notification as read
- `POST /notifications/read-all` - Mark all notifications as read
- `PATCH /notifications/:id/dismiss` - Dismiss a notification

### Analytics

- `GET /analytics/usage` - Usage analytics
- `GET /analytics/credits` - Credit analytics

### Agents (Autonomous Runtime)

- `GET /agents` - List agents
- `GET /agents/:id` - Get agent details
- `POST /agents` - Create agent
- `PUT /agents/:id` - Update agent
- `DELETE /agents/:id` - Delete agent
- `POST /agents/:id/hire` - Hire agent (start autonomous session)
- `GET /agents/:id/activity` - Get recent activity stream
- `GET /agents/:id/sessions` - List agent sessions
- `PATCH /agents/:id/status` - Toggle agent status (active/idle/offline)
- `POST /agents/:id/sessions/:sid/cancel` - Cancel running session

### Containers (Admin)

- `GET /containers` - List user's active containers
- `GET /containers/:id` - Get container details
- `DELETE /containers/:id` - Force destroy a container
- `GET /containers/templates/list` - List user's saved templates
- `DELETE /containers/templates/:id` - Delete a template

> Container operations (exec, files, expose, snapshot) are performed by agents via tools, not via REST endpoints. The Docker host service at `DOCKER_HOST_URL` handles the actual container management.

## Agent Architecture

The agent runtime is an autonomous execution engine inspired by [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)'s context engineering principles.

### Execution Model

```
User hires agent → AgentSession created (queued)
    |
    v
runAgentSession() — fire-and-forget background execution
    |
    v
State Machine Loop:
  INITIALIZING → PLANNING → ACTING → OBSERVING → REFLECTING → COMPLETED
    |                                                |
    |  (each iteration = one LLM call, one action)   |
    |                                                |
    +------------ Event Stream (append-only) --------+
```

### Core Components

| Component | File | Purpose |
|-----------|------|---------|
| **Event Stream** | `lib/agent/event-stream.ts` | Append-only log of all actions, observations, and errors. Persisted to MongoDB. Replaces in-memory buffer. |
| **State Machine** | `lib/agent/state-machine.ts` | Lifecycle states with state-based tool filtering (only `plan_*` tools during PLANNING, all tools during ACTING, etc.) |
| **Todo Manager** | `lib/agent/todo-manager.ts` | Structured task tracking injected at context tail for maximum attention weight |
| **Tool Router** | `lib/agent/tool-router.ts` | Consistent tool prefixes (`browser_*`, `shell_*`, `file_*`, etc.) with prefix-based filtering |
| **Workspace Memory** | `lib/agent/workspace-memory.ts` | Offloads large tool results to `/workspace/.alia/` in containers; provisions workspace structure |

### Tool Prefixing

All agent tools use consistent prefixes (like Manus's `browser_`, `shell_` pattern):

| Prefix | Tools | Purpose |
|--------|-------|---------|
| `browser_*` | `browser_search`, `browser_browse`, `browser_scrape` | Web operations |
| `shell_*` | `shell_exec`, `shell_create_container`, `shell_destroy_container` | Container execution |
| `file_*` | `file_read`, `file_write`, `file_list` | Container file operations |
| `memory_*` | `memory_save` | Persistent user memory |
| `comm_*` | `comm_telegram` | Communications |
| `plan_*` | `plan_update_todo`, `plan_complete` | Planning and task completion |
| `agent_*` | `agent_hire`, `agent_parallel` | Agent-to-agent delegation |
| `mcp_*` | `mcp_{server}__{tool}` | Connected MCP services |

### Context Engineering

The context is structured for KV-cache efficiency:

```
[STABLE PREFIX — cached across iterations]
  System prompt (static per agent)

[SEMI-STABLE MIDDLE — cached until overflow]
  Event stream history (oldest first)

[CHANGING TAIL — fresh every iteration]
  Recent events + current todo list + continuation prompt
```

Key principles:
- **Error retention**: Failed actions persist in the event stream and are fed back to the model
- **Todo at context tail**: Objectives placed at the end for maximum attention weight
- **One action per iteration**: Each LLM call produces exactly one action for maximum observability
- **Workspace memory**: Large results offloaded to container filesystem with references
- **Context diversity**: Continuation prompts are varied to prevent brittle pattern mimicry

### Canvas (Workflow Builder)

- `GET /api/workflows` - List workflows
- `POST /api/workflows` - Create workflow
- `GET /api/workflows/:id` - Get workflow
- `PUT /api/workflows/:id` - Update workflow
- `DELETE /api/workflows/:id` - Delete workflow
- `POST /api/execute` - Execute workflow
- `GET /api/sessions/:conversationId` - Get canvas session

### Codea (IDE Integration)

- `GET /codea/entitlements` - Check IDE entitlements
- `GET /codea/mcp/servers` - List MCP servers
- `POST /codea/mcp/servers` - Register MCP server

### Feedback & Referrals

- `POST /feedback` - Submit feedback
- `GET /referrals` - Get referral info
- `POST /referrals/redeem` - Redeem referral code

## Project Structure

```
src/
├── index.ts              # Entry point
├── routes/               # API routes
│   ├── health.ts
│   ├── auth.ts
│   ├── conversations.ts
│   ├── folders.ts
│   ├── memory.ts
│   ├── credits.ts
│   ├── chat.ts
│   ├── billing.ts
│   ├── developer.ts
│   ├── organization.ts
│   ├── feedback.ts
│   ├── referrals.ts
│   ├── skills.ts
│   ├── automations.ts
│   ├── analytics.ts
│   ├── models-stats.ts
│   ├── external-models.ts
│   ├── codea.ts
│   ├── channels.ts
│   ├── webhooks.ts
│   ├── telegram.ts
│   ├── v1.ts
│   ├── v1/
│   │   ├── chat-completions.ts
│   │   ├── models.ts
│   │   ├── voice.ts
│   │   ├── realtime.ts
│   │   └── responses.ts
│   └── canvas/
│       ├── index.ts
│       ├── workflows.ts
│       ├── sessions.ts
│       └── execute.ts
├── models/               # MongoDB models
│   ├── agent.ts          # Agent model (name, systemPrompt, allowedModels, etc.)
│   ├── agent-session.ts  # Agent execution session tracking
│   ├── container.ts      # Docker container instances
│   ├── container-template.ts # Container base templates
│   └── ...
├── lib/                  # Utilities and providers
│   ├── agent-runner.ts   # Autonomous agent execution engine (state-machine driven)
│   ├── agent-tools.ts    # Prefixed agent tool factory (browser_*, shell_*, file_*, etc.)
│   ├── agent/            # Agent engine modules
│   │   ├── event-stream.ts    # Append-only event log (persisted to MongoDB)
│   │   ├── state-machine.ts   # Agent lifecycle state machine with tool filtering
│   │   ├── todo-manager.ts    # Structured task tracking (attention manipulation)
│   │   ├── tool-router.ts     # Tool prefixing and state-based filtering
│   │   ├── workspace-memory.ts # File-system-as-extended-context in containers
│   │   └── index.ts           # Barrel exports
│   ├── container-manager.ts # Docker container lifecycle management
│   ├── notification-service.ts  # Multi-channel notification delivery
│   ├── trigger-engine.ts        # Cron scheduler + AI trigger execution
│   ├── daily-briefing.ts        # Personalized morning briefing generator
│   ├── hooks/                   # Chat lifecycle hooks
│   │   ├── index.ts             # Hook registration
│   │   ├── hook-runner.ts       # Hook execution engine
│   │   └── built-in/
│   │       ├── proactive-hook.ts    # After-chat proactive analysis
│   │       └── style-learning-hook.ts # Writing style adaptation
│   ├── tools/
│   │   ├── trigger-management.ts # NL trigger CRUD tools for chat
│   │   └── ...
├── models/
│   ├── notification.ts    # Notification documents
│   ├── trigger.ts         # Trigger configuration
│   ├── trigger-execution.ts # Trigger execution history
│   └── ...
├── routes/
│   ├── triggers.ts        # Trigger CRUD + webhook ingestion
│   ├── notifications.ts   # Notification management
│   └── ...
└── internal/             # INTERNAL MODULES - NOT PUBLIC
    └── providers/        # Provider management (admin only, HMAC auth)
```

### Internal Modules -- WARNING

The `internal/` directory contains modules that are **NOT part of the public API**:

- **providers/**: Internal provider key management, model configuration, and routing for virtual Alia models
- **Access**: Admin panel only via HMAC authentication
- **Purpose**: Infrastructure for managing AI provider keys and model mappings
- **Documentation**: See [internal/README.md](src/internal/README.md) for details

**NEVER expose these endpoints publicly or document them in external API docs.**
