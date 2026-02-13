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

| ID | Name | Description | Multiplier | Max Tokens |
|----|------|-------------|------------|------------|
| `alia-lite` | Alia Lite | Fast responses | 0.5x | 4,096 |
| `alia-v1` | Alia V1 | Performance/quality balance | 1x | 8,192 |
| `alia-v1-codea` | Alia V1 Codea | Optimized for code | 1.5x | 16,384 |
| `alia-v1-pro` | Alia V1 Pro | High quality | 3x | 32,768 |
| `alia-v1-pro-max` | Alia V1 Pro Max | Best available | 5x | 128,000 |

## Internal Model Mappings

Each Alia tier maps to real provider models with automatic fallback:

### alia-lite
1. Gemini 2.0 Flash (**default**)
2. Llama 3.3 70B (Groq)
3. Llama 3.3 70B (Cerebras)
4. Llama 3.3 70B (Together)

### alia-v1
1. Gemini 2.5 Flash (**default**)
2. GPT-4o-mini
3. Llama 3.3 70B (Groq)

### alia-v1-codea
1. Gemini 2.5 Pro (**default**)
2. GPT-4o
3. Claude Sonnet 4

### alia-v1-pro
1. GPT-4o (**default**)
2. Claude Sonnet 4
3. Gemini 2.5 Pro

### alia-v1-pro-max
1. Claude Sonnet 4 (**default**)
2. GPT-4o
3. Gemini 2.5 Pro

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

- `GET /` - API information
- `GET /health` - Health check
- `POST /auth/register` - User registration
- `POST /auth/login` - User login
- `POST /auth/forgot-password` - Forgot password
- `POST /auth/reset-password` - Reset password
- `GET /conversations` - List conversations
- `POST /conversations` - Create conversation
- `GET /conversations/:id` - Get conversation
- `PUT /conversations/:id` - Update conversation
- `DELETE /conversations/:id` - Delete conversation
- `GET /folders` - List folders
- `POST /folders` - Create folder
- `DELETE /folders/:id` - Delete folder
- `GET /memory` - Get user memory
- `POST /memory/add` - Add memory
- `PUT /memory/:id` - Update memory
- `DELETE /memory/:id` - Delete memory
- `PUT /memory/preferences` - Update preferences
- `PUT /memory/context` - Update context
- `POST /upload/avatar` - Upload avatar
- `DELETE /upload/avatar` - Delete avatar
- `GET /credits` - Get user credits
- `POST /alia/chat` - Streaming chat with Alia
- `POST /v1/chat/completions` - Chat completions (OpenAI-compatible)
- `GET /v1/models` - List available models
- `GET /billing/plans` - List subscription plans (from DB)
- `GET /billing/packages` - List credit packages
- `POST /billing/checkout/credits` - Create credit checkout (Stripe)
- `POST /billing/checkout/subscription` - Create subscription checkout (Stripe)
- `GET /billing/subscription` - Get current subscription
- `POST /billing/subscription/cancel` - Cancel subscription
- `GET /billing/transactions` - Transaction history
- `POST /billing/portal` - Create Stripe portal session
- `POST /billing/webhook` - Stripe webhook

## Project Structure

```
src/
├── index.ts          # Entry point
├── routes/           # API routes
│   ├── health.ts
│   ├── auth.ts
│   ├── conversations.ts
│   ├── folders.ts
│   ├── chat.ts
│   ├── v1.ts
│   └── v1/
│       ├── chat-completions.ts
│       └── models.ts
├── models/           # MongoDB models
├── lib/              # Utilities and providers
└── internal/         # INTERNAL MODULES - NOT PUBLIC
    └── providers/    # Provider management (admin only, HMAC auth)
```

### Internal Modules -- WARNING

The `internal/` directory contains modules that are **NOT part of the public API**:

- **providers/**: Internal provider key management, model configuration, and routing for virtual Alia models
- **Access**: Admin panel only via HMAC authentication
- **Purpose**: Infrastructure for managing AI provider keys and model mappings
- **Documentation**: See [internal/README.md](src/internal/README.md) for details

**NEVER expose these endpoints publicly or document them in external API docs.**
