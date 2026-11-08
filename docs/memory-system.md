# Memory and Context Graph

Last updated: 2026-10-06

Alia keeps three kinds of memory, and none of them is shared between actors
([actors](./actors.mdx#memory-is-per-actor)):

1. **Alia's memory of the person** — preferences, long-term facts and context, in Nilo
   (below); her learned writing style stays in `user_memories`.
2. **Each agent's memory of the person** — MEMORY.md plus `memory/<topic>.md`
   files, per agent AND person (`agent_memory_documents`). Documented in
   [Agents → Memory is per actor](./agents.md#memory-is-per-actor); an agent turn
   never receives Alia's memory or her memory tools.
3. **The context graph** — where to look, what worked, and why (autonomy state,
   below).

A turn can switch all of it off: `personalization: false` on the chat request reads no memory
of either kind, recalls nothing, offers no memory tool and skips the learning hooks (writing
style, proactive suggestions) for that turn — [Embedding an agent](./agent-embedding.md) §2.

Every memory block in a prompt goes through `memoryDataBlock`
(`lib/memory/memory-prompt.ts`): it is data that informs the answer, never an
instruction.

## 1) Alia's memory of the person (Nilo)

Alia's memory of the person lives in **Nilo**, in the `memories` system database of the
person's personal workspace, where they read, edit and delete it
(`Nilo/docs/memories.md`). Alia uses it as a first-party app, like Inbox or Mention: the
catalog `nilo-memories` is registered with Oxy and Alia lists its tools with her other app
tools, calling them with an Oxy capability ticket and no consent screen.

Chat tools (Alia only, `actors: ['alia']` in the catalog): `oxy_nilo_memories__recallMemories`,
`__remember`, `__updateMemory`, `__forgetMemory`. They are **core** (`lib/tool-budget.ts`,
never deferred behind `loadTools`), and `prompts/memory.md` tells her to recall before
answering anything personal and to save durable facts as atomic memories. Nothing is
recalled automatically before the turn: recalling is the model's call.

`personalization: false` on a turn drops these tools and the memory prompt
(`lib/tool-pipeline.ts`). An agent never gets them: it keeps its own memory (§ below).

What was retired from Alia: `saveUserMemory`, `updateUserMemory`, `forgetUserMemory`,
`updateUserPreferences`, `updateUserContext`, the `memory-recall` before-chat hook, the
facts, preferences and context blocks of the system prompt, the embeddings and vector
search, the `/memory/*` routes to add, edit, search, import and export memories, and the
Settings → Memory list (it now explains where memories live and opens Nilo). The canvas
`memory` node reads and writes a Nilo memory by key (`lib/canvas/nilo-memory.ts`).

What Alia keeps (`user_memories`, `GET /memory`, `PUT /memory/preferences|settings`): the
answer preferences the person chose (language, tone, response length), the
"Use in AI responses" toggle, and the learned writing style. Those are settings, not
memories. Language, tone and response length still reach the prompt; nothing else about
the person does.

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
- `AUTONOMY_ROLLBACK_ENABLED`
- `AUTONOMY_OXY_EVENTS_ENABLED`

All default to enabled unless explicitly disabled.
