# Changelog

All notable changes to the Alia AI project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- **CRITICAL**: Fixed memory not saving during conversations - AI tools were using `userId` instead of `oxyUserId` ([#memory-bug-fix](apps/api/src/lib/tools/user-memory.ts))
  - Updated `saveUserMemoryTool` to use correct field name
  - Updated `updateUserPreferencesTool` to use correct field name
  - Updated `updateUserContextTool` to use correct field name
  - Memory now saves correctly when users share information with Alia
- **504 Gateway Timeout**: Fixed intermittent 504 errors on `/v1/chat/completions` streaming requests
  - Early SSE headers + keep-alive comment sent before async work to satisfy proxy first-byte timeout
  - `X-Accel-Buffering: no` middleware on all `/v1` routes to disable nginx proxy buffering
  - 5-second timeout on `getUserById` to prevent slow auth from blocking response
  - `clearTimeout` on early returns to prevent timer leaks
  - `.catch()` on `resolveModel` in `Promise.all` to prevent rejection propagation
  - All-providers-exhausted error now sent as SSE event instead of silent close
- **Stream flag consistency**: Changed `body.stream !== false` to `body.stream === true` so undefined/omitted stream field doesn't trigger SSE headers

### Added

#### Streaming Reliability
- **Timeout tests**: 8 Vitest tests covering all 504 fix behaviors (early SSE, non-streaming, credits, no models, auth timeout, resolve catch, providers exhausted, no double headers)
- **`ensureSSEHeaders()` helper**: Extracted repeated SSE header-setting logic into an idempotent helper function

#### Memory System Improvements
- **Plan-based memory limits** ([apps/api/src/models/user-memory.ts](apps/api/src/models/user-memory.ts))
  - Free plan: 100 memories
  - Pro plan: 1,000 memories
  - Business plan: Unlimited memories
- **MongoDB performance indexes** for faster queries
  - Text index on `memories.key` and `memories.value` for full-text search
  - Index on `memories.category` for filtering
  - Index on `memories.updatedAt` for sorting
- **Comprehensive validation** using Zod schemas ([apps/api/src/lib/validators/memory-validators.ts](apps/api/src/lib/validators/memory-validators.ts))
  - Memory item validation (key, value, category)
  - Preferences validation
  - Context validation
  - Export/import format validation
- **Memory limit enforcement** in AI tools
  - Checks subscription status before adding new memories
  - Returns helpful upgrade suggestions when limit is reached

#### New API Endpoints
- **Search & Analysis**
  - `GET /api/memory/search` - Full-text search with pagination, filtering, and sorting
  - `GET /api/memory/duplicates` - Detect duplicate memories by value or key
- **Export**
  - `GET /api/memory/export/preview` - Get export statistics before downloading
  - `GET /api/memory/export/json` - Export complete memory data as JSON
  - `GET /api/memory/export/csv` - Export memories as CSV for spreadsheets
- **Import**
  - `POST /api/memory/import/validate` - Validate import data with preview
  - `POST /api/memory/import` - Import memories with merge strategies

#### Export/Import Features
- **Three merge strategies** for imports:
  - `merge`: Update existing memories, add new (recommended)
  - `skip-duplicates`: Only add new memories, preserve existing
  - `replace`: Complete replacement (destructive)
- **JSON export** includes:
  - All memories with metadata
  - User preferences
  - User context
  - Export version and timestamp
- **CSV export** for spreadsheet compatibility
  - Proper escaping for special characters
  - ISO 8601 timestamps
- **Import validation** with detailed preview
  - Shows duplicate vs new memory counts
  - Checks against memory limits
  - Provides estimated final total
- **File size limits**: 5MB maximum for imports

#### Skills as System Prompts
- **Skills system** with built-in and custom skill support
- **Skills API routes** (`/skills`) with full CRUD operations
- Skills applied as system prompts during chat
- Built-in skills seeded on startup (Creative Writer, Code Reviewer, etc.)
- Skills selection UI in the app

#### Automations & Cron Jobs
- **Automation scheduler** with cron-based triggers
- Atomic execution with `findOneAndUpdate` to prevent race conditions
- **Automations API routes** (`/automations`) with full CRUD
- Automation management UI in app

#### Chat Hooks Pipeline
- **Pre-chat and post-chat hook system**
- Built-in analytics hook for tracking usage
- Hook runner with ordered execution
- Side-effect import registration pattern

#### Improved AI Tools
- **Web scraper tool** for deep page content extraction
- **File generator tool** for creating downloadable files
- **Canvas tool** for pushing rich UI components to client
- Google search, device info, Telegram messaging tools

#### Analytics Dashboard
- **Chat analytics model** tracking per-conversation metrics
- **Analytics API routes** (`/analytics`) with aggregation queries
- Frontend analytics dashboard with charts

#### Multi-Channel Gateway (Plugin Architecture)
- **Composable channel plugin system** with typed adapters (config, outbound, security, normalize, webhook)
- Plugin registry with discovery and caching
- 4 channel plugins: Discord, WhatsApp, Slack, Signal
- **Unified channel routes** (`/channels`) for user management and account linking
- **Unified webhook routes** (`/webhooks`) with per-channel signature verification
- Generic `ChannelUser` model with channel type discriminator
- Channel-specific bot authentication middleware
- Outbound message service with per-channel text chunking

#### Workflow Execution Engine
- Complete node implementations: `aiText`, `aiImage`, `github`, `condition`, `memory`
- Topological sort (Kahn's algorithm) for execution ordering
- Socket.IO progress emission per node during execution
- `WorkflowExecution` model for tracking runs
- Typed API response interfaces for OpenAI and GitHub

#### Canvas Live (Agent-to-UI)
- **Canvas tool** registered in chat for AI to push dynamic UI components
- Canvas session model with persistence per conversation
- **Canvas session API routes** (GET/DELETE per conversation)
- Socket.IO canvas update emission
- SSE `canvas-component` events during chat streaming
- Frontend `CanvasPanel` with slide-in modal
- 6 component renderers: chart, table, code, form, markdown, canvas-component dispatcher
- Copy-to-clipboard in code renderer, interactive forms

#### Voice Mode with LiveKit + Speech-to-Text
- **Self-hosted LiveKit integration** for real-time voice conversations
- LiveKit agent worker with OpenAI Realtime multimodal model
- LiveKit token generation for users and agents
- Voice token endpoint (`POST /v1/voice/token`)
- Speech-to-text transcription endpoint (`POST /v1/voice/transcribe`) using OpenAI Whisper
- `VoiceChat` component rewritten with LiveKit client (connect, mute, agent state indicators)
- Speech-to-text hook (`useSpeechToText`) with expo-audio recording
- Send button morphs: Mic (empty input) -> ArrowUp (has text) -> Square (loading)
- Small mic icon for STT transcription with recording/transcribing indicators

#### Socket.IO Enhancements
- `getIO()` export for accessing Socket.IO instance from any module
- Workflow progress rooms (`subscribe-workflow`)
- Canvas update rooms (`subscribe-canvas`)
- `emitCanvasUpdate()` and `emitWorkflowProgress()` helper exports

#### Frontend Features
- **Export UI** in memory settings ([apps/app/app/(app)/settings/memory.tsx](apps/app/app/(app)/settings/memory.tsx))
  - Format selection (JSON/CSV)
  - Preview statistics before export
  - One-click download with timestamped filename
- **Import UI** in memory settings
  - File picker with 5MB validation
  - Real-time validation with preview
  - Merge strategy selector with descriptions
  - Progress indicators and success/error messages

### Changed
- Updated `POST /api/memory/add` endpoint to validate input and check memory limits
- Enhanced error messages to include upgrade suggestions when limits are exceeded

### Documentation
- Added comprehensive [docs/memory-system.md](docs/memory-system.md) documentation covering:
  - System architecture and data model
  - All API endpoints with examples
  - Export/import workflows
  - Memory limits by subscription plan
  - AI tools integration
  - Frontend integration guide
  - Bug fixes and troubleshooting
  - Best practices for developers and users

## Version History

### [1.0.0] - 2026-02-11

#### Initial Release
- Multi-agent AI platform (Alia, Developer, Social Manager, Business)
- Expo-based mobile and web application
- Express API server with OpenAI compatibility
- Next.js admin panel
- MongoDB-based data persistence
- Conversation management
- Folder organization
- Basic memory system
- Multiple LLM provider support (OpenAI, Anthropic, Google)
- Streaming chat responses
- User authentication via Oxy services

---

## Upgrade Guide

### Migrating to New Memory System

If you're upgrading from an older version:

1. **Database Migration**: MongoDB indexes are created automatically on first connection. No manual migration needed.

2. **Environment Variables**: Add `TELEGRAM_BOT_SECRET` to your environment:
   ```bash
   TELEGRAM_BOT_SECRET=$(openssl rand -hex 32)
   ```

3. **Test Memory Functionality**:
   ```bash
   # Test that memory saves during conversations
   # Tell Alia: "Remember that my favorite color is blue"
   # Check Memory settings - you should see the new memory
   ```

4. **Check Plan Limits**: Users on free plans are now limited to 100 memories. Existing users with more than 100 memories are grandfathered in, but cannot add more until they upgrade.

---

## Contributing

When adding new features or fixing bugs:

1. Update this CHANGELOG.md with your changes
2. Document any new API endpoints in docs/memory-system.md (or relevant docs)
3. Add tests for new functionality
4. Update the README.md if user-facing changes are made

---

© 2026 Alia - The Agent Era
