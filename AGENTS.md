# Alia - Project Conventions

## Custom Agents

Use this agent for all implementation work:
- `alia` — Full-stack engineer (13 apps, multi-provider AI, multi-channel)

## AWS Deployment

The backend (`apps/api`) runs on **AWS ECS Fargate** (region `us-west-2`, cluster `oxy-cluster`), behind an ALB with ACM HTTPS.

- **Port**: `3001` | **Domain**: `api.alia.onl`
- **Deploy**: `git push origin main` → `.github/workflows/deploy-aws.yml` builds a `linux/arm64` Docker image → pushes to ECR (`237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/alia`) → `aws ecs update-service --force-new-deployment`
- **Auth**: GitHub OIDC → role `oxy-github-deploy`. No AWS keys stored in GitHub.
- **Secrets**: GitHub Actions secrets are the source of truth. The deploy workflow syncs them to AWS SSM (`/oxy/alia/*`; shared secrets to `/oxy/_shared/*`); ECS injects them into the container. To change a secret: edit it in GitHub — the next deploy applies it.
- **Dockerfile**: must build for `linux/arm64` (Graviton).
- **WARNING**: Never put secret values in this file.

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
- `apps/alia-gateway/` - Gateway service (internal)

## Tech Stack

- **Frontend**: Expo 55, React Native 0.83, TypeScript, NativeWind (Tailwind), Reanimated v4, Zustand, TanStack Query
- **Backend**: Express, TypeScript, MongoDB/Mongoose, Socket.IO
- **Auth**: `@oxyhq/core ^3.4.5`, `@oxyhq/auth ^4.1.1`, `@oxyhq/services ^10.2.2`, `@oxyhq/bloom ^0.8.5`
- **Routing**: expo-router (file-based)

Expo web SSO callback bootstrap lives in `apps/app/app/+html.tsx` via
`getSsoCallbackBootstrapScript()` from `@oxyhq/core`. Do not add local
`/__oxy/sso-callback` routes or copy SSO helper logic.

## Oxy Service Connector Protocol

Alia integrates with Oxy ecosystem apps (and future third-party services) via the **Oxy Service Connector** — a manifest-driven protocol where apps register tool definitions that Alia auto-discovers and exposes to the AI.

### How it works

1. **Service manifests** are stored in MongoDB (`OxyService` model). Each defines the service's tools, events, and optional context endpoint.
2. **`buildOxyServiceTools()`** reads manifests at chat time, generates AI SDK `tool()` wrappers with Zod schemas (via `jsonSchemaToZod()`), and forwards the user's OxyHQ JWT to the service API.
3. **Events** flow from services to Alia via `POST /webhooks/oxy/:serviceId` with HMAC signature verification. Events trigger notifications, context updates, or autonomous agent sessions.
4. **Context endpoints** (optional) provide brief user summaries injected into the system prompt at chat start.

### Adding a new service

Insert an `OxyService` document — zero changes to Alia's codebase needed:
```json
{
  "serviceId": "oxy-notes",
  "displayName": "Notes",
  "tools": [{ "name": "searchNotes", "endpoint": { "method": "GET", "path": "/notes/search" }, ... }]
}
```

### Key files

- `apps/api/src/models/oxy-service.ts` - OxyService Mongoose model (manifest schema)
- `apps/api/src/lib/tools/oxy-services.ts` - Tool builder (`buildOxyServiceTools`, `callOxyService`, `getOxyServiceContext`, `getOxyServicePromptFragment`)
- `apps/api/src/routes/oxy-service-events.ts` - Event webhook endpoint
- `apps/api/src/scripts/seed-oxy-services.ts` - Seed script for email service manifest
- `apps/api/src/routes/v1/chat-completions.ts` - Integration point (~line 615)

### Patterns to follow

- Same `safeExecute()` + cache pattern as `integrations.ts` and `mcp.ts`
- Same `jsonSchemaToZod()` from `mcp-schema.ts` for runtime schema conversion
- Auth: forward `req.accessToken` (user's OxyHQ JWT) — no OAuth needed for first-party
- Tool naming: `oxy_{serviceId}__{toolName}` (e.g., `oxy_inbox__searchEmails`)
