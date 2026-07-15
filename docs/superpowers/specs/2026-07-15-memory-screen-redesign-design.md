# Memory screen redesign — design

Status: approved for planning
Date: 2026-07-15

## Goal

Redesign Alia's memory settings screen (`packages/app/app/(app)/settings/memory.tsx`) around a grouped table layout (You / Topics / People), inspired by a reference NativeWind mockup of Claude's own memory settings page. This requires restructuring the underlying data model — not just the UI — plus adding two real on/off settings and an "import memory from another AI provider" flow that reuses Alia's existing chat tool-calling infrastructure instead of a bespoke parser.

## Current state (verified)

- **Screen**: `packages/app/app/(app)/settings/memory.tsx` (1072 lines) — flat `ScrollView` + `.map()` list of `MemoryRow`, no table component, no grouping. Category filter is a horizontal `ToggleGroup` chip row.
- **Client type**: `Memory { _id, key, value, category?, createdAt, updatedAt }`.
- **Server model**: `IUserMemory.memories: {key, value, category?, createdAt, updatedAt}[]` (`packages/api/src/models/user-memory.ts:98-124`). No `type`/grouping concept. No settings/toggle field anywhere on the model.
- **Routes**: `packages/api/src/routes/memory.ts` — `GET /stats`, `GET /`, `PUT /context`, `PUT /preferences`, `POST /add`, `GET /semantic-search`, `PUT /:memoryId`, `DELETE /:memoryId`, `GET /search`, `GET /duplicates`, `GET /export/{preview,json,csv}`, `POST /import/validate`, `POST /import`.
- **Auto-save already exists**: `saveUserMemoryTool` (`packages/api/src/lib/tools/user-memory.ts:14`) is a real AI SDK tool, unconditionally registered in 6 places (`chat.service.ts:240`, `agent/tools.ts:67`, `tools/index.ts:129`, `trigger-engine.ts:108`, `routes/internal.ts:182`, `voice-session-manager.ts:66-67`), description says "Use ALWAYS when user shares...". No setting gates it today.
- **Recall already exists**: `memory-recall-hook.ts` calls `recallRelevantMemories()` before the LLM call to inject existing memories into context. No setting gates it today.
- **Hover-reveal convention**: `group` + `web:opacity-0 web:group-hover:opacity-100` already used in `sidebar.tsx:631,658` and `folder-section.tsx:72,99` — reuse this for row actions, don't invent a new pattern.
- **No RN table component exists** in `packages/app` or installed `@oxyhq/bloom`. `@oxyhq/bloom`'s `SettingsList` exists but is unused anywhere in `packages/app` — not a fit here (single-row style, not columnar). Build one new NativeWind component.

## Data model changes (clean cut, no compat shim)

`IUserMemory.memories[]` entry shape:

```ts
// before
{ key: string; value: string; category?: string; createdAt: Date; updatedAt: Date }

// after
{ title: string; summary: string; type: 'profile' | 'topic' | 'person'; createdAt: Date; updatedAt: Date }
```

