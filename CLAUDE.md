# Alia - Project Conventions

## Model Abstraction Architecture

**CRITICAL RULE: Users and developers must ONLY see Alia-branded model names. Never expose internal provider names.**

### How it works

- **User-facing models**: `alia-lite`, `alia-v1`, `alia-v1-codea`, `alia-v1-pro`, `alia-v1-thinking`, `alia-v1-pro-max`, etc.
- **Internal providers**: OpenAI, Anthropic, Google, Groq, DeepSeek, xAI, Mistral, and others. These are strictly internal and must never be exposed.
- **Routing**: Each Alia model maps to multiple provider models with automatic fallback (cheapest/free tier first, then progressively more expensive).

### What to NEVER do

- Never show provider names (OpenAI, Anthropic, Google, Groq, etc.) in UI, API responses, error messages, SEO metadata, or documentation
- Never show provider model IDs (gpt-4o, claude-sonnet-4, gemini-2.5-flash, etc.) to users
- Never reference specific provider models in feature descriptions or marketing copy

### What to ALWAYS do

- Use Alia model names: `alia-v1`, `alia-lite`, `alia-v1-pro`, `alia-v1-thinking`, etc.
- Use `sanitizeMessage()` from `apps/api/src/lib/errors/sanitize.ts` for all user-facing error messages
- When displaying analytics/model usage, resolve to Alia model names via `getAliaModel()` and skip entries that can't be resolved

### Key files

- `apps/api/src/internal/providers/lib/alia-models.ts` - Alia model definitions
- `apps/api/src/internal/providers/lib/generate-model-mappings.ts` - Provider routing config
- `apps/api/src/routes/v1/models.ts` - Public models API (returns only Alia models)
- `apps/api/src/lib/errors/sanitize.ts` - Error message sanitization (strips provider names)
- `apps/api/src/internal/` - All provider logic (internal only, CORS-restricted)

## MongoDB Database Naming

All Oxy ecosystem apps share the same MongoDB cluster on DigitalOcean. Each app uses its own database named `{appName}-{NODE_ENV}` (e.g., `alia-production`). The `dbName` is passed to `mongoose.connect()`, not embedded in `MONGODB_URI`.

## Monorepo Structure

- `apps/app/` - Main Expo app (React Native + Web)
- `apps/api/` - Express backend API
- `apps/alia-codea/` - VS Code extension
- `apps/alia-canvas/` - Web canvas app
- `apps/alia-providers-api/` - Providers service (internal)

## Tech Stack

- **Frontend**: Expo 55, React Native 0.83, TypeScript, NativeWind (Tailwind), Reanimated v4, Zustand, TanStack Query
- **Backend**: Express, TypeScript, MongoDB/Mongoose, Socket.IO
- **Auth**: @oxyhq/services (OxyProvider, useAuth, OxySignInButton)
- **Routing**: expo-router (file-based)
