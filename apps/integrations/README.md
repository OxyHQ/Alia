# Alia Integrations Service

Unified service for all messaging platform integrations, browser automation, and terminal execution.

## Adapters

| Adapter | Type | Description | Enable/Disable |
|---------|------|-------------|----------------|
| `telegram-bot` | Bot | Telegraf long-polling bot with streaming responses | `TELEGRAM_BOT_ENABLED` + `TELEGRAM_BOT_TOKEN` |
| `discord-bot` | Bot | Discord.js bot (DMs and @mentions) | `DISCORD_BOT_ENABLED` + `DISCORD_BOT_TOKEN` |
| `whatsapp` | Gateway | WhatsApp Web multi-session gateway | `WHATSAPP_ENABLED` |
| `telegram-gateway` | Gateway | Telegram user-account gateway (TDLib) | `TELEGRAM_GATEWAY_ENABLED` + `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` |
| `signal-gateway` | Gateway | Signal multi-session gateway | `SIGNAL_ENABLED` |

Additional routes: `/browser` (Puppeteer automation), `/terminal` (shell execution).

All adapters are enabled by default. Set `*_ENABLED=false` to disable.

## Architecture

```
User Message (Telegram/Discord/WhatsApp/Signal)
    │
    ▼
Adapter (platform-specific handling)
    │
    ▼
APIClient.chatCompletion() / chatCompletionStream()
    │  Headers: X-Channel-Bot-Secret, X-Oxy-User-Id
    ▼
POST /v1/chat/completions (main API)
    │  ▸ Full system prompt (Alia personality)
    │  ▸ User memory (facts, preferences, context)
    │  ▸ Server-side tools (web search, memory save, WhatsApp, Telegram send)
    │  ▸ User profile, language rules, skills
    │  ▸ Provider fallback, credit management
    ▼
AI Response → Adapter formats for platform → User
```

Bot adapters authenticate with the API using per-channel secrets (`X-Channel-Bot-Secret` header). The API validates these against the channel registry and sets the user context from `X-Oxy-User-Id`. This gives bots full feature parity with the main app — memory, tools, and all.

## Environment Variables

```bash
# Required
MONGODB_URI=mongodb+srv://...        # Shared cluster (DB: integrations-{NODE_ENV})
INTEGRATIONS_SECRET=<hex-32>         # Internal auth for gateway REST endpoints
API_BASE_URL=http://localhost:3001   # Main API URL

# Telegram Bot
TELEGRAM_BOT_TOKEN=<from-botfather>
TELEGRAM_BOT_SECRET=<hex-32>         # Must match API's channel registry

# Discord Bot
DISCORD_BOT_TOKEN=<from-discord-portal>
DISCORD_BOT_SECRET=<hex-32>          # Must match API's channel registry

# Telegram Gateway (optional)
TELEGRAM_API_ID=<from-my.telegram.org>
TELEGRAM_API_HASH=<from-my.telegram.org>

# Port (default 3005)
PORT=3005
```

## Development

```bash
# From monorepo root
npm run dev:integrations

# Or directly
cd apps/integrations
npx tsx src/index.ts
```

The service starts the HTTP server first (for health checks), then initializes adapters with 30s timeouts each. Failed adapter initialization is non-fatal — other adapters continue running.