- `key` → `title`: still the per-user uniqueness key (case-insensitive, trimmed match on write — same `findIndex` semantics as today), but now expected to be a short human-readable display label ("Food", "Messaging", a person's name) rather than a snake_case identifier. This is a real behavior change in what the model writes — see tool description update below.
- `value` → `summary`.
- `category` (free-text: preferencia/personal/trabajo/objetivo/experiencia) → removed, replaced by `type` enum.
- `IUserMemory.settings` (new): `{ autoSaveEnabled: boolean; recallEnabled: boolean }`, both default `true`.

**Migration** (one-time script, run before deploying the new API build):
- `personal` → `type: 'profile'`
- `preferencia`/`preference`, `trabajo`/`work`, `objetivo`/`goal`, `experiencia`/`experience`, unset/`default` → `type: 'topic'`
- nothing auto-maps to `type: 'person'` (no reliable signal in old data) — these start as `topic` and the user can reclassify manually via the edit dialog.
- `key`→`title`, `value`→`summary` renamed in place; `category` field dropped from documents after migration.
- `settings` initialized to `{ autoSaveEnabled: true, recallEnabled: true }` on every existing `UserMemory` doc (preserves current always-on behavior — this migration doesn't silently change anyone's behavior, only exposes the toggle going forward).

**Known risk**: switching the uniqueness key from a stable snake_case identifier to a human-readable title makes exact-match dedup fragier (casing/wording drift → near-duplicate rows). Mitigation: keep the existing `/duplicates` endpoint as the safety net (already used from the UI's dedupe button) rather than building new fuzzy-matching logic — out of scope for this spec.

## Backend changes

**`saveUserMemoryTool`** (`user-memory.ts`) — zod schema and description rewritten:
```ts
inputSchema: z.object({
  title: z.string().describe('Short, human-readable label (e.g. "Food", "Occupation", a person\'s name) — NOT a snake_case key'),
  summary: z.string().describe('1-2 sentence description of what to remember'),
  type: z.enum(['profile', 'topic', 'person']).describe(
    'profile = a fact about the user themself; topic = a subject/interest/project; person = someone in the user\'s life'
  ),
})
```
`execute()` keeps the same find-by-title(trimmed, case-insensitive)-then-update-or-push-with-limit-check logic, just on the renamed fields. Embedding text becomes `${title}: ${summary}`.

`updateUserPreferencesTool` / `updateUserContextTool` are untouched (different fields, out of scope).

**Settings gating** — all 6 `saveUserMemoryTool` registration call sites read `memory.settings?.autoSaveEnabled ?? true` and omit the tool entirely when `false` (AI SDK tool sets accept a conditionally-omitted key, matching the existing `opts.userId ? {...} : {}` pattern already used in `chat.service.ts:240`). `memory-recall-hook.ts` checks `settings?.recallEnabled ?? true` before calling `recallRelevantMemories()`.

**New route**: `PUT /memory/settings` — body `{ autoSaveEnabled?: boolean, recallEnabled?: boolean }`, partial update, returns the full settings object.

**Existing routes updated for the field rename** (mechanical, but must be swept everywhere `key`/`value`/`category` are referenced):
- `POST /add`, `PUT /:memoryId` — body fields `title`/`summary`/`type`.
- `GET /search` — `?category=` filter becomes `?type=`.
- `GET /duplicates` — compares `title`/`summary` instead of `key`/`value`.
- `GET /export/json`, `GET /export/csv`, `POST /import/validate`, `POST /import` — schema updated to `title`/`summary`/`type`; CSV column headers change accordingly.
- `GET /semantic-search` — result shape updated, search logic unaffected (still embeddings-based).

**Import-from-other-provider** — new route `POST /memory/import/from-text`, body `{ text: string }`:
- Mirrors the exact pattern already used in `routes/internal.ts:194-204` (non-streaming `generateText`, `stopWhen: stepCountIs(N)`, N≈20 to allow several extracted memories per call).
- Tools scoped to **only** `saveUserMemoryTool(userId)` — not the full trigger tool set.
- System prompt: instructs the model to read the pasted text (expected to be a memory/context summary exported from another AI assistant) and call `saveUserMemory` once per distinct fact worth remembering, choosing `type` per the same profile/topic/person guidance.
- Response: the list of memories the model actually saved (tool already returns `{success, message, totalMemories}` per call — accumulate the successful ones from `result.toolResults`) for a confirmation UI. No new parsing/validation code — the existing plan-limit check inside the tool already applies.
- Runs regardless of `settings.autoSaveEnabled`: that flag gates passive extraction during normal chat turns, while this route is an explicit user-initiated action (they clicked "Import" and pasted text on purpose).

## Frontend changes

**New component**: `packages/app/components/settings/memory-table.tsx` — `MemoryTable` renders one section (heading + rows) given a list of memories and a `type`. Columns: Name (title) / Summary / Last updated (relative) / Actions (edit + delete, hover-reveal via the existing `group` + `web:opacity-0 web:group-hover:opacity-100` convention). NativeWind-responsive: same component renders on web and native (per your instruction — no `.web.tsx`/`.native.tsx` split), columns compress via `md:` classes on narrow screens (e.g. Summary column truncates harder or the Last-updated column hides below `md:`) rather than switching to a different component tree.

**`memory.tsx` rewrite**:
- Toolbar (search box, existing AI-search toggle — semantic vs keyword search *within the search input* — add, export/import/dedupe icon buttons) **stays as-is** — no changes to that row. This is a distinct control from the new "Search and reference chats" switch below, which governs whether memories are recalled into chat context at all; don't conflate the two in implementation or copy.
- Category `ToggleGroup` filter chips **removed** — grouping into three permanent sections replaces filtering.
- Below the toolbar: three `MemoryTable` sections in fixed order — "You" (`type=profile`), "Topics" (`type=topic`), "People" (`type=person`) — each populated by filtering the existing `memories` array client-side (single `GET /memory` fetch already in `useUserData()`, no new endpoint needed for the list itself).
- Add/Edit dialogs: fields become Title / Summary / Type (segmented control: You/Topic/Person). Clicking "+" within a specific section pre-selects that section's type.
- New settings block at the top of the screen (above the toolbar, matching the mockup's top section): two switches — "Search and reference chats" (`recallEnabled`) and "Generate memory from chats" (`autoSaveEnabled`) — calling the new `PUT /memory/settings`. Plus an "Import from other AI providers" button opening a 2-step dialog:
  1. Shows a copyable prompt template (static client-side string) asking the user to paste it into their other AI assistant and copy back the response.
  2. A paste-back textarea → on submit, calls `POST /memory/import/from-text` → shows the returned list of saved memories as confirmation, then refreshes the memory list.

**Old `MemoryRow`** (memory.tsx:1014-1072) is deleted, replaced by rows rendered inside `MemoryTable`.

## Out of scope

- Fuzzy/semantic duplicate merging beyond the existing `/duplicates` endpoint.
- Any change to `preferences`/`context`/`writingStyle` fields or their tools/routes.
- Editing memory `type` via bulk/multi-select — single-row edit only, same as today's single-row edit dialog.
- i18n copy — implementer follows whatever localization convention the rest of `packages/app/components/settings/` already uses.

## Testing

- Server: update/add tests around `saveUserMemoryTool`, `POST /add`, `GET /duplicates`, `GET /search`, export/import routes for the renamed fields; add a test for the settings-gating branch (tool absent when `autoSaveEnabled=false`) and for `POST /memory/import/from-text`.
- Migration script: dry-run against a copy of representative data, verify no data loss (`memories.length` unchanged pre/post per user) and correct type mapping.
- Client: manual verification in a real foregrounded browser tab of the three-section table, hover-reveal actions on web, and native (Expo) card rendering — per this repo's own convention that Jest doesn't catch render/layout issues.
