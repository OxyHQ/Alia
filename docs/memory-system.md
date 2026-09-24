# Memory and Context Graph

Last updated: 2026-03-07

Alia uses two complementary persistence layers:

1. **User memory profile** (preferences + long-term facts).
2. **Context graph** (where to look, what worked, and why).

## 1) User Memory Profile

Primary model: `UserMemory`.

Stores:

- `memories[]` (`key`, `value`, `category`)
- `preferences` (language, tone, response length, interests)
- `context` (occupation, location, timezone, bio)

Main routes:

- `GET /memory`
- `GET /memory/stats`
- `POST /memory/add`
- `PUT /memory/:memoryId`
- `DELETE /memory/:memoryId`
- `PUT /memory/preferences`
- `PUT /memory/context`
- `GET /memory/search`
- `GET /memory/duplicates`
- `GET /memory/export/json`
- `GET /memory/export/csv`
- `POST /memory/import/validate`
- `POST /memory/import`

### Writing style

`user_memories.writing_style` is learned after every chat by
`lib/hooks/built-in/style-learning-hook.ts` and read, edited and reset through
`/writing-style`. Once the profile is ready (`STYLE_MIN_MESSAGES`),
`SystemPromptBuilder` appends `formatStyleForPrompt`'s block to the system
message under the same gate as the rest of the memory — a direct session, and an
agent only with the `memory` grant — and additionally only while
`settings.recallEnabled` ("Use in AI responses") is on. The block is bounded by
`STYLE_PROMPT_MAX_CHARS` and tells the model to use the style only when writing
AS the person, never for Alia's own replies.

## 2) Context Graph (Autonomy)

Models:

- `ContextSource` - tracks source quality (`freshnessScore`, `precisionScore`, `avgCostScore`, latency, failures).
- `ContextNode` - entities discovered during retrieval.
- `ContextEdge` - relationships and confidence weights.
- `RetrievalStrategy` - per-intent source paths and fallback ordering.
- `LearningRule` - persisted corrections/constraints/preferences.

Intents currently used by strategies:

- `meeting_prep`, `inbox_digest`, `project_status`, `task_followup`, `monitoring`, `research`, `general`

## Learning Cycle

After each chat run:

- Sources used are scored by success/failure and latency.
- Strategy counters are updated.
- Message-to-response graph nodes/edges are upserted.
- User corrections are saved as high-priority `LearningRule` entries.

## Corrections

If a user writes corrections like:

- `Correction: ...`
- `Corrige: ...`
- `Remember: ...`

the runtime stores them as priority rules for future runs.

## Rollback Records

For `R1` reversible writes, `RollbackRecord` stores:

- tool name + args
- before/after state
- optional diff
- rollback action payload
- expiration window/status

## Flags

Autonomy feature flags:

- `AUTONOMY_RUNTIME_ENABLED`
- `AUTONOMY_CONTEXT_GRAPH_ENABLED`
- `AUTONOMY_APPROVALS_ENABLED`
- `AUTONOMY_ROLLBACK_ENABLED`
- `AUTONOMY_OXY_EVENTS_ENABLED`

All default to enabled unless explicitly disabled.
