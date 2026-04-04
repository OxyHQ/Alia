# Clarity - Project Conventions

## Model Abstraction Architecture

**CRITICAL RULE: Users and developers must ONLY see Clarity-branded model names. Never expose internal provider names.**

### How it works

- **User-facing models**: `clarity-fast`, `clarity-v1`, `clarity-pro`, `clarity-thinking`, `clarity-pro-max`
- **Internal providers**: OpenAI, Anthropic, Google, Groq, DeepSeek, xAI, Mistral, and others. These are strictly internal and must never be exposed.
- **Routing**: Each Clarity model maps to multiple provider models with automatic fallback (cheapest/free tier first, then progressively more expensive).

### What to NEVER do

- Never show provider names (OpenAI, Anthropic, Google, Groq, etc.) in UI, API responses, error messages, SEO metadata, or documentation
- Never show provider model IDs (gpt-4o, claude-sonnet-4, gemini-2.5-flash, etc.) to users
- Never reference specific provider models in feature descriptions or marketing copy

### What to ALWAYS do

- Use Clarity model names: `clarity-v1`, `clarity-fast`, `clarity-pro`, `clarity-thinking`, etc.
- Use `sanitizeMessage()` from `apps/api/src/lib/errors/sanitize.ts` for all user-facing error messages
- When displaying analytics/model usage, resolve to Clarity model names via `getClarityModel()` and skip entries that can't be resolved

### Key files

- `apps/api/src/internal/providers/lib/clarity-models.ts` - Clarity model definitions
- `apps/api/src/internal/providers/lib/generate-model-mappings.ts` - Provider routing config
- `apps/api/src/routes/v1/models.ts` - Public models API (returns only Clarity models)
- `apps/api/src/lib/errors/sanitize.ts` - Error message sanitization (strips provider names)
- `apps/api/src/internal/` - All provider logic (internal only, CORS-restricted)

## MongoDB Database Naming

All Oxy ecosystem apps share the same MongoDB cluster on DigitalOcean. Each app uses its own database named `{appName}-{NODE_ENV}` (e.g., `clarity-production`). The `dbName` is passed to `mongoose.connect()`, not embedded in `MONGODB_URI`.

## Monorepo Structure

- `apps/app/` - Main Expo app (React Native + Web)
- `apps/api/` - Express backend API
- `apps/clarity-gateway/` - Gateway service (internal)

## Tech Stack

- **Frontend**: Expo 55, React Native 0.83, TypeScript, NativeWind (Tailwind), Reanimated v4, Zustand, TanStack Query
- **Backend**: Express, TypeScript, MongoDB/Mongoose, Socket.IO
- **Auth**: @oxyhq/services (OxyProvider, useAuth, OxySignInButton)
- **Routing**: expo-router (file-based)

## Search-First Architecture

Clarity is an AI-powered search engine by Oxy. Key principles:
- **Always search first**: The AI searches the web before answering factual questions
- **Source citations**: Every factual claim includes numbered source references [1], [2], etc.
- **Deep research mode**: Multi-step research with decomposition, parallel search, extraction, synthesis
- **Follow-up suggestions**: After each answer, suggest 3 related follow-up questions
- **SSE streaming**: All search responses stream via Server-Sent Events with custom events (clarity.research_progress, clarity.reasoning, clarity.tool_result, clarity.title, clarity.follow_ups, clarity.source_card)
