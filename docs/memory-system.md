# Memory and Context Graph

Last updated: 2026-10-06

Alia keeps three kinds of memory, and none of them is shared between actors
([actors](./actors.mdx#memory-is-per-actor)):

1. **Alia's memory of the person** — preferences, long-term facts, context and
   writing style (`user_memories`, `user_memory_entries` and their embeddings).
2. **Each agent's memory of the person** — MEMORY.md plus `memory/<topic>.md`
   files, per agent AND person (`agent_memory_documents`). Documented in
   [Agents → Memory is per actor](./agents.md#memory-is-per-actor); an agent turn
   never receives Alia's memory or her memory tools.
3. **The context graph** — where to look, what worked, and why (autonomy state,
   below).

Every memory block in a prompt goes through `memoryDataBlock`
(`lib/memory/memory-prompt.ts`): it is data that informs the answer, never an
instruction.

## 1) Alia's memory of the person

Service: `lib/memory/user-memory-service.ts`; recall: `lib/memory/recall.ts`.

Stores:

- memory entries (`key`, `value`, `category`), each with an embedding for recall
- `preferences` (language, tone, response length, interests)
- `context` (occupation, location, timezone, bio)
- `settings` (including `recallEnabled`, "Use in AI responses")

Chat tools (Alia only): `saveUserMemory`, `updateUserMemory`, `forgetUserMemory`
("olvida esto": the entry and its embedding), `updateUserPreferences`,
`updateUserContext`.

Main routes (`routes/memory.ts`):

- `GET /memory`, `GET /memory/stats`
- `GET /memory/agents` — every agent that remembers something about the caller
  (their files are `GET|PUT|DELETE /agents/:id/memory`, `routes/agents/memory.ts`)
- `POST /memory/add`, `PUT /memory/:memoryId`, `DELETE /memory/:memoryId`
- `PUT /memory/preferences`, `PUT /memory/context`, `PUT /memory/settings`
- `GET /memory/search`, `GET /memory/semantic-search`, `GET /memory/duplicates`
- `GET /memory/export/preview`, `GET /memory/export/json`, `GET /memory/export/csv`
- `POST /memory/import/validate`, `POST /memory/import`, `POST /memory/import/from-text`

The app shows both Alia's memory and every agent's under Settings → Memory.

### Writing style

`user_memories.writing_style` is learned after every chat by
`lib/hooks/built-in/style-learning-hook.ts` and read, edited and reset through
`/writing-style` (`GET`, `PUT`, `DELETE`, `POST /writing-style/refresh`). Once the profile is ready (`STYLE_MIN_MESSAGES`),
`SystemPromptBuilder` appends `formatStyleForPrompt`'s block to the system
message under the same gate as the rest of the memory — a direct session, and an
agent only with the `memory` grant — and additionally only while
`settings.recallEnabled` ("Use in AI responses") is on. The block is bounded by
`STYLE_PROMPT_MAX_CHARS` and tells the model to use the style only when writing
AS the person, never for Alia's own replies.

## 2) Context Graph (Autonomy)

Every chat turn runs the same loop in `lib/autonomy/runtime.ts`:

1. **classify** — detect the intent (`lib/autonomy/intents.ts`: `meeting_prep`,
   `inbox_digest`, `project_status`, `task_followup`, `monitoring`, `research`,
   `general`)
2. **recall** — load ranked context sources and learning rules for that intent
3. **retrieve** — pull data from the top sources (Oxy apps, MCP servers, integrations)
4. **act** — answer and call tools, streaming over SSE
5. **learn** — update source quality scores and persist new learning rules

| Table | Tracks | Read through |
|-------|--------|--------------|
| `context_sources` | freshness, precision, average cost, latency, failure rate of a source | `db/autonomy/contextGraphRepository.ts` |
| `context_nodes` | entities discovered during retrieval (people, projects, docs, threads) | `db/autonomy/contextGraphRepository.ts` |
| `context_edges` | relationships and confidence weights between nodes | `db/autonomy/contextGraphRepository.ts` |
| `retrieval_strategies` | per-intent source ordering and fallback paths | `db/autonomy/contextGraphRepository.ts` |
| `learning_rules` | persisted corrections, constraints, and preferences | `db/autonomy/learningRuleRepository.ts` |
| `rollback_records` | before/after state and rollback payload for `R1` writes | `db/agents/rollbackRecordRepository.ts` |

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
- `Nota: ...`
- `Remember: ...`

the runtime stores them as priority rules for future runs (`extractCorrection` in
`lib/autonomy/runtime.ts`).

## Rollback Records

For `R1` reversible writes, a rollback record (`rollback_records`) stores:

- tool name + args
- before/after state
- optional diff
- rollback action payload
- expiration window/status

## Flags

Autonomy feature flags (`lib/autonomy/flags.ts`):

- `AUTONOMY_RUNTIME_ENABLED`
- `AUTONOMY_CONTEXT_GRAPH_ENABLED`
- `AUTONOMY_APPROVALS_ENABLED`
- `AUTONOMY_ROLLBACK_ENABLED`
- `AUTONOMY_OXY_EVENTS_ENABLED`

All default to enabled unless explicitly disabled.
