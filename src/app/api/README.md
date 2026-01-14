# Alia API Structure

This server provides two distinct API surfaces:

## `/api/v1/*` - OpenAI-Compatible API

External API designed for clients like Cursor, Continue, or any OpenAI-compatible tool.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/chat/completions` | POST | Chat completions (streaming SSE) |
| `/api/v1/models` | GET | List available models |

**Usage in Cursor:**
```json
{
  "baseUrl": "https://your-domain.com/api/v1",
  "apiKey": "your-key"
}
```

## `/api/alia/*` - Internal Application API

Internal API used by the Alia web application frontend. Uses Vercel AI SDK protocols.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/alia/chat` | POST | Chat with AI SDK UI Message Stream protocol |

## Other Endpoints

| Endpoint | Description |
|----------|-------------|
| `/api/conversations` | Conversation management (CRUD) |
| `/api/admin` | Admin functions |

## Architecture

```
/api
├── route.ts           # API root info
├── v1/               # OpenAI-compatible (external)
│   ├── route.ts
│   ├── chat/
│   │   └── completions/
│   │       └── route.ts
│   └── models/
│       └── route.ts
├── alia/             # Internal app API
│   └── chat/
│       └── route.ts
├── conversations/    # Conversation CRUD
└── admin/           # Admin endpoints
```
