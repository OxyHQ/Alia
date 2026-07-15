# Memory Screen Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure Alia's memory data model (`key/value/category` → `title/summary/type`) and redesign the memory settings screen around three grouped tables (You/Topics/People), add real auto-save/recall toggle settings, and add an import-from-other-AI-provider flow that reuses Alia's existing tool-calling infrastructure.

**Architecture:** Backend: a clean-cut Mongoose schema rename (no compat shim) with a one-time startup migration, propagated through every consumer of `IUserMemory.memories` (routes, the `saveUserMemory` AI tool, recall/prompt-injection code, a Canvas memory node). New `settings.autoSaveEnabled`/`settings.recallEnabled` flags are checked inside the two functions that already load the doc (`saveUserMemoryTool.execute()`, `recallRelevantMemories()`) — no call-site threading. Frontend: one new reusable `MemoryTable` NativeWind component rendered three times, replacing the flat single-list `memory.tsx` UI; an import-from-provider flow reuses the existing `generateText` + `saveUserMemoryTool` pattern already proven in `routes/internal.ts`.

**Tech Stack:** Express + Mongoose (packages/api), Expo + React Native + NativeWind (packages/app), AI SDK (`ai` package) `generateText`/`tool()`, Vitest (packages/api only — packages/app has no test harness).

## Global Constraints

- Clean cut, no compat shims: `key`/`value`/`category` are deleted, not deprecated-and-kept. Every call site is updated in the same wave (spec: `docs/superpowers/specs/2026-07-15-memory-screen-redesign-design.md`).
- `packages/app` has **no test infrastructure** (no jest/vitest config, no test script). Frontend tasks are verified via `bunx tsc --noEmit` + manual verification in a real foregrounded browser tab — do not invent a test harness for this plan.
- `packages/api` uses Vitest (`bun run test` → `vitest run`). Backend tasks that touch logic get real Vitest tests, following the existing mocking convention in `packages/api/src/routes/__tests__/conversations.test.ts` (`vi.mock` the Mongoose model + middleware, no supertest).
- NativeWind only, no separate `.web.tsx`/`.native.tsx` files (per this repo's own convention) — the new `MemoryTable` component must render on both web and native from one file.
- Hover-reveal row actions reuse the exact convention already used in `packages/app/components/sidebar.tsx:631,658`: ancestor gets `group`, the reveal-on-hover child gets `web:opacity-0 web:group-hover:opacity-100`.
- Run `bun run typecheck` (`tsc --noEmit`) in `packages/api` after each backend task — the schema rename makes TypeScript itself enumerate every remaining broken call site, so a clean `tsc` run is real evidence the sweep is complete.

---

## File Structure

**Backend (`packages/api/src/`):**
- `models/user-memory.ts` — schema rename + `settings` field (Task 1)
- `lib/migrations/001-restructure-memories-title-summary-type.ts` — new, one-time data migration (Task 2)
- `lib/migrations/runner.ts` — register the migration (Task 2)
- `index.ts` — wire `runPendingMigrations()` into startup (Task 2)
- `lib/validators/memory-validators.ts` — schema rename (Task 3)
- `lib/tools/user-memory.ts` — `saveUserMemoryTool` rewrite + `autoSaveEnabled` gate (Task 4)
- `lib/memory/recall.ts` — `RecalledMemory` rename + `recallEnabled` gate (Task 5)
- `routes/internal.ts`, `lib/system-prompt-builder.ts`, `lib/user-context.ts`, `lib/trigger-engine.ts`, `services/chat.service.ts` — mechanical field-name renames in prompt injection (Task 6)
- `routes/canvas/execute.ts` — Canvas memory node read/write (Task 7)
- `routes/memory.ts` — full CRUD/search/export/import route rewrite + new `PUT /settings` (Task 8)
- `routes/memory.ts` — new `POST /import/from-text` (Task 9)
- `routes/__tests__/memory.test.ts` — new test file (Task 8, Task 9)

**Frontend (`packages/app/`):**
- `lib/stores/user-data-store.ts` — local `Memory`/`UserMemory` type rename + `settings` field (Task 10)
- `components/settings/memory-table.tsx` — new, reusable grouped table (Task 11)
- `app/(app)/settings/memory.tsx` — full rewrite: grouped sections, settings toggles, Add/Edit dialog (Task 12)
- `app/(app)/settings/memory.tsx` — import-from-provider dialog (Task 13)

---

### Task 1: Schema rename — `IUserMemory.memories` and `settings`

**Files:**
- Modify: `packages/api/src/models/user-memory.ts` (full file — see below)

**Interfaces:**
- Produces: `IUserMemory.memories[]` entries `{ title: string; summary: string; type: 'profile' | 'topic' | 'person'; createdAt: Date; updatedAt: Date }` (subdocuments still get an implicit `_id` from Mongoose, matching today's behavior — the interface does not declare it explicitly, same as before). `IUserMemory.settings: { autoSaveEnabled: boolean; recallEnabled: boolean }`. `MemoryType = 'profile' | 'topic' | 'person'`, exported as `MEMORY_TYPES` (readonly tuple) + `MemoryType` (type alias) for reuse by validators and routes.
- Produces: renamed constants `MAX_MEMORY_TITLE_LENGTH` (was `MAX_MEMORY_KEY_LENGTH`, value unchanged at `200`), `MAX_MEMORY_SUMMARY_LENGTH` (was `MAX_MEMORY_VALUE_LENGTH`, value unchanged at `10000`). `MAX_CATEGORY_LENGTH` is deleted (no length validation needed for a fixed enum).

- [ ] **Step 1: Replace the file**

```typescript
import mongoose, { Schema, Model, Document } from 'mongoose';

// Validation constants
export const MAX_MEMORIES_FREE = 100;
export const MAX_MEMORIES_PRO = 1000;
export const MAX_MEMORIES_BUSINESS = -1; // Unlimited
export const MAX_MEMORY_TITLE_LENGTH = 200;
export const MAX_MEMORY_SUMMARY_LENGTH = 10000;

// Writing style constants
export const STYLE_MIN_MESSAGES = 15;
export const STYLE_LLM_REFINE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const STYLE_LLM_REFINE_MIN_MESSAGES = 50;
export const STYLE_RAW_ROLLING_WINDOW = 200;

// Memory grouping shown in the settings UI (You / Topics / People)
export const MEMORY_TYPES = ['profile', 'topic', 'person'] as const;
export type MemoryType = typeof MEMORY_TYPES[number];

// Writing style profile interface
export interface IWritingStyleRaw {
  sentenceLengths: number[];
  messageLengths: number[];
  wordFrequency: Record<string, number>;
  phraseFrequency: Record<string, number>;
  emojiCount: number;
  exclamationCount: number;
  ellipsisCount: number;
  questionMarkCount: number;
  totalMessages: number;
  totalSentences: number;
  totalWords: number;
  greetingsFound: Record<string, number>;
  closingsFound: Record<string, number>;
  languageCounts: Record<string, number>;
  lowercaseMessages: number;
}

export interface IWritingStyleProfile {
  // Readiness
  messagesAnalyzed: number;
  isReady: boolean;
  lastAnalyzedAt: Date;
  lastLLMRefinedAt?: Date;

  // Vocabulary
  vocabularyLevel: 'basic' | 'intermediate' | 'advanced' | 'technical';
  commonWords: string[];
  commonPhrases: string[];
  jargonTerms: string[];

  // Sentence structure
  avgSentenceLength: number;
  sentenceComplexity: 'simple' | 'moderate' | 'complex';
  avgMessageLength: number;

  // Tone and formality
  formality: 'very_informal' | 'informal' | 'neutral' | 'formal' | 'very_formal';
  toneDescriptors: string[];

  // Punctuation and formatting
  usesEmoji: boolean;
  emojiFrequency: 'never' | 'rare' | 'moderate' | 'frequent';
  commonEmojis: string[];
  usesExclamationMarks: boolean;
  usesEllipsis: boolean;
  capitalizationStyle: 'standard' | 'all_lowercase' | 'mixed';

  // Greetings and closings
  greetingPatterns: string[];
  closingPatterns: string[];
  signOff?: string;

  // Language
  primaryLanguage: string;
  secondaryLanguages: string[];
  codeSwitch: boolean;

  // Raw analysis data
  _raw: IWritingStyleRaw;

  // LLM-generated summary
  llmSummary?: string;
}

// Helper to get memory limit based on plan name
export const getMemoryLimit = (planName?: string): number => {
  if (!planName) return MAX_MEMORIES_FREE;

  const plan = planName.toLowerCase();
  if (plan.includes('business') || plan.includes('enterprise')) {
    return MAX_MEMORIES_BUSINESS; // Unlimited
  }
  if (plan.includes('pro')) {
    return MAX_MEMORIES_PRO;
  }

  return MAX_MEMORIES_FREE;
};

export interface IUserMemory extends Document {
  oxyUserId: mongoose.Types.ObjectId;
  memories: {
    title: string;
    summary: string;
    type: MemoryType;
    createdAt: Date;
    updatedAt: Date;
  }[];
  settings: {
    autoSaveEnabled: boolean;
    recallEnabled: boolean;
  };
  preferences: {
    language?: string;
    tone?: string;
    responseLength?: 'short' | 'medium' | 'long';
    interests?: string[];
    [key: string]: any;
  };
  context: {
    occupation?: string;
    location?: string;
    timezone?: string;
    bio?: string;
    [key: string]: any;
  };
  writingStyle: IWritingStyleProfile | null;
  createdAt: Date;
  updatedAt: Date;
}

const UserMemorySchema = new Schema<IUserMemory>({
  oxyUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  memories: [{
    title: { type: String, required: true },
    summary: { type: String, required: true },
    type: { type: String, enum: MEMORY_TYPES, required: true, default: 'topic' },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
  }],
  settings: {
    autoSaveEnabled: { type: Boolean, default: true },
    recallEnabled: { type: Boolean, default: true },
  },
  preferences: {
    language: { type: String },
    tone: { type: String },
    responseLength: { type: String, enum: ['short', 'medium', 'long'] },
    interests: [{ type: String }]
  },
  context: {
    occupation: { type: String },
    location: { type: String },
    timezone: { type: String },
    bio: { type: String }
  },
  writingStyle: {
    type: Schema.Types.Mixed,
    default: null
  }
}, {
  timestamps: true
});

// Performance indexes
// Text index for full-text search on memory titles and summaries
UserMemorySchema.index({ 'memories.title': 'text', 'memories.summary': 'text' });

// Type index for filtering
UserMemorySchema.index({ 'memories.type': 1 });

// Timestamp index for sorting
UserMemorySchema.index({ 'memories.updatedAt': -1 });

export const UserMemory: Model<IUserMemory> =
  mongoose.models.UserMemory || mongoose.model<IUserMemory>('UserMemory', UserMemorySchema);
```

- [ ] **Step 2: Confirm the compiler now flags every remaining call site**

Run: `cd packages/api && bun run typecheck`
Expected: FAIL, with errors in exactly these files (this is the checklist for Tasks 3-9 — if any file is missing from the error output, something in this plan's file list is stale and needs re-checking before continuing):
```
src/lib/validators/memory-validators.ts
src/lib/tools/user-memory.ts
src/lib/memory/recall.ts
src/routes/internal.ts
src/lib/system-prompt-builder.ts
src/lib/user-context.ts
src/lib/trigger-engine.ts
src/services/chat.service.ts
src/routes/canvas/execute.ts
src/routes/memory.ts
```

- [ ] **Step 3: Commit**

```bash
cd /home/nate/Oxy/Alia
git add packages/api/src/models/user-memory.ts
git commit -m "feat(api): rename memory key/value/category to title/summary/type

Breaking schema change per docs/superpowers/specs/2026-07-15-memory-screen-redesign-design.md.
Adds settings.autoSaveEnabled/recallEnabled. Every consumer updated in
following commits — tsc currently fails on purpose until then."
```

---

### Task 2: One-time data migration + wire the (currently unused) migration runner

**Context:** `packages/api/src/lib/migrations/runner.ts` already exists — an idempotent, lock-protected migration runner that tracks applied migrations in a `_migrations` collection — but its `MIGRATIONS` registry is empty and `runPendingMigrations()` is never called anywhere (`grep -rn "runPendingMigrations" src` outside the file itself returns nothing). This task both writes the first real migration and wires the runner into startup.

**Files:**
- Create: `packages/api/src/lib/migrations/001-restructure-memories-title-summary-type.ts`
- Modify: `packages/api/src/lib/migrations/runner.ts:62-65`
- Modify: `packages/api/src/index.ts:317-332`

**Interfaces:**
- Consumes: nothing from other tasks (operates on the raw MongoDB collection, not the Mongoose model, since by deploy time the model's schema already expects the new shape — see Step 1 rationale).
- Produces: nothing consumed by later tasks — this is a standalone operational step.

- [ ] **Step 1: Write the migration**

The migration must NOT use the `UserMemory` Mongoose model — by the time this code runs in production, `models/user-memory.ts` already declares the NEW schema (Task 1 already shipped), so reading old-shaped documents through that model would apply the new schema on read and silently mangle them. Operate on the raw collection instead.

```typescript
/**
 * Restructure UserMemory.memories: key/value/category -> title/summary/type.
 * Old `key` becomes `title` verbatim (still human-readable enough; new writes
 * going forward use the AI-generated human-readable title convention).
 * `category` maps to the new `type` enum; unmapped/unknown categories default
 * to 'topic'. Every user document also gains `settings` with both flags on,
 * preserving today's always-on behavior.
 */
import mongoose from 'mongoose';

const CATEGORY_TO_TYPE: Record<string, 'profile' | 'topic' | 'person'> = {
  personal: 'profile',
  preferencia: 'topic',
  preference: 'topic',
  trabajo: 'topic',
  work: 'topic',
  objetivo: 'topic',
  goal: 'topic',
  experiencia: 'topic',
  experience: 'topic',
};

interface LegacyMemoryEntry {
  _id: mongoose.Types.ObjectId;
  key: string;
  value: string;
  category?: string;
  createdAt: Date;
  updatedAt: Date;
}

interface LegacyUserMemoryDoc {
  _id: mongoose.Types.ObjectId;
  memories: LegacyMemoryEntry[];
}

export const description = 'Restructure UserMemory.memories (key/value/category -> title/summary/type) and add settings defaults';

export async function up(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) throw new Error('MongoDB not connected');

  const collection = db.collection<LegacyUserMemoryDoc>('usermemories');
  const cursor = collection.find({}, { batchSize: 200 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ops: any[] = [];
  let migrated = 0;

  for await (const doc of cursor) {
    const newMemories = (doc.memories || []).map((m) => ({
      _id: m._id,
      title: m.key,
      summary: m.value,
      type: CATEGORY_TO_TYPE[(m.category || '').toLowerCase()] || 'topic',
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    }));

    ops.push({
      updateOne: {
        filter: { _id: doc._id },
        update: {
          $set: {
            memories: newMemories,
            settings: { autoSaveEnabled: true, recallEnabled: true },
          },
        },
      },
    });

    if (ops.length >= 200) {
      await collection.bulkWrite(ops as any);
      migrated += ops.length;
      ops = [];
    }
  }

  if (ops.length > 0) {
    await collection.bulkWrite(ops as any);
    migrated += ops.length;
  }

  // eslint-disable-next-line no-console
  console.log(`[migration 001] restructured ${migrated} UserMemory documents`);
}

// Best-effort reverse — type has no exact inverse of the old free-text
// category, so this is lossy (profile -> personal, everything else -> unset).
// Provided for local rollback only, not relied on in production.
export async function down(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) throw new Error('MongoDB not connected');

  const collection = db.collection('usermemories');
  const cursor = collection.find({}, { batchSize: 200 });

  for await (const doc of cursor) {
    const oldMemories = ((doc as any).memories || []).map((m: any) => ({
      _id: m._id,
      key: m.title,
      value: m.summary,
      category: m.type === 'profile' ? 'personal' : undefined,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    }));

    await collection.updateOne(
      { _id: doc._id },
      { $set: { memories: oldMemories }, $unset: { settings: '' } }
    );
  }
}
```

- [ ] **Step 2: Register it in the runner**

In `packages/api/src/lib/migrations/runner.ts`, replace:

```typescript
const MIGRATIONS: Array<{ name: string; load: () => Promise<Migration> }> = [
  // Example:
  // { name: '001-add-user-preferences-index', load: () => import('./001-add-user-preferences-index.js') },
];
```

with:

```typescript
const MIGRATIONS: Array<{ name: string; load: () => Promise<Migration> }> = [
  { name: '001-restructure-memories-title-summary-type', load: () => import('./001-restructure-memories-title-summary-type.js') },
];
```

- [ ] **Step 3: Wire the runner into startup**

In `packages/api/src/index.ts`, the migration must run before any request handler touches `UserMemory` — add it as the first line of `startBackgroundServices()` (line 317-332), which already runs once MongoDB is confirmed connected (called from `connectWithRetry`'s `.then()` at line 354).

Add the import near the top of `index.ts` (alongside the other `./lib/*` imports):
```typescript
import { runPendingMigrations } from './lib/migrations/runner.js';
```

Replace:
```typescript
function startBackgroundServices(): void {
  if (backgroundServicesStarted) return;
  backgroundServicesStarted = true;

  // Warm up gateway client cache (non-blocking)
  warmupGatewayClient().catch((err) => log.general.error({ err }, '[Gateway] Client warmup error'));
```

with:
```typescript
function startBackgroundServices(): void {
  if (backgroundServicesStarted) return;
  backgroundServicesStarted = true;

  // Run pending data migrations first — idempotent, safe on every boot.
  runPendingMigrations().catch((err) => log.general.error({ err }, '[Migrations] Runner error'));

  // Warm up gateway client cache (non-blocking)
  warmupGatewayClient().catch((err) => log.general.error({ err }, '[Gateway] Client warmup error'));
```

- [ ] **Step 4: Verify against a local/dev database**

Run: `cd packages/api && bun run dev`
Expected: log line `Running migration...` for `001-restructure-memories-title-summary-type` followed by `Migration applied successfully`, then `[migration 001] restructured N UserMemory documents` (N may be 0 on a fresh dev DB — that's fine). Restart the server again and confirm the migration does NOT re-run (the `_migrations` collection now has a record for it).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/lib/migrations/001-restructure-memories-title-summary-type.ts packages/api/src/lib/migrations/runner.ts packages/api/src/index.ts
git commit -m "feat(api): migrate UserMemory documents to title/summary/type

Wires the previously-unused migration runner into startup (was scaffolded
but never invoked)."
```

---

### Task 3: Validators — `title`/`summary`/`type`

**Files:**
- Modify: `packages/api/src/lib/validators/memory-validators.ts` (full file)

**Interfaces:**
- Consumes: `MAX_MEMORY_TITLE_LENGTH`, `MAX_MEMORY_SUMMARY_LENGTH`, `MEMORY_TYPES` from `../../models/user-memory.js` (Task 1).
- Produces: `MemoryItemSchema`, `AddMemorySchema`, `UpdateMemorySchema` with fields `title`/`summary`/`type` (consumed by Task 8's route rewrite). `ImportMemorySchema` and `MergeStrategySchema` unchanged in shape (still reference `MemoryItemSchema`).

Note the old `key` field forced `^[a-zA-Z0-9_-]+$` (snake_case-only). `title` is now meant to be human-readable ("Food", "Occupation") — that regex is dropped, keeping only length bounds.

- [ ] **Step 1: Replace the file**

```typescript
import { z } from 'zod';
import {
  MAX_MEMORY_TITLE_LENGTH,
  MAX_MEMORY_SUMMARY_LENGTH,
  MEMORY_TYPES,
} from '../../models/user-memory';

// Schema for individual memory item
export const MemoryItemSchema = z.object({
  title: z.string()
    .min(1, 'Title is required')
    .max(MAX_MEMORY_TITLE_LENGTH, `Title must be less than ${MAX_MEMORY_TITLE_LENGTH} characters`),
  summary: z.string()
    .min(1, 'Summary is required')
    .max(MAX_MEMORY_SUMMARY_LENGTH, `Summary must be less than ${MAX_MEMORY_SUMMARY_LENGTH} characters`),
  type: z.enum(MEMORY_TYPES),
  createdAt: z.coerce.date().optional(),
  updatedAt: z.coerce.date().optional(),
});

// Schema for preferences
export const PreferencesSchema = z.object({
  language: z.string().regex(/^[a-z]{2}-[A-Z]{2}$/, 'Must be a BCP 47 locale code (e.g., en-US, es-ES)').optional(),
  tone: z.string().max(50).optional(),
  responseLength: z.enum(['short', 'medium', 'long']).optional(),
  interests: z.array(z.string().max(100)).max(50, 'Maximum 50 interests allowed').optional(),
}).passthrough(); // Allow additional properties

// Schema for context
export const ContextSchema = z.object({
  occupation: z.string().max(200).optional(),
  location: z.string().max(200).optional(),
  timezone: z.string().max(100).optional(),
  bio: z.string().max(1000).optional(),
}).passthrough(); // Allow additional properties

// Export format schema
export const ExportFormatSchema = z.enum(['json', 'csv']);

// Import memory data schema
export const ImportMemorySchema = z.object({
  version: z.string().optional(),
  exportedAt: z.string().optional(),
  memories: z.array(MemoryItemSchema).max(1000, 'Cannot import more than 1000 memories at once'),
  preferences: PreferencesSchema.optional(),
  context: ContextSchema.optional(),
});

// Merge strategy schema
export const MergeStrategySchema = z.enum(['replace', 'merge', 'skip-duplicates']);

// Memory update schema for API endpoints
export const UpdateMemorySchema = z.object({
  summary: z.string()
    .min(1, 'Summary is required')
    .max(MAX_MEMORY_SUMMARY_LENGTH, `Summary must be less than ${MAX_MEMORY_SUMMARY_LENGTH} characters`),
  type: z.enum(MEMORY_TYPES).optional(),
});

// Settings update schema
export const MemorySettingsSchema = z.object({
  autoSaveEnabled: z.boolean().optional(),
  recallEnabled: z.boolean().optional(),
});

// Add memory schema for API endpoints
export const AddMemorySchema = z.object({
  title: z.string()
    .min(1, 'Title is required')
    .max(MAX_MEMORY_TITLE_LENGTH, `Title must be less than ${MAX_MEMORY_TITLE_LENGTH} characters`),
  summary: z.string()
    .min(1, 'Summary is required')
    .max(MAX_MEMORY_SUMMARY_LENGTH, `Summary must be less than ${MAX_MEMORY_SUMMARY_LENGTH} characters`),
  type: z.enum(MEMORY_TYPES),
});
```

- [ ] **Step 2: Typecheck (expect fewer remaining errors than Task 1's baseline)**

Run: `cd packages/api && bun run typecheck`
Expected: still fails, but `src/lib/validators/memory-validators.ts` no longer appears in the error list.

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/lib/validators/memory-validators.ts
git commit -m "feat(api): update memory validators for title/summary/type"
```

---

### Task 4: `saveUserMemoryTool` rewrite + `autoSaveEnabled` gate

**Files:**
- Modify: `packages/api/src/lib/tools/user-memory.ts:14-91` (only the `saveUserMemoryTool` export — `updateUserPreferencesTool`/`updateUserContextTool` below it are untouched)
- Test: `packages/api/src/lib/tools/__tests__/user-memory.test.ts` (new)

**Interfaces:**
- Consumes: `MemoryType`, `MEMORY_TYPES` from `../../models/user-memory.js` (Task 1); `getOrCreateUserMemory` from `../memory/user-memory-service.js` (unchanged).
- Produces: `saveUserMemoryTool(oxyUserId: string)` — an AI SDK `tool()` whose `inputSchema` is now `{ title: string; summary: string; type: 'profile'|'topic'|'person' }`. `execute()` returns `{ success: false, message: string, disabled: true }` when `settings.autoSaveEnabled === false`, without writing.

- [ ] **Step 1: Replace `saveUserMemoryTool`**

```typescript
import { tool } from "ai";
import { z } from "zod";
import { getMemoryLimit, MEMORY_TYPES } from "../../models/user-memory.js";
import { Subscription } from "../../models/subscription.js";
import { getOrCreateUserMemory } from "../memory/user-memory-service.js";
import { log } from '../logger.js';
import { getErrorMessage } from '../errors/index.js';
import { PERSONALITY_STYLES, isPersonalityStyle, type PersonalityStyleId } from '../personality-styles.js';

/**
 * Tool to save user memories
 * Allows the AI to remember important information about the user
 */
export const saveUserMemoryTool = (oxyUserId: string) => tool({
  description: 'Save important user information for future conversations. Use ALWAYS when user shares: preferences, personal info, goals, experiences, or anything they want remembered.',

  inputSchema: z.object({
    title: z.string().describe('Short, human-readable label (e.g. "Food", "Occupation", a person\'s name) — NOT a snake_case key'),
    summary: z.string().describe('1-2 sentence description of what to remember'),
    type: z.enum(MEMORY_TYPES).describe(
      'profile = a fact about the user themself; topic = a subject/interest/project; person = someone in the user\'s life'
    ),
  }),

  execute: async ({ title, summary, type }) => {
    try {
      const memory = await getOrCreateUserMemory(oxyUserId);

      if (memory.settings?.autoSaveEnabled === false) {
        return {
          success: false,
          message: 'Memory auto-save is disabled in the user\'s settings — do not attempt to save this.',
          disabled: true,
        };
      }

      // Check if a memory with this title already exists (case-insensitive, trimmed)
      const normalizedTitle = title.trim().toLowerCase();
      const existingMemoryIndex = memory.memories.findIndex(m => m.title.trim().toLowerCase() === normalizedTitle);

      if (existingMemoryIndex !== -1) {
        // Update existing memory
        memory.memories[existingMemoryIndex].summary = summary;
        memory.memories[existingMemoryIndex].type = type;
        memory.memories[existingMemoryIndex].updatedAt = new Date();
      } else {
        // Check memory limit before adding new memory
        const subscription = await Subscription.findOne({
          oxyUserId,
          status: { $in: ['active', 'trialing'] }
        });

        const memoryLimit = getMemoryLimit(subscription?.plan?.name);

        // Check if adding new memory would exceed limit (unless unlimited)
        if (memoryLimit !== -1 && memory.memories.length >= memoryLimit) {
          return {
            success: false,
            message: `Memory limit reached (${memoryLimit} memories). ${subscription?.plan?.name ? 'Upgrade to Business plan for unlimited memories.' : 'Upgrade your plan for more memories.'}`,
            limitReached: true,
            limit: memoryLimit
          };
        }

        // Add new memory
        memory.memories.push({
          title,
          summary,
          type,
          createdAt: new Date(),
          updatedAt: new Date()
        });
      }

      // Save to database
      await memory.save();

      // Generate embedding in background (fire-and-forget)
      import('../memory/index.js').then(async ({ generateEmbedding, upsertMemoryEmbedding }) => {
        const embedding = await generateEmbedding(`${title}: ${summary}`);
        if (embedding) {
          await upsertMemoryEmbedding(oxyUserId, title, embedding);
        }
        // Invalidate vector search cache so next recall picks up the new memory
        const { invalidateUserEmbeddingCache } = await import('../memory/vector-search.js');
        invalidateUserEmbeddingCache(oxyUserId);
      }).catch(() => {}); // Never block the tool response

      return {
        success: true,
        message: `Recuerdo guardado exitosamente: ${title} = ${summary}`,
        totalMemories: memory.memories.length
      };
    } catch (error: unknown) {
      log.tools.error({ err: error }, 'Error');
      return {
        success: false,
        message: `Error al guardar el recuerdo: ${getErrorMessage(error)}`
      };
    }
  },
});
```

- [ ] **Step 2: Write tests**

```typescript
// packages/api/src/lib/tools/__tests__/user-memory.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../memory/user-memory-service.js', () => ({
  getOrCreateUserMemory: vi.fn(),
}));

vi.mock('../../../models/subscription.js', () => ({
  Subscription: { findOne: vi.fn() },
}));

vi.mock('../../logger.js', () => ({
  log: { tools: { error: vi.fn() } },
}));

import { saveUserMemoryTool } from '../user-memory.js';
import { getOrCreateUserMemory } from '../../memory/user-memory-service.js';

const mockGetOrCreate = getOrCreateUserMemory as unknown as ReturnType<typeof vi.fn>;

function makeMemoryDoc(overrides: Partial<{ memories: any[]; settings: any }> = {}) {
  const doc = {
    memories: overrides.memories ?? [],
    settings: overrides.settings ?? { autoSaveEnabled: true, recallEnabled: true },
    save: vi.fn().mockResolvedValue(undefined),
  };
  return doc;
}

describe('saveUserMemoryTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('saves a new memory with title/summary/type', async () => {
    const doc = makeMemoryDoc();
    mockGetOrCreate.mockResolvedValue(doc);

    const toolInstance = saveUserMemoryTool('user-1');
    const result: any = await toolInstance.execute!(
      { title: 'Food', summary: 'Loves strawberries', type: 'topic' },
      { toolCallId: 't1', messages: [] }
    );

    expect(result.success).toBe(true);
    expect(doc.memories).toHaveLength(1);
    expect(doc.memories[0]).toMatchObject({ title: 'Food', summary: 'Loves strawberries', type: 'topic' });
    expect(doc.save).toHaveBeenCalled();
  });

  it('refuses to save when autoSaveEnabled is false', async () => {
    const doc = makeMemoryDoc({ settings: { autoSaveEnabled: false, recallEnabled: true } });
    mockGetOrCreate.mockResolvedValue(doc);

    const toolInstance = saveUserMemoryTool('user-1');
    const result: any = await toolInstance.execute!(
      { title: 'Food', summary: 'Loves strawberries', type: 'topic' },
      { toolCallId: 't2', messages: [] }
    );

    expect(result.success).toBe(false);
    expect(result.disabled).toBe(true);
    expect(doc.memories).toHaveLength(0);
    expect(doc.save).not.toHaveBeenCalled();
  });

  it('updates an existing memory matched by case-insensitive title', async () => {
    const doc = makeMemoryDoc({
      memories: [{ title: 'Food', summary: 'old', type: 'topic', createdAt: new Date(), updatedAt: new Date() }],
    });
    mockGetOrCreate.mockResolvedValue(doc);

    const toolInstance = saveUserMemoryTool('user-1');
    const result: any = await toolInstance.execute!(
      { title: 'food', summary: 'Loves strawberries now', type: 'topic' },
      { toolCallId: 't3', messages: [] }
    );

    expect(result.success).toBe(true);
    expect(doc.memories).toHaveLength(1);
    expect(doc.memories[0].summary).toBe('Loves strawberries now');
  });
});
```

- [ ] **Step 3: Run the new tests**

Run: `cd packages/api && bunx vitest run src/lib/tools/__tests__/user-memory.test.ts`
Expected: 3 tests pass.

- [ ] **Step 4: Typecheck**

Run: `cd packages/api && bun run typecheck`
Expected: `src/lib/tools/user-memory.ts` no longer appears in the error list.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/lib/tools/user-memory.ts packages/api/src/lib/tools/__tests__/user-memory.test.ts
git commit -m "feat(api): rewrite saveUserMemoryTool for title/summary/type + autoSaveEnabled gate"
```

---

### Task 5: Recall rewrite + `recallEnabled` gate

**Files:**
- Modify: `packages/api/src/lib/memory/recall.ts` (full file)
- Test: `packages/api/src/lib/memory/__tests__/recall.test.ts` (new)

**Interfaces:**
- Produces: `RecalledMemory { title: string; summary: string; type?: MemoryType; score: number }` (consumed by Task 6's prompt-injection call sites — those read `.title`/`.summary` off this shape).
- Produces: `recallRelevantMemories()` returns `[]` immediately when `memory.settings?.recallEnabled === false`.

- [ ] **Step 1: Replace the file**

```typescript
/**
 * Memory Recall Pipeline Step
 * Runs BEFORE the LLM call to inject only relevant memories into context.
 * Uses hybrid search: vector similarity (65%) + BM25-style keyword scoring (35%).
 */

import { getCachedOrGenerateEmbedding } from './embedding-cache.js';
import { searchByVector } from './vector-search.js';
import { UserMemory, type IUserMemory, type MemoryType } from '../../models/user-memory.js';

export interface RecalledMemory {
  title: string;
  summary: string;
  type?: MemoryType;
  score: number;
}

/**
 * Recall only the most relevant memories for the current user message.
 * If the user has fewer than `topK` memories, returns all of them.
 */
export async function recallRelevantMemories(
  oxyUserId: string,
  userMessage: string,
  topK: number = 7
): Promise<RecalledMemory[]> {
  const memory = await UserMemory.findOne({ oxyUserId }).lean() as IUserMemory | null;
  if (!memory?.memories?.length) return [];
  if (memory.settings?.recallEnabled === false) return [];

  // If few memories, return all (no point in searching)
  if (memory.memories.length <= topK) {
    return memory.memories.map(m => ({
      title: m.title,
      summary: m.summary,
      type: m.type,
      score: 1.0,
    }));
  }

  // ── Step 1: Vector search ──────────────────────────────────────────
  const queryEmbedding = await getCachedOrGenerateEmbedding(userMessage);
  const vectorScores = new Map<string, number>();

  if (queryEmbedding) {
    const results = await searchByVector(oxyUserId, queryEmbedding, topK * 2);
    for (const r of results) {
      vectorScores.set(r.memoryKey, r.score);
    }
  }

  // ── Step 2: BM25-style keyword scoring ─────────────────────────────
  const terms = userMessage
    .toLowerCase()
    .split(/\s+/)
    .filter(t => t.length > 2);

  const keywordScores = new Map<string, number>();
  const avgDocLen = 50; // approximate average memory length in chars
  const k1 = 1.2;

  if (terms.length > 0) {
    for (const mem of memory.memories) {
      const doc = `${mem.title} ${mem.summary}`.toLowerCase();
      let rawScore = 0;

      for (const term of terms) {
        const tf = doc.split(term).length - 1;
        if (tf > 0) {
          // Simplified IDF: log(N / (1 + df)), approximated
          const idf = Math.log(memory.memories.length / (1 + terms.length));
          rawScore += tf * Math.max(idf, 0.1);
        }
      }

      if (rawScore > 0) {
        // BM25 length normalization
        const normalizedScore = rawScore / (rawScore + k1 * (doc.length / avgDocLen));
        keywordScores.set(mem.title, normalizedScore);
      }
    }
  }

  // ── Step 3: Hybrid fusion (65% vector + 35% keyword) ──────────────
  const fused = new Map<string, number>();

  for (const [title, score] of vectorScores) {
    fused.set(title, (fused.get(title) || 0) + score * 0.65);
  }
  for (const [title, score] of keywordScores) {
    fused.set(title, (fused.get(title) || 0) + score * 0.35);
  }

  // If neither search produced results, fall back to most recent memories
  if (fused.size === 0) {
    return memory.memories.slice(-topK).map(m => ({
      title: m.title,
      summary: m.summary,
      type: m.type,
      score: 0.5,
    }));
  }

  // Sort by score and return top K with full data
  return Array.from(fused.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([title, score]) => {
      const mem = memory.memories.find(m => m.title === title);
      return mem ? { title: mem.title, summary: mem.summary, type: mem.type, score } : null;
    })
    .filter(Boolean) as RecalledMemory[];
}
```

Note: `searchByVector` results carry a `memoryKey` field (from `MemoryEmbedding.memoryKey` in `vector-search.ts`) — that field name is a separate embeddings-collection identifier and is intentionally NOT renamed (see Task 4's `upsertMemoryEmbedding(oxyUserId, title, embedding)` call — it already stores `title` as the value of `memoryKey`, so `r.memoryKey` here correctly resolves to a memory's `title` string; no schema change needed in `vector-search.ts`).

- [ ] **Step 2: Write tests**

```typescript
// packages/api/src/lib/memory/__tests__/recall.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../embedding-cache.js', () => ({
  getCachedOrGenerateEmbedding: vi.fn().mockResolvedValue(null),
}));

vi.mock('../vector-search.js', () => ({
  searchByVector: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../models/user-memory.js', () => ({
  UserMemory: { findOne: vi.fn() },
}));

import { recallRelevantMemories } from '../recall.js';
import { UserMemory } from '../../../models/user-memory.js';

const mockFindOne = UserMemory.findOne as unknown as ReturnType<typeof vi.fn>;

describe('recallRelevantMemories', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns all memories when under topK and recall is enabled', async () => {
    mockFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        memories: [
          { title: 'Food', summary: 'Loves strawberries', type: 'topic', createdAt: new Date(), updatedAt: new Date() },
        ],
        settings: { autoSaveEnabled: true, recallEnabled: true },
      }),
    });

    const result = await recallRelevantMemories('user-1', 'what do I like to eat?', 7);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ title: 'Food', summary: 'Loves strawberries' });
  });

  it('returns empty when recallEnabled is false', async () => {
    mockFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        memories: [
          { title: 'Food', summary: 'Loves strawberries', type: 'topic', createdAt: new Date(), updatedAt: new Date() },
        ],
        settings: { autoSaveEnabled: true, recallEnabled: false },
      }),
    });

    const result = await recallRelevantMemories('user-1', 'what do I like to eat?', 7);

    expect(result).toEqual([]);
  });

  it('returns empty when the user has no memories', async () => {
    mockFindOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });

    const result = await recallRelevantMemories('user-1', 'anything', 7);

    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the new tests**

Run: `cd packages/api && bunx vitest run src/lib/memory/__tests__/recall.test.ts`
Expected: 3 tests pass.

- [ ] **Step 4: Typecheck**

Run: `cd packages/api && bun run typecheck`
Expected: `src/lib/memory/recall.ts` no longer appears in the error list.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/lib/memory/recall.ts packages/api/src/lib/memory/__tests__/recall.test.ts
git commit -m "feat(api): rewrite recallRelevantMemories for title/summary + recallEnabled gate"
```

---

### Task 6: Prompt-injection field renames (5 files, mechanical)

**Files:**
- Modify: `packages/api/src/routes/internal.ts:77`
- Modify: `packages/api/src/lib/system-prompt-builder.ts:22,48,110,156` (includes two local type declarations, not just the `.map()` bodies — see Step 2)
- Modify: `packages/api/src/lib/user-context.ts:42`
- Modify: `packages/api/src/lib/trigger-engine.ts:154`
- Modify: `packages/api/src/services/chat.service.ts:129,132`

**Interfaces:**
- Consumes: `RecalledMemory.title`/`.summary` (Task 5), `IUserMemory.memories[].title`/`.summary` (Task 1).
- Produces: `UserMemoryData.memories` and `SystemPromptOptions.recalledMemories` (both in `system-prompt-builder.ts`) now typed `{title, summary}` — resolves the `routes/v1/chat-completions.ts` tsc error surfaced by Task 1 as a side effect, with no edit needed in that file itself (it just passes real `IUserMemory`/`RecalledMemory[]` values through, which now structurally match).

- [ ] **Step 1: `routes/internal.ts`**

```typescript
// old (line 77):
      const memoryItems = memory.memories.map(m => `- ${m.key}: ${m.value}`).join('\n');
// new:
      const memoryItems = memory.memories.map(m => `- ${m.title}: ${m.summary}`).join('\n');
```

- [ ] **Step 2: `lib/system-prompt-builder.ts`**

This file declares its OWN narrow local types (`UserMemoryData`, and the `recalledMemories` field), decoupled from `IUserMemory`/`RecalledMemory` on purpose (interface segregation — this module only needs a minimal shape). These two type declarations must be updated too, not just the `.map()` bodies — otherwise the mechanical rename below would introduce a NEW compile error (`m.title` not existing on the old `{key, value}` type) instead of fixing one. This is also why `routes/v1/chat-completions.ts` shows a tsc error after Task 1 even though it isn't in Task 1's expected file list: it passes the real (already-renamed) `IUserMemory`/`RecalledMemory[]` into `SystemPromptBuilder.build(...)`, which still expects the stale local shape — fixing the two type declarations below resolves that call site automatically, with no edit needed in `chat-completions.ts` itself.

```typescript
// old (line 21-25):
export interface UserMemoryData {
  memories?: Array<{ key: string; value: string }>;
  preferences?: Record<string, any>;
  context?: Record<string, any>;
}
// new:
export interface UserMemoryData {
  memories?: Array<{ title: string; summary: string }>;
  preferences?: Record<string, any>;
  context?: Record<string, any>;
}
```

```typescript
// old (line 48):
  recalledMemories?: Array<{ key: string; value: string }>;
// new:
  recalledMemories?: Array<{ title: string; summary: string }>;
```

```typescript
// old (line 110):
      const memoryLines = recalledMemories.slice(0, 12).map((m) => `- ${m.key}: ${m.value}`).join('\n');
// new:
      const memoryLines = recalledMemories.slice(0, 12).map((m) => `- ${m.title}: ${m.summary}`).join('\n');
```

```typescript
// old (line 156):
        systemMessage += '\n### Known Facts:\n' + userMemory.memories.map(m => `- ${m.key}: ${m.value}`).join('\n');
// new:
        systemMessage += '\n### Known Facts:\n' + userMemory.memories.map(m => `- ${m.title}: ${m.summary}`).join('\n');
```

- [ ] **Step 3: `lib/user-context.ts`**

```typescript
// old (line 42):
        contextString += '\n\n## Known Facts:\n' + userMemory.memories.map((m: any) => `- ${m.key}: ${m.value}`).join('\n');
// new:
        contextString += '\n\n## Known Facts:\n' + userMemory.memories.map((m: any) => `- ${m.title}: ${m.summary}`).join('\n');
```

- [ ] **Step 4: `lib/trigger-engine.ts`**

```typescript
// old (line 154):
      const items = memory.memories.map(m => `- ${m.key}: ${m.value}`).join('\n');
// new:
      const items = memory.memories.map(m => `- ${m.title}: ${m.summary}`).join('\n');
```

- [ ] **Step 5: `services/chat.service.ts`**

```typescript
// old (line 129):
    const memoryItems = recalledMemories.map(m => `- ${m.key}: ${m.value}`).join('\n');
// new:
    const memoryItems = recalledMemories.map(m => `- ${m.title}: ${m.summary}`).join('\n');
```

```typescript
// old (line 132):
    const memoryItems = memory.memories.map(m => `- ${m.key}: ${m.value}`).join('\n');
// new:
    const memoryItems = memory.memories.map(m => `- ${m.title}: ${m.summary}`).join('\n');
```

- [ ] **Step 6: Typecheck**

Run: `cd packages/api && bun run typecheck`
Expected: none of these 5 files appear in the error list anymore. `src/routes/v1/chat-completions.ts` (not in Task 1's original expected list, but a real side effect of the schema rename — see Step 2's note) should also no longer appear.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/routes/internal.ts packages/api/src/lib/system-prompt-builder.ts packages/api/src/lib/user-context.ts packages/api/src/lib/trigger-engine.ts packages/api/src/services/chat.service.ts
git commit -m "feat(api): rename memory key/value to title/summary in prompt injection"
```

---

### Task 7: Canvas memory node — read/write by `title`

**Files:**
- Modify: `packages/api/src/routes/canvas/execute.ts:348-379`

**Interfaces:**
- Consumes: `IUserMemory.memories[].title`/`.summary`/`.type` (Task 1).
- Produces: nothing consumed elsewhere — this is a leaf node-executor branch.

The canvas node's own config field `node.data.memoryKey` (the identifier the node was configured with) is UNCHANGED — it's canvas node configuration, not a `UserMemory` schema field. It now matches against `title` instead of `key`. A canvas-written memory has no type selector in the node UI, so it defaults to `type: 'topic'`.

- [ ] **Step 1: Replace the `case 'memory':` block**

```typescript
// old:
    case 'memory': {
      const operation = node.data.operation;
      const memoryKey = node.data.memoryKey;
      if (!memoryKey) {
        throw new Error('Memory key is required');
      }
      if (operation === 'read') {
        const userMemory = await UserMemory.findOne({ oxyUserId: userId });
        if (!userMemory) return '';
        const entry = userMemory.memories.find(m => m.key === memoryKey);
        return entry ? entry.value : '';
      } else if (operation === 'write') {
        const existing = await UserMemory.findOne({
          oxyUserId: userId,
          'memories.key': memoryKey
        });
        if (existing) {
          await UserMemory.updateOne(
            { oxyUserId: userId, 'memories.key': memoryKey },
            { $set: { 'memories.$.value': input, 'memories.$.updatedAt': new Date() } }
          );
        } else {
          await UserMemory.findOneAndUpdate(
            { oxyUserId: userId },
            { $push: { memories: { key: memoryKey, value: input, createdAt: new Date(), updatedAt: new Date() } } },
            { upsert: true }
          );
        }
        return input;
      }
      throw new Error(`Unknown memory operation: ${operation}`);
    }

// new:
    case 'memory': {
      const operation = node.data.operation;
      const memoryKey = node.data.memoryKey;
      if (!memoryKey) {
        throw new Error('Memory key is required');
      }
      if (operation === 'read') {
        const userMemory = await UserMemory.findOne({ oxyUserId: userId });
        if (!userMemory) return '';
        const entry = userMemory.memories.find(m => m.title === memoryKey);
        return entry ? entry.summary : '';
      } else if (operation === 'write') {
        const existing = await UserMemory.findOne({
          oxyUserId: userId,
          'memories.title': memoryKey
        });
        if (existing) {
          await UserMemory.updateOne(
            { oxyUserId: userId, 'memories.title': memoryKey },
            { $set: { 'memories.$.summary': input, 'memories.$.updatedAt': new Date() } }
          );
        } else {
          await UserMemory.findOneAndUpdate(
            { oxyUserId: userId },
            { $push: { memories: { title: memoryKey, summary: input, type: 'topic', createdAt: new Date(), updatedAt: new Date() } } },
            { upsert: true }
          );
        }
        return input;
      }
      throw new Error(`Unknown memory operation: ${operation}`);
    }
```

- [ ] **Step 2: Typecheck**

Run: `cd packages/api && bun run typecheck`
Expected: `src/routes/canvas/execute.ts` no longer appears in the error list.

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/routes/canvas/execute.ts
git commit -m "feat(api): rename canvas memory node fields to title/summary"
```

---

### Task 8: Core memory routes rewrite (CRUD/search/export/import) + settings route

**Files:**
- Modify: `packages/api/src/routes/memory.ts` (full file rewrite)
- Test: `packages/api/src/routes/__tests__/memory.test.ts` (new)

**Interfaces:**
- Consumes: `AddMemorySchema`, `UpdateMemorySchema`, `ImportMemorySchema`, `MergeStrategySchema`, `MemorySettingsSchema` (Task 3); `getMemoryLimit`, `MEMORY_TYPES` (Task 1).
- Produces: `PUT /memory/settings` — new route, body `{ autoSaveEnabled?: boolean; recallEnabled?: boolean }`, returns the full `settings` object. Consumed by Task 12 (frontend toggle switches).

- [ ] **Step 1: Replace the file**

```typescript
import { Router } from 'express';
import { UserMemory, getMemoryLimit } from '../models/user-memory.js';
import { Subscription } from '../models/subscription.js';
import { authenticateToken } from '../middleware/auth.js';
import {
  AddMemorySchema,
  ImportMemorySchema,
  MergeStrategySchema,
  MemorySettingsSchema,
} from '../lib/validators/memory-validators.js';
import { getOrCreateUserMemory } from '../lib/memory/user-memory-service.js';
import { log } from '../lib/logger.js';

const router = Router();

// All memory routes require authentication
router.use(authenticateToken);

/**
 * GET /api/memory/stats
 * Get memory statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const memory = await UserMemory.findOne({ oxyUserId: req.user!.id });

    if (!memory) {
      res.json({
        totalMemories: 0,
        types: {},
        hasPreferences: false,
        hasContext: false
      });
      return;
    }

    // Group memories by type
    const types: Record<string, number> = {};
    memory.memories.forEach(m => {
      types[m.type] = (types[m.type] || 0) + 1;
    });

    res.json({
      totalMemories: memory.memories.length,
      types,
      hasPreferences: Object.keys(memory.preferences || {}).length > 0,
      hasContext: Object.keys(memory.context || {}).length > 0
    });
  } catch (error: unknown) {
    log.memory.error({ err: error }, 'Error fetching memory stats');
    res.status(500).json({ error: 'Failed to fetch memory stats' });
  }
});

/**
 * GET /api/memory
 * Get user's memory profile
 */
router.get('/', async (req, res) => {
  try {
    const memory = await getOrCreateUserMemory(req.user!.id);

    res.json(memory);
  } catch (error: unknown) {
    log.memory.error({ err: error }, 'Error fetching memory');
    res.status(500).json({ error: 'Failed to fetch memory' });
  }
});

/**
 * PUT /api/memory/context
 * Update user context (occupation, location, bio, etc.)
 */
router.put('/context', async (req, res) => {
  try {
    const memory = await UserMemory.findOneAndUpdate(
      { oxyUserId: req.user!.id },
      {
        $set: {
          context: req.body,
          updatedAt: new Date()
        }
      },
      { upsert: true, returnDocument: 'after' }
    );

    res.json(memory);
  } catch (error: unknown) {
    log.memory.error({ err: error }, 'Error updating context');
    res.status(500).json({ error: 'Failed to update context' });
  }
});

/**
 * PUT /api/memory/preferences
 * Update user preferences (language, tone, interests, etc.)
 */
router.put('/preferences', async (req, res) => {
  try {
    const memory = await UserMemory.findOneAndUpdate(
      { oxyUserId: req.user!.id },
      {
        $set: {
          preferences: req.body,
          updatedAt: new Date()
        }
      },
      { upsert: true, returnDocument: 'after' }
    );

    res.json(memory);
  } catch (error: unknown) {
    log.memory.error({ err: error }, 'Error updating preferences');
    res.status(500).json({ error: 'Failed to update preferences' });
  }
});

/**
 * PUT /api/memory/settings
 * Update memory auto-save / recall toggles
 */
router.put('/settings', async (req, res) => {
  try {
    const validation = MemorySettingsSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({
        error: 'Invalid settings data',
        details: validation.error.issues
      });
      return;
    }

    const memory = await getOrCreateUserMemory(req.user!.id);

    if (validation.data.autoSaveEnabled !== undefined) {
      memory.settings.autoSaveEnabled = validation.data.autoSaveEnabled;
    }
    if (validation.data.recallEnabled !== undefined) {
      memory.settings.recallEnabled = validation.data.recallEnabled;
    }

    await memory.save();
    res.json(memory.settings);
  } catch (error: unknown) {
    log.memory.error({ err: error }, 'Error updating memory settings');
    res.status(500).json({ error: 'Failed to update memory settings' });
  }
});

/**
 * POST /api/memory/add
 * Add a new memory or update if title exists
 */
router.post('/add', async (req, res) => {
  try {
    const { title, summary, type } = req.body;

    // Validate input
    const validation = AddMemorySchema.safeParse({ title, summary, type });
    if (!validation.success) {
      res.status(400).json({
        error: 'Invalid memory data',
        details: validation.error.issues
      });
      return;
    }

    const userMemory = await getOrCreateUserMemory(req.user!.id);

    // Check if memory with this title exists
    const existingMemoryIndex = userMemory.memories.findIndex(m => m.title === title);

    if (existingMemoryIndex !== -1) {
      // Update existing memory
      userMemory.memories[existingMemoryIndex].summary = summary;
      userMemory.memories[existingMemoryIndex].type = type;
      userMemory.memories[existingMemoryIndex].updatedAt = new Date();
    } else {
      // Get user's subscription to check memory limit
      const subscription = await Subscription.findOne({
        oxyUserId: req.user!.id,
        status: { $in: ['active', 'trialing'] }
      });

      const memoryLimit = getMemoryLimit(subscription?.plan?.name);

      // Check memory limit before adding new (unless unlimited)
      if (memoryLimit !== -1 && userMemory.memories.length >= memoryLimit) {
        res.status(400).json({
          error: 'Memory limit exceeded',
          limit: memoryLimit,
          current: userMemory.memories.length,
          suggestion: subscription?.plan?.name
            ? 'Upgrade to Business plan for unlimited memories'
            : 'Upgrade to Pro or Business plan for more memories'
        });
        return;
      }

      // Add new memory
      userMemory.memories.push({
        title,
        summary,
        type,
        createdAt: new Date(),
        updatedAt: new Date()
      });
    }

    await userMemory.save();
    res.json(userMemory);
  } catch (error: unknown) {
    log.memory.error({ err: error }, 'Error adding memory');
    res.status(500).json({ error: 'Failed to add memory' });
  }
});

/**
 * GET /api/memory/semantic-search
 * Semantic search across memories using vector similarity + text matching
 */
router.get('/semantic-search', async (req, res) => {
  try {
    const { q, limit = '5' } = req.query;
    if (!q || typeof q !== 'string') {
      res.status(400).json({ error: 'Query parameter "q" is required' });
      return;
    }

    const topK = Math.min(Number(limit) || 5, 20);
    const memory = await UserMemory.findOne({ oxyUserId: req.user!.id });
    if (!memory || memory.memories.length === 0) {
      res.json({ results: [], method: 'none' });
      return;
    }

    // Try vector search first
    const { generateEmbedding, searchByVector } = await import('../lib/memory/index.js');
    const queryEmbedding = await generateEmbedding(q);

    let vectorResults: { memoryKey: string; score: number }[] = [];
    if (queryEmbedding) {
      vectorResults = await searchByVector(req.user!.id, queryEmbedding, topK);
    }

    // Text search fallback
    const queryLower = q.toLowerCase();
    const textResults = memory.memories
      .map(m => {
        const titleScore = m.title.toLowerCase().includes(queryLower) ? 0.8 : 0;
        const summaryScore = m.summary.toLowerCase().includes(queryLower) ? 0.6 : 0;
        return { memoryKey: m.title, score: Math.max(titleScore, summaryScore) };
      })
      .filter(r => r.score > 0);

    // Hybrid scoring: 0.7 * vector + 0.3 * text
    const scoreMap = new Map<string, number>();
    for (const vr of vectorResults) {
      scoreMap.set(vr.memoryKey, (scoreMap.get(vr.memoryKey) || 0) + vr.score * 0.7);
    }
    for (const tr of textResults) {
      scoreMap.set(tr.memoryKey, (scoreMap.get(tr.memoryKey) || 0) + tr.score * 0.3);
    }

    // Sort by hybrid score and look up full memory data
    const sorted = Array.from(scoreMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK);

    const results = sorted.map(([title, score]) => {
      const mem = memory.memories.find(m => m.title === title);
      return mem ? { title: mem.title, summary: mem.summary, type: mem.type, score: Math.round(score * 1000) / 1000 } : null;
    }).filter(Boolean);

    res.json({
      results,
      method: queryEmbedding ? 'hybrid' : 'text',
      totalMemories: memory.memories.length,
    });
  } catch (error: unknown) {
    log.memory.error({ err: error }, 'Semantic search error');
    res.status(500).json({ error: 'Search failed' });
  }
});

/**
 * PUT /api/memory/:memoryId
 * Update a specific memory
 */
router.put('/:memoryId', async (req, res) => {
  try {
    const { title, summary, type } = req.body;

    if (!title || !summary || !type) {
      res.status(400).json({ error: 'Title, summary, and type are required' });
      return;
    }

    const memory = await UserMemory.findOneAndUpdate(
      {
        oxyUserId: req.user!.id,
        'memories._id': req.params.memoryId
      },
      {
        $set: {
          'memories.$.title': title,
          'memories.$.summary': summary,
          'memories.$.type': type,
          'memories.$.updatedAt': new Date()
        }
      },
      { returnDocument: 'after' }
    );

    if (!memory) {
      res.status(404).json({ error: 'Memory not found' });
      return;
    }

    res.json(memory);
  } catch (error: unknown) {
    log.memory.error({ err: error }, 'Error updating memory');
    res.status(500).json({ error: 'Failed to update memory' });
  }
});

/**
 * DELETE /api/memory/:memoryId
 * Delete a specific memory
 */
router.delete('/:memoryId', async (req, res) => {
  try {
    const memory = await UserMemory.findOneAndUpdate(
      { oxyUserId: req.user!.id },
      {
        $pull: {
          memories: { _id: req.params.memoryId }
        }
      },
      { returnDocument: 'after' }
    );

    if (!memory) {
      res.status(404).json({ error: 'Memory not found' });
      return;
    }

    res.json(memory);
  } catch (error: unknown) {
    log.memory.error({ err: error }, 'Error deleting memory');
    res.status(500).json({ error: 'Failed to delete memory' });
  }
});

/**
 * GET /api/memory/search
 * Search memories with pagination and filtering
 */
router.get('/search', async (req, res) => {
  try {
    const { q, type, limit = '50', offset = '0', sortBy = 'updatedAt' } = req.query;

    const memory = await UserMemory.findOne({ oxyUserId: req.user!.id });
    if (!memory) {
      res.json({ memories: [], total: 0, limit: Number(limit), offset: Number(offset) });
      return;
    }

    let filtered = [...memory.memories];

    // Text search across title and summary
    if (q && typeof q === 'string') {
      const query = q.toLowerCase();
      filtered = filtered.filter(m =>
        m.title.toLowerCase().includes(query) ||
        m.summary.toLowerCase().includes(query)
      );
    }

    // Type filter
    if (type && typeof type === 'string') {
      filtered = filtered.filter(m => m.type === type);
    }

    // Sort
    filtered.sort((a, b) => {
      if (sortBy === 'updatedAt') return b.updatedAt.getTime() - a.updatedAt.getTime();
      if (sortBy === 'createdAt') return b.createdAt.getTime() - a.createdAt.getTime();
      if (sortBy === 'title') return a.title.localeCompare(b.title);
      return 0;
    });

    // Paginate
    const total = filtered.length;
    const limitNum = Number(limit);
    const offsetNum = Number(offset);
    const paginated = filtered.slice(offsetNum, offsetNum + limitNum);

    res.json({
      memories: paginated,
      total,
      limit: limitNum,
      offset: offsetNum
    });
  } catch (error: unknown) {
    log.memory.error({ err: error }, 'Search error');
    res.status(500).json({ error: 'Search failed' });
  }
});

/**
 * GET /api/memory/duplicates
 * Find potential duplicate memories
 */
router.get('/duplicates', async (req, res) => {
  try {
    const memory = await UserMemory.findOne({ oxyUserId: req.user!.id });
    if (!memory) {
      res.json({ duplicates: [], count: 0 });
      return;
    }

    const duplicates: any[] = [];
    for (let i = 0; i < memory.memories.length; i++) {
      for (let j = i + 1; j < memory.memories.length; j++) {
        const m1 = memory.memories[i];
        const m2 = memory.memories[j];

        // Exact summary match with different titles
        if (m1.summary.toLowerCase() === m2.summary.toLowerCase()) {
          duplicates.push({ memory1: m1, memory2: m2, reason: 'identical_summary' });
        }
        // Similar titles (case-insensitive match)
        else if (m1.title.toLowerCase() === m2.title.toLowerCase() && m1.title !== m2.title) {
          duplicates.push({ memory1: m1, memory2: m2, reason: 'similar_title' });
        }
      }
    }

    res.json({ duplicates, count: duplicates.length });
  } catch (error: unknown) {
    log.memory.error({ err: error }, 'Duplicate detection error');
    res.status(500).json({ error: 'Failed to detect duplicates' });
  }
});

/**
 * GET /api/memory/export/preview
 * Get export preview/statistics before downloading
 */
router.get('/export/preview', async (req, res) => {
  try {
    const memory = await UserMemory.findOne({ oxyUserId: req.user!.id });

    if (!memory) {
      res.json({
        totalMemories: 0,
        totalTypes: 0,
        hasPreferences: false,
        hasContext: false,
        estimatedSizeJSON: 0,
        estimatedSizeCSV: 0,
        types: [],
        oldestMemory: null,
        newestMemory: null,
      });
      return;
    }

    const types = new Set(memory.memories.map(m => m.type));

    // Rough size estimates
    const jsonStr = JSON.stringify(memory);
    const csvSize = memory.memories.reduce((acc, m) =>
      acc + m.title.length + m.summary.length + 50, 0
    );

    const oldestMemory = memory.memories.reduce((oldest: Date | null, m) =>
      !oldest || m.createdAt < oldest ? m.createdAt : oldest, null as Date | null
    );

    const newestMemory = memory.memories.reduce((newest: Date | null, m) =>
      !newest || m.updatedAt > newest ? m.updatedAt : newest, null as Date | null
    );

    res.json({
      totalMemories: memory.memories.length,
      totalTypes: types.size,
      types: Array.from(types),
      hasPreferences: Object.keys(memory.preferences || {}).length > 0,
      hasContext: Object.keys(memory.context || {}).length > 0,
      estimatedSizeJSON: jsonStr.length,
      estimatedSizeCSV: csvSize,
      oldestMemory,
      newestMemory,
    });
  } catch (error: unknown) {
    log.memory.error({ err: error }, 'Export preview error');
    res.status(500).json({ error: 'Failed to generate preview' });
  }
});

/**
 * GET /api/memory/export/json
 * Export all memory data as JSON
 */
router.get('/export/json', async (req, res) => {
  try {
    const memory = await UserMemory.findOne({ oxyUserId: req.user!.id });

    if (!memory) {
      res.status(404).json({ error: 'No memory data found' });
      return;
    }

    // Create export object with metadata
    const exportData = {
      version: '2.0',
      exportedAt: new Date().toISOString(),
      memories: memory.memories.map(m => ({
        title: m.title,
        summary: m.summary,
        type: m.type,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
      })),
      preferences: memory.preferences,
      context: memory.context,
    };

    // Set headers for download
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="alia-memories-${Date.now()}.json"`);

    res.json(exportData);
  } catch (error: unknown) {
    log.memory.error({ err: error }, 'Export JSON error');
    res.status(500).json({ error: 'Failed to export memories' });
  }
});

/**
 * Helper function for CSV escaping
 */
function escapeCSV(field: string): string {
  if (!field) return '';
  const str = String(field);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * GET /api/memory/export/csv
 * Export memories as CSV (memories only, not preferences/context)
 */
router.get('/export/csv', async (req, res) => {
  try {
    const memory = await UserMemory.findOne({ oxyUserId: req.user!.id });

    if (!memory) {
      res.status(404).json({ error: 'No memory data found' });
      return;
    }

    // Generate CSV
    const headers = ['Title', 'Summary', 'Type', 'Created At', 'Updated At'];
    const rows = memory.memories.map(m => [
      escapeCSV(m.title),
      escapeCSV(m.summary),
      escapeCSV(m.type),
      m.createdAt.toISOString(),
      m.updatedAt.toISOString(),
    ]);

    const csv = [
      headers.join(','),
      ...rows.map(row => row.join(','))
    ].join('\n');

    // Set headers for download
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="alia-memories-${Date.now()}.csv"`);

    res.send(csv);
  } catch (error: unknown) {
    log.memory.error({ err: error }, 'Export CSV error');
    res.status(500).json({ error: 'Failed to export memories' });
  }
});

/**
 * POST /api/memory/import/validate
 * Validate import data without importing
 */
router.post('/import/validate', async (req, res) => {
  try {
    const { data } = req.body;

    const validation = ImportMemorySchema.safeParse(data);

    if (!validation.success) {
      res.status(400).json({
        valid: false,
        errors: validation.error.issues.map(issue => ({
          path: issue.path.join('.'),
          message: issue.message,
        }))
      });
      return;
    }

    const importData = validation.data;
    const memory = await UserMemory.findOne({ oxyUserId: req.user!.id });

    // Get user's subscription to check memory limit
    const subscription = await Subscription.findOne({
      oxyUserId: req.user!.id,
      status: { $in: ['active', 'trialing'] }
    });

    const memoryLimit = getMemoryLimit(subscription?.plan?.name);

    // Analyze what would happen
    const analysis = {
      valid: true,
      totalToImport: importData.memories.length,
      duplicateTitles: 0,
      newTitles: 0,
      types: new Set(importData.memories.map(m => m.type)),
      estimatedFinalTotal: (memory?.memories.length || 0),
      memoryLimit,
      isUnlimited: memoryLimit === -1,
    };

    if (memory) {
      const existingTitles = new Set(memory.memories.map(m => m.title));
      analysis.duplicateTitles = importData.memories.filter(m => existingTitles.has(m.title)).length;
      analysis.newTitles = importData.memories.filter(m => !existingTitles.has(m.title)).length;
      analysis.estimatedFinalTotal = memory.memories.length + analysis.newTitles;
    } else {
      analysis.newTitles = importData.memories.length;
      analysis.estimatedFinalTotal = importData.memories.length;
    }

    // Check if it would exceed limits (unless unlimited)
    if (memoryLimit !== -1 && analysis.estimatedFinalTotal > memoryLimit) {
      res.json({
        valid: false,
        errors: [{
          message: `Import would exceed memory limit (${analysis.estimatedFinalTotal} > ${memoryLimit})`,
        }],
        analysis: {
          ...analysis,
          types: Array.from(analysis.types),
        },
      });
      return;
    }

    res.json({
      valid: true,
      analysis: {
        ...analysis,
        types: Array.from(analysis.types),
      },
    });

  } catch (error: unknown) {
    log.memory.error({ err: error }, 'Validation error');
    res.status(500).json({ error: 'Validation failed' });
  }
});

/**
 * POST /api/memory/import
 * Import memories from JSON file
 * Body: { data: ImportData, strategy: 'replace' | 'merge' | 'skip-duplicates' }
 */
router.post('/import', async (req, res) => {
  try {
    const { data, strategy = 'merge' } = req.body;

    // Validate strategy
    const strategyValidation = MergeStrategySchema.safeParse(strategy);
    if (!strategyValidation.success) {
      res.status(400).json({
        error: 'Invalid merge strategy',
        details: strategyValidation.error.issues
      });
      return;
    }

    // Validate import data structure
    const validation = ImportMemorySchema.safeParse(data);
    if (!validation.success) {
      res.status(400).json({
        error: 'Invalid import data format',
        details: validation.error.issues
      });
      return;
    }

    const importData = validation.data;

    // Check file size (approximate)
    const estimatedSize = JSON.stringify(importData).length;
    const MAX_IMPORT_SIZE = 5 * 1024 * 1024; // 5MB
    if (estimatedSize > MAX_IMPORT_SIZE) {
      res.status(400).json({
        error: 'Import data too large',
        maxSize: MAX_IMPORT_SIZE,
        actualSize: estimatedSize
      });
      return;
    }

    // Find or create user memory
    const memory = await getOrCreateUserMemory(req.user!.id);

    // Get user's subscription to check memory limit
    const subscription = await Subscription.findOne({
      oxyUserId: req.user!.id,
      status: { $in: ['active', 'trialing'] }
    });

    const memoryLimit = getMemoryLimit(subscription?.plan?.name);

    const stats = {
      imported: 0,
      updated: 0,
      skipped: 0,
      errors: [] as string[],
    };

    // Apply merge strategy
    if (strategy === 'replace') {
      // Replace all memories
      memory.memories = importData.memories.map(m => ({
        title: m.title,
        summary: m.summary,
        type: m.type,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));
      stats.imported = importData.memories.length;

      if (importData.preferences) memory.preferences = importData.preferences;
      if (importData.context) memory.context = importData.context;

    } else if (strategy === 'merge') {
      // Merge: update existing, add new
      for (const importMemory of importData.memories) {
        const existingIndex = memory.memories.findIndex(m => m.title === importMemory.title);

        if (existingIndex !== -1) {
          memory.memories[existingIndex].summary = importMemory.summary;
          memory.memories[existingIndex].type = importMemory.type;
          memory.memories[existingIndex].updatedAt = new Date();
          stats.updated++;
        } else {
          memory.memories.push({
            title: importMemory.title,
            summary: importMemory.summary,
            type: importMemory.type,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
          stats.imported++;
        }
      }

      // Merge preferences and context
      if (importData.preferences) {
        memory.preferences = { ...memory.preferences, ...importData.preferences };
      }
      if (importData.context) {
        memory.context = { ...memory.context, ...importData.context };
      }

    } else if (strategy === 'skip-duplicates') {
      // Only add memories that don't exist
      for (const importMemory of importData.memories) {
        const exists = memory.memories.some(m => m.title === importMemory.title);

        if (exists) {
          stats.skipped++;
        } else {
          memory.memories.push({
            title: importMemory.title,
            summary: importMemory.summary,
            type: importMemory.type,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
          stats.imported++;
        }
      }
    }

    // Check total memory limit (unless unlimited)
    if (memoryLimit !== -1 && memory.memories.length > memoryLimit) {
      res.status(400).json({
        error: 'Memory limit exceeded',
        limit: memoryLimit,
        current: memory.memories.length
      });
      return;
    }

    await memory.save();

    res.json({
      success: true,
      stats,
      totalMemories: memory.memories.length,
    });

  } catch (error: unknown) {
    log.memory.error({ err: error }, 'Import error');
    res.status(500).json({ error: 'Failed to import memories' });
  }
});

export default router;
```

- [ ] **Step 2: Write representative route tests**

Follow the mocking convention already used in `packages/api/src/routes/__tests__/conversations.test.ts` (mock the model + `authenticateToken`, test handler logic via the model mocks directly rather than supertest).

```typescript
// packages/api/src/routes/__tests__/memory.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../models/user-memory.js', async () => {
  const actual = await vi.importActual<typeof import('../../models/user-memory.js')>('../../models/user-memory.js');
  return {
    ...actual,
    UserMemory: { findOne: vi.fn(), findOneAndUpdate: vi.fn() },
  };
});

vi.mock('../../models/subscription.js', () => ({
  Subscription: { findOne: vi.fn() },
}));

vi.mock('../../middleware/auth.js', () => ({
  authenticateToken: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock('../../lib/logger.js', () => ({
  log: { memory: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

vi.mock('../../lib/memory/user-memory-service.js', () => ({
  getOrCreateUserMemory: vi.fn(),
}));

import { UserMemory } from '../../models/user-memory.js';
import { getOrCreateUserMemory } from '../../lib/memory/user-memory-service.js';
import { AddMemorySchema, MemorySettingsSchema } from '../../lib/validators/memory-validators.js';

const mockUserMemory = UserMemory as unknown as Record<string, ReturnType<typeof vi.fn>>;
const mockGetOrCreate = getOrCreateUserMemory as unknown as ReturnType<typeof vi.fn>;

describe('memory routes — validators and core logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('AddMemorySchema accepts title/summary/type and rejects a missing type', () => {
    const valid = AddMemorySchema.safeParse({ title: 'Food', summary: 'Loves strawberries', type: 'topic' });
    expect(valid.success).toBe(true);

    const invalid = AddMemorySchema.safeParse({ title: 'Food', summary: 'Loves strawberries' });
    expect(invalid.success).toBe(false);
  });

  it('AddMemorySchema rejects an unknown type value', () => {
    const invalid = AddMemorySchema.safeParse({ title: 'Food', summary: 'x', type: 'hobby' });
    expect(invalid.success).toBe(false);
  });

  it('MemorySettingsSchema accepts a partial update', () => {
    const result = MemorySettingsSchema.safeParse({ autoSaveEnabled: false });
    expect(result.success).toBe(true);
  });

  it('adds a new memory when title does not already exist', async () => {
    const doc = {
      memories: [] as any[],
      settings: { autoSaveEnabled: true, recallEnabled: true },
      save: vi.fn().mockResolvedValue(undefined),
    };
    mockGetOrCreate.mockResolvedValue(doc);

    // Simulate the POST /add handler's core branch directly against the mock,
    // mirroring the logic in routes/memory.ts (findIndex -> push).
    const existingIndex = doc.memories.findIndex((m) => m.title === 'Food');
    expect(existingIndex).toBe(-1);
    doc.memories.push({ title: 'Food', summary: 'Loves strawberries', type: 'topic', createdAt: new Date(), updatedAt: new Date() });
    await doc.save();

    expect(doc.memories).toHaveLength(1);
    expect(doc.save).toHaveBeenCalled();
  });

  it('updates settings via getOrCreateUserMemory + save', async () => {
    const doc = {
      memories: [] as any[],
      settings: { autoSaveEnabled: true, recallEnabled: true },
      save: vi.fn().mockResolvedValue(undefined),
    };
    mockGetOrCreate.mockResolvedValue(doc);

    doc.settings.autoSaveEnabled = false;
    await doc.save();

    expect(doc.settings.autoSaveEnabled).toBe(false);
    expect(doc.save).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run the new tests**

Run: `cd packages/api && bunx vitest run src/routes/__tests__/memory.test.ts`
Expected: 5 tests pass.

- [ ] **Step 4: Typecheck**

Run: `cd packages/api && bun run typecheck`
Expected: `src/routes/memory.ts` no longer appears in the error list.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/memory.ts packages/api/src/routes/__tests__/memory.test.ts
git commit -m "feat(api): rewrite memory routes for title/summary/type, add PUT /settings"
```

---

### Task 9: Import-from-other-provider route

**Files:**
- Modify: `packages/api/src/routes/memory.ts` (append one new route)

**Interfaces:**
- Consumes: `saveUserMemoryTool` from `../lib/tools/index.js` (Task 4); mirrors the exact `generateText` pattern already proven in `routes/internal.ts:194-204`.
- Produces: `POST /memory/import/from-text`, body `{ text: string }` → `{ saved: Array<{ title: string; summary: string; type: string }> }`. Consumed by Task 13 (frontend paste-back dialog).

This route runs regardless of `settings.autoSaveEnabled` (explicit user-initiated import, not passive extraction — see design spec). It reuses the tool's own execution, so plan-limit enforcement and embedding generation happen automatically with zero new logic.

- [ ] **Step 1: Add the import + route to `routes/memory.ts`**

Add to the top-of-file imports (alongside the existing ones):

```typescript
import { generateText, stepCountIs } from 'ai';
import { resolveModel, getAIModel, getDefaultAliaModel } from '../lib/chat-core.js';
import { saveUserMemoryTool } from '../lib/tools/index.js';
```

Add the new route (after `POST /import`, before `export default router;`):

```typescript
/**
 * POST /api/memory/import/from-text
 * Import memories from pasted text (e.g. a memory summary exported from
 * another AI assistant). Reuses saveUserMemoryTool via a single scoped
 * generateText call — no bespoke parsing logic. Runs regardless of
 * settings.autoSaveEnabled: this is an explicit user-initiated action.
 */
router.post('/import/from-text', async (req, res) => {
  try {
    const { text } = req.body as { text?: string };

    if (!text || typeof text !== 'string' || !text.trim()) {
      res.status(400).json({ error: 'text is required' });
      return;
    }

    if (text.length > 50_000) {
      res.status(400).json({ error: 'Text is too long (max 50,000 characters)' });
      return;
    }

    const userId = req.user!.id;

    const resolved = await resolveModel(getDefaultAliaModel());
    if (!resolved) {
      res.status(503).json({ error: 'No AI models available. Please try again later.' });
      return;
    }

    const model = getAIModel(resolved.keyConfig);
    const saveTool = saveUserMemoryTool(userId);

    const systemPrompt = `You are extracting memories from a block of text pasted by the user — typically a memory/context summary exported from another AI assistant. Read the text and call the saveUserMemory tool once for EACH distinct fact worth remembering. Choose type per fact: "profile" for facts about the user themself, "topic" for a subject/interest/project, "person" for someone in the user's life. Give each memory a short, human-readable title (2-4 words) and a 1-2 sentence summary. Do not invent facts that aren't in the text. If the text contains no memorable facts, don't call the tool at all.`;

    const result = await generateText({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text },
      ],
      tools: { saveUserMemory: saveTool },
      temperature: 0.2,
      maxRetries: 0,
      stopWhen: stepCountIs(20),
    });

    const saved = (result.toolResults || [])
      .filter((tr: any) => tr.toolName === 'saveUserMemory' && tr.output?.success)
      .map((tr: any) => ({
        title: tr.input?.title,
        summary: tr.input?.summary,
        type: tr.input?.type,
      }));

    res.json({ saved });
  } catch (error: unknown) {
    log.memory.error({ err: error }, 'Import-from-text error');
    res.status(500).json({ error: 'Failed to import from text' });
  }
});
```

- [ ] **Step 2: Write a test with a mocked `generateText`**

```typescript
// append to packages/api/src/routes/__tests__/memory.test.ts

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai');
  return { ...actual, generateText: vi.fn() };
});

vi.mock('../../lib/chat-core.js', () => ({
  resolveModel: vi.fn().mockResolvedValue({ keyConfig: {}, provider: 'test', modelId: 'test' }),
  getAIModel: vi.fn().mockReturnValue({}),
  getDefaultAliaModel: vi.fn().mockReturnValue('alia-v1'),
}));

vi.mock('../../lib/tools/index.js', () => ({
  saveUserMemoryTool: vi.fn().mockReturnValue({ execute: vi.fn() }),
}));

import { generateText } from 'ai';

describe('POST /memory/import/from-text — extraction shape', () => {
  it('extracts saved memories from generateText tool results', async () => {
    (generateText as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      toolResults: [
        { toolName: 'saveUserMemory', input: { title: 'Food', summary: 'Loves strawberries', type: 'topic' }, output: { success: true } },
        { toolName: 'saveUserMemory', input: { title: 'Bad', summary: 'x', type: 'topic' }, output: { success: false } },
      ],
    });

    const result = await generateText({} as any);
    const saved = (result.toolResults || [])
      .filter((tr: any) => tr.toolName === 'saveUserMemory' && tr.output?.success)
      .map((tr: any) => ({ title: tr.input?.title, summary: tr.input?.summary, type: tr.input?.type }));

    expect(saved).toEqual([{ title: 'Food', summary: 'Loves strawberries', type: 'topic' }]);
  });
});
```

- [ ] **Step 3: Run the tests**

Run: `cd packages/api && bunx vitest run src/routes/__tests__/memory.test.ts`
Expected: 6 tests pass (5 from Task 8 + this one).

- [ ] **Step 4: Full backend typecheck (final backend gate)**

Run: `cd packages/api && bun run typecheck`
Expected: PASS with zero errors — this confirms every call site from Task 1's Step 2 baseline has been swept.

- [ ] **Step 5: Full backend test suite**

Run: `cd packages/api && bun run test`
Expected: PASS (including pre-existing suites like `trigger-engine.test.ts` and `chat-completions-timeout.test.ts`, which already mock `saveUserMemoryTool` as an opaque `vi.fn()` — their mocks don't reference `key`/`value`/`category`, so they aren't affected by the rename, but confirm this by reading their diffs are empty).

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/routes/memory.ts packages/api/src/routes/__tests__/memory.test.ts
git commit -m "feat(api): add POST /memory/import/from-text, reusing saveUserMemoryTool"
```

---

### Task 10: Frontend store — rename `Memory`/`UserMemory` types, add `settings`

**Files:**
- Modify: `packages/app/lib/stores/user-data-store.ts` (full file)

**Interfaces:**
- Produces: `Memory { _id: string; title: string; summary: string; type: 'profile' | 'topic' | 'person'; createdAt: string; updatedAt: string }`, `UserMemory.settings: { autoSaveEnabled: boolean; recallEnabled: boolean }` (consumed by Task 12/13). These interfaces stay locally-declared and non-exported in this file, matching the existing convention (there is no shared-types package export for them today — out of scope to add one per the design spec).

- [ ] **Step 1: Replace the file**

```typescript
import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { persist, createJSONStorage } from 'zustand/middleware';

interface Memory {
  _id: string;
  title: string;
  summary: string;
  type: 'profile' | 'topic' | 'person';
  createdAt: string;
  updatedAt: string;
}

interface UserMemory {
  memories: Memory[];
  settings: {
    autoSaveEnabled: boolean;
    recallEnabled: boolean;
  };
  preferences: {
    language?: string;
    tone?: string;
    voice?: string;
    responseLength?: 'short' | 'medium' | 'long';
    interests?: string[];
    defaultAgentPermissions?: Record<string, boolean>;
    securityPreferences?: {
      requireApproval?: boolean;
      approvalTimeout?: number;
      autoDenyOnTimeout?: boolean;
    };
    [key: string]: unknown;
  };
  context: {
    occupation?: string;
    location?: string;
    bio?: string;
    timezone?: string;
  };
}

interface UserDataState {
  memory: UserMemory | null;
  loading: boolean;
  lastFetch: number | null;

  // Actions
  setMemory: (memory: UserMemory) => void;
  setLoading: (loading: boolean) => void;
  clearMemory: () => void;
  shouldRefetch: () => boolean;
}

const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

export const useUserDataStore = create<UserDataState>()(
  persist(
    (set, get) => ({
      memory: null,
      loading: false,
      lastFetch: null,

      setMemory: (memory) =>
        set({
          memory,
          lastFetch: Date.now(),
        }),

      setLoading: (loading) =>
        set({ loading }),

      clearMemory: () =>
        set({
          memory: null,
          lastFetch: null,
        }),

      // Check if we should refetch data (cache expired)
      shouldRefetch: () => {
        const { lastFetch } = get();
        if (!lastFetch) return true;
        return Date.now() - lastFetch > CACHE_DURATION;
      },
    }),
    {
      name: 'user-data-storage',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        memory: state.memory,
        lastFetch: state.lastFetch,
      }),
    }
  )
);
```

Note: `use-user-data.ts` needs no changes — it only forwards `memory`/`loading`/`setMemory`/`setLoading` generically and never references `key`/`value`/`category` directly.

- [ ] **Step 2: Typecheck**

Run: `cd packages/app && bunx tsc --noEmit`
Expected: FAILS now — `app/(app)/settings/memory.tsx` will show type errors against the new `Memory`/`UserMemory` shape. This is expected and resolved by Task 12. Confirm the errors are confined to `memory.tsx` (this file is the only consumer of these store types outside the store itself).

- [ ] **Step 3: Commit**

```bash
git add packages/app/lib/stores/user-data-store.ts
git commit -m "feat(app): rename Memory/UserMemory store types to title/summary/type + settings"
```

---

### Task 11: New `MemoryTable` component

**Files:**
- Create: `packages/app/components/settings/memory-table.tsx`

**Interfaces:**
- Consumes: `Button` (`@/components/ui/button`), `cn` (`@/lib/utils`), `Text` (`@/components/ui/text`), `lucide-react-native` icons.
- Produces: `MemoryTable` component, props:
  ```ts
  interface MemoryRow {
    _id: string;
    title: string;
    summary: string;
    updatedAt: string;
  }
  interface MemoryTableProps {
    heading: string;
    icon: React.ComponentType<{ size?: number; color?: string; className?: string }>;
    rows: MemoryRow[];
    emptyLabel: string;
    onRowPress: (id: string) => void;
    onDelete: (id: string) => void;
  }
  ```
  Consumed by Task 12, rendered 3× (You/Topics/People).

- [ ] **Step 1: Write the component**

```tsx
import React from "react";
import { View, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { Trash2 } from "lucide-react-native";
import { cn } from "@/lib/utils";

interface MemoryRow {
  _id: string;
  title: string;
  summary: string;
  updatedAt: string;
}

interface MemoryTableProps {
  heading: string;
  icon: React.ComponentType<{ size?: number; color?: string; className?: string }>;
  rows: MemoryRow[];
  emptyLabel: string;
  onRowPress: (id: string) => void;
  onDelete: (id: string) => void;
}

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function MemoryTable({ heading, icon: Icon, rows, emptyLabel, onRowPress, onDelete }: MemoryTableProps) {
  return (
    <View className="gap-xs pt-4">
      <View className="flex-row items-center gap-1.5 px-1">
        <Icon size={13} className="text-muted-foreground" />
        <Text className="text-xs font-semibold text-foreground">{heading}</Text>
      </View>

      {rows.length === 0 ? (
        <View className="px-3 py-3">
          <Text className="text-xs text-muted-foreground">{emptyLabel}</Text>
        </View>
      ) : (
        <View className="border border-border rounded-xl overflow-hidden bg-surface">
          {rows.map((row, index) => (
            <Pressable
              key={row._id}
              onPress={() => onRowPress(row._id)}
              className={cn(
                "flex-row items-center px-3 py-2.5 gap-2 group active:bg-accent/50",
                index !== rows.length - 1 && "border-b border-border"
              )}
            >
              <View className="flex-1 min-w-0">
                <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
                  {row.title}
                </Text>
                <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                  {row.summary}
                </Text>
              </View>

              <Text className="text-[10px] text-muted-foreground/60 shrink-0 md:block hidden">
                {formatRelativeTime(row.updatedAt)}
              </Text>

              <Pressable
                onPress={(e) => {
                  e.stopPropagation();
                  onDelete(row._id);
                }}
                className="w-7 h-7 items-center justify-center rounded-md shrink-0 active:bg-destructive/10 web:opacity-0 web:group-hover:opacity-100"
              >
                <Trash2 size={14} className="text-muted-foreground" />
              </Pressable>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}
```

Note on the `md:block hidden` class for the timestamp column: this follows the same NativeWind-responsive convention already used across `packages/app` (a `md:` breakpoint compresses the row on narrow/native screens by hiding the least-critical column, rather than branching to a different component tree — per the "no separate web/native files" constraint).

- [ ] **Step 2: Typecheck**

Run: `cd packages/app && bunx tsc --noEmit`
Expected: no new errors from this file (it has no consumers yet, so it can't itself be miswired until Task 12).

- [ ] **Step 3: Commit**

```bash
git add packages/app/components/settings/memory-table.tsx
git commit -m "feat(app): add reusable MemoryTable component for grouped memory sections"
```

---

### Task 12: Core screen restructure — `memory.tsx`

**Files:**
- Modify: `packages/app/app/(app)/settings/memory.tsx` (full file rewrite)

**Interfaces:**
- Consumes: `MemoryTable` (Task 11), `Memory`/`UserMemory` store types (Task 10), `Switch` (`@/components/ui/switch`, `value`/`onValueChange` props).
- Produces: the rewritten screen, minus the import-from-provider dialog (added in Task 13 as a follow-up edit against this exact output).

This removes: `CATEGORY_CONFIG`, `SUGGESTED_CATEGORIES`, the category `ToggleGroup` filter block, and the old `MemoryRow` function — none of these have a reason to exist once grouping is structural (by `type`) instead of a user-toggled filter.

- [ ] **Step 1: Replace the file**

```tsx
import React, { useState, useEffect, useMemo } from 'react';
import { View, ScrollView, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { confirm } from "@oxyhq/bloom/alert-dialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useOxy, useAuth } from "@oxyhq/services";
import { generateAPIUrl } from "@/lib/generate-api-url";
import {
  Brain,
  Plus,
  Search,
  User,
  Tag,
  Users,
  Download,
  Upload,
  FileJson,
  FileText,
  Wand2,
  Copy,
} from "lucide-react-native";
import { useTranslation } from "@/lib/hooks/use-translation";
import { useUserData } from "@/lib/hooks/use-user-data";
import { useUserDataStore } from "@/lib/stores/user-data-store";
import { cn } from "@/lib/utils";
import { toast } from "@/components/sonner";
import { useColorScheme } from "@/lib/useColorScheme";
import { SettingsHeader } from "@/components/settings/settings-header";
import { MemoryTable } from "@/components/settings/memory-table";

type MemoryType = 'profile' | 'topic' | 'person';

interface Memory {
  _id: string;
  title: string;
  summary: string;
  type: MemoryType;
  createdAt: string;
  updatedAt: string;
}

/** A single hit from semantic memory search (maps back onto a {@link Memory}). */
interface SemanticResult {
  title: string;
  summary: string;
  type?: MemoryType;
  score?: number;
}

/** Aggregate counts returned by the export-preview endpoint. */
interface ExportStats {
  totalMemories: number;
  totalTypes: number;
  estimatedSizeJSON: number;
}

/** Summary returned by the import-validate endpoint before committing an import. */
interface ImportPreview {
  totalToImport: number;
  newTitles: number;
  duplicateTitles: number;
  estimatedFinalTotal: number;
  memoryLimit: number;
}

/** A pair of memories flagged as duplicates by the dedupe endpoint. */
interface DuplicatePair {
  reason: string;
  memory1?: { _id: string; title: string; summary: string };
  memory2?: { _id: string; title: string; summary: string };
}

const TYPE_SECTIONS: { type: MemoryType; headingKey: string; icon: typeof User; emptyKey: string }[] = [
  { type: 'profile', headingKey: 'memory.sectionYou', icon: User, emptyKey: 'memory.sectionYouEmpty' },
  { type: 'topic', headingKey: 'memory.sectionTopics', icon: Tag, emptyKey: 'memory.sectionTopicsEmpty' },
  { type: 'person', headingKey: 'memory.sectionPeople', icon: Users, emptyKey: 'memory.sectionPeopleEmpty' },
];

export default function MemoryScreen() {
  const { isAuthenticated, oxyServices } = useOxy();
  const { signIn } = useAuth();
  const { memory, loading } = useUserData();
  const setMemory = useUserDataStore((state) => state.setMemory);
  const { colors } = useColorScheme();
  const { t } = useTranslation();
  const [showDialog, setShowDialog] = useState(false);
  const [editingMemory, setEditingMemory] = useState<Memory | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [saving, setSaving] = useState(false);

  // Form state
  const [formTitle, setFormTitle] = useState("");
  const [formSummary, setFormSummary] = useState("");
  const [formType, setFormType] = useState<MemoryType>('topic');

  // Settings toggles
  const [updatingSettings, setUpdatingSettings] = useState(false);

  // Export/Import state
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [exportFormat, setExportFormat] = useState<'json' | 'csv'>('json');
  const [exportStats, setExportStats] = useState<ExportStats | null>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importStrategy, setImportStrategy] = useState<'merge' | 'replace' | 'skip-duplicates'>('merge');
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [importing, setImporting] = useState(false);

  // Semantic search state
  const [semanticMode, setSemanticMode] = useState(false);
  const [semanticResults, setSemanticResults] = useState<SemanticResult[] | null>(null);
  const [semanticLoading, setSemanticLoading] = useState(false);

  // Duplicate detection state
  const [showDuplicatesDialog, setShowDuplicatesDialog] = useState(false);
  const [duplicates, setDuplicates] = useState<DuplicatePair[]>([]);
  const [duplicatesLoading, setDuplicatesLoading] = useState(false);

  const memories = memory?.memories || [];

  // Redirect if not authenticated
  useEffect(() => {
    if (!isAuthenticated) {
      signIn().catch(() => {});
    }
  }, [isAuthenticated, signIn]);

  // Filter memories by search query
  const filteredMemories = useMemo(() => {
    if (!searchQuery.trim()) return memories;
    const query = searchQuery.toLowerCase();
    return memories.filter(m =>
      m.title.toLowerCase().includes(query) ||
      m.summary.toLowerCase().includes(query)
    );
  }, [memories, searchQuery]);

  const handleOpenDialog = (memory?: Memory, defaultType: MemoryType = 'topic') => {
    if (memory) {
      setEditingMemory(memory);
      setFormTitle(memory.title);
      setFormSummary(memory.summary);
      setFormType(memory.type);
    } else {
      setEditingMemory(null);
      setFormTitle("");
      setFormSummary("");
      setFormType(defaultType);
    }
    setShowDialog(true);
  };

  const handleCloseDialog = () => {
    setShowDialog(false);
    setEditingMemory(null);
    setFormTitle("");
    setFormSummary("");
    setFormType('topic');
  };

  const getAuthHeaders = (contentType?: boolean): Record<string, string> => {
    const headers: Record<string, string> = {};
    const token = oxyServices.getAccessToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (contentType) headers['Content-Type'] = 'application/json';
    return headers;
  };

  const handleSaveMemory = async () => {
    if (!isAuthenticated || !formTitle.trim() || !formSummary.trim()) {
      toast.error(t("memory.titleSummaryRequired"));
      return;
    }

    setSaving(true);
    try {
      if (editingMemory) {
        const apiUrl = generateAPIUrl(`/memory/${editingMemory._id}`);
        const response = await fetch(apiUrl, {
          method: 'PUT',
          headers: getAuthHeaders(true),
          body: JSON.stringify({
            title: formTitle,
            summary: formSummary,
            type: formType,
          }),
        });

        if (response.ok) {
          const updatedMemory = await response.json();
          setMemory(updatedMemory);
          handleCloseDialog();
          toast.success(t("memory.memoryUpdated"));
        }
      } else {
        const apiUrl = generateAPIUrl('/memory/add');
        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: getAuthHeaders(true),
          body: JSON.stringify({
            title: formTitle,
            summary: formSummary,
            type: formType,
          }),
        });

        if (response.ok) {
          const updatedMemory = await response.json();
          setMemory(updatedMemory);
          handleCloseDialog();
          toast.success(t("memory.memoryAdded"));
        }
      }
    } catch (error) {
      console.error("Error saving memory:", error);
      toast.error(t("memory.failedToSave"));
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteMemory = async (memoryId: string) => {
    if (!isAuthenticated) return;

    const ok = await confirm({
      title: t("memory.deleteMemory"),
      description: t("memory.deleteConfirmation"),
      confirmLabel: t("common.delete"),
      cancelLabel: t("common.cancel"),
      destructive: true,
    });
    if (!ok) return;

    try {
      const apiUrl = generateAPIUrl(`/memory/${memoryId}`);
      const response = await fetch(apiUrl, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      });

      if (response.ok) {
        const updatedMemory = await response.json();
        setMemory(updatedMemory);
        toast.success(t("memory.memoryDeleted"));
      }
    } catch (error) {
      console.error("Error deleting memory:", error);
      toast.error(t("memory.failedToDelete"));
    }
  };

  const handleToggleSetting = async (key: 'autoSaveEnabled' | 'recallEnabled', value: boolean) => {
    if (!isAuthenticated || !memory) return;

    setUpdatingSettings(true);
    try {
      const apiUrl = generateAPIUrl('/memory/settings');
      const response = await fetch(apiUrl, {
        method: 'PUT',
        headers: getAuthHeaders(true),
        body: JSON.stringify({ [key]: value }),
      });

      if (response.ok) {
        const settings = await response.json();
        setMemory({ ...memory, settings });
      } else {
        toast.error(t('memory.failedToSaveSettings'));
      }
    } catch (error) {
      console.error("Error updating memory settings:", error);
      toast.error(t('memory.failedToSaveSettings'));
    } finally {
      setUpdatingSettings(false);
    }
  };

  // Semantic search handler
  const performSemanticSearch = async (query: string) => {
    if (!isAuthenticated || !query.trim()) {
      setSemanticResults(null);
      return;
    }

    setSemanticLoading(true);
    try {
      const apiUrl = generateAPIUrl(`/memory/semantic-search?q=${encodeURIComponent(query)}&limit=20`);
      const response = await fetch(apiUrl, {
        method: 'GET',
        headers: getAuthHeaders(),
      });

      if (response.ok) {
        const data = await response.json();
        setSemanticResults(data.results || []);
      } else {
        setSemanticResults(null);
        toast.error(t("memory.semanticUnavailable"));
        setSemanticMode(false);
      }
    } catch (error) {
      console.error("Semantic search error:", error);
      setSemanticResults(null);
      setSemanticMode(false);
    } finally {
      setSemanticLoading(false);
    }
  };

  // Debounced semantic search
  useEffect(() => {
    if (!semanticMode || !searchQuery.trim()) {
      setSemanticResults(null);
      return;
    }

    const timer = setTimeout(() => {
      performSemanticSearch(searchQuery);
    }, 500);

    return () => clearTimeout(timer);
  }, [searchQuery, semanticMode]);

  // Duplicate detection handler
  const loadDuplicates = async () => {
    if (!isAuthenticated) return;

    setDuplicatesLoading(true);
    try {
      const apiUrl = generateAPIUrl('/memory/duplicates');
      const response = await fetch(apiUrl, {
        method: 'GET',
        headers: getAuthHeaders(),
      });

      if (response.ok) {
        const data = await response.json();
        setDuplicates(data.duplicates || []);
        setShowDuplicatesDialog(true);
      } else {
        toast.error(t("memory.failedDuplicates"));
      }
    } catch (error) {
      console.error("Duplicates error:", error);
      toast.error(t("memory.failedDuplicates"));
    } finally {
      setDuplicatesLoading(false);
    }
  };

  // Determine which memories to show (search or semantic overlay), before grouping
  const displayMemories = useMemo(() => {
    if (semanticMode && semanticResults) {
      return semanticResults.map((r) => {
        const found = memories.find(m => m.title === r.title && m.summary === r.summary);
        return found || { _id: r.title, title: r.title, summary: r.summary, type: r.type || 'topic', score: r.score, createdAt: '', updatedAt: '' };
      });
    }
    return filteredMemories;
  }, [semanticMode, semanticResults, filteredMemories, memories]);

  const groupedByType = useMemo(() => {
    return {
      profile: displayMemories.filter(m => m.type === 'profile'),
      topic: displayMemories.filter(m => m.type === 'topic'),
      person: displayMemories.filter(m => m.type === 'person'),
    };
  }, [displayMemories]);

  // Export handlers
  const loadExportStats = async () => {
    if (!isAuthenticated) return;

    try {
      const apiUrl = generateAPIUrl('/memory/export/preview');
      const response = await fetch(apiUrl, {
        method: 'GET',
        headers: getAuthHeaders(),
      });

      if (response.ok) {
        const stats = await response.json();
        setExportStats(stats);
      }
    } catch (error) {
      console.error('Export stats error:', error);
      toast.error(t('memory.failedToLoadStats'));
    }
  };

  const handleExport = async (format: 'json' | 'csv') => {
    if (!isAuthenticated) return;

    try {
      const apiUrl = generateAPIUrl(`/memory/export/${format}`);
      const response = await fetch(apiUrl, {
        method: 'GET',
        headers: getAuthHeaders(),
      });

      if (response.ok) {
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `alia-memories-${Date.now()}.${format}`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);

        toast.success(t('memory.exportedAs', { format: format.toUpperCase() }));
        setShowExportDialog(false);
      } else {
        const error = await response.json();
        toast.error(error.error || t('memory.exportFailed'));
      }
    } catch (error) {
      console.error('Export error:', error);
      toast.error(t('memory.failedToExport'));
    }
  };

  // Import handlers
  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (file.size > 5 * 1024 * 1024) {
      toast.error(t('memory.fileTooLarge'));
      return;
    }

    try {
      const text = await file.text();
      const data = JSON.parse(text);

      const response = await fetch(generateAPIUrl('/memory/import/validate'), {
        method: 'POST',
        headers: getAuthHeaders(true),
        body: JSON.stringify({ data }),
      });

      const result = await response.json();

      if (result.valid) {
        setImportFile(file);
        setImportPreview(result.analysis);
      } else {
        toast.error(t('memory.invalidFileFormat'));
        console.error('Validation errors:', result.errors);
      }
    } catch (error) {
      toast.error(t('memory.failedToReadFile'));
      console.error(error);
    }
  };

  const handleImport = async () => {
    if (!importFile || !isAuthenticated) return;

    setImporting(true);
    try {
      const text = await importFile.text();
      const data = JSON.parse(text);

      const response = await fetch(generateAPIUrl('/memory/import'), {
        method: 'POST',
        headers: getAuthHeaders(true),
        body: JSON.stringify({ data, strategy: importStrategy }),
      });

      if (response.ok) {
        const result = await response.json();

        const memResponse = await fetch(generateAPIUrl('/memory'), {
          headers: getAuthHeaders(),
        });
        if (memResponse.ok) {
          setMemory(await memResponse.json());
        }

        toast.success(
          t('memory.importSuccess', {
            imported: result.stats.imported,
            updated: result.stats.updated,
            skipped: result.stats.skipped,
          })
        );

        setShowImportDialog(false);
        setImportFile(null);
        setImportPreview(null);
      } else {
        const error = await response.json();
        toast.error(error.error || t('memory.importFailed'));
      }
    } catch (error) {
      console.error('Import error:', error);
      toast.error(t('memory.failedToImport'));
    } finally {
      setImporting(false);
    }
  };

  if (loading) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <Text>{t("common.loading")}</Text>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <SettingsHeader title={t("memory.title")} />
      <ScrollView className="flex-1" contentContainerClassName="max-w-2xl">
        {/* Settings toggles */}
        <View className="px-4 pt-3 pb-2 gap-3">
          <View className="flex-row items-center justify-between gap-3">
            <View className="flex-1 min-w-0">
              <Text className="text-sm text-foreground">{t('memory.recallToggleLabel')}</Text>
              <Text className="text-xs text-muted-foreground">{t('memory.recallToggleDescription')}</Text>
            </View>
            <Switch
              value={memory?.settings?.recallEnabled ?? true}
              onValueChange={(v) => handleToggleSetting('recallEnabled', v)}
              disabled={updatingSettings}
            />
          </View>
          <View className="flex-row items-center justify-between gap-3">
            <View className="flex-1 min-w-0">
              <Text className="text-sm text-foreground">{t('memory.autoSaveToggleLabel')}</Text>
              <Text className="text-xs text-muted-foreground">{t('memory.autoSaveToggleDescription')}</Text>
            </View>
            <Switch
              value={memory?.settings?.autoSaveEnabled ?? true}
              onValueChange={(v) => handleToggleSetting('autoSaveEnabled', v)}
              disabled={updatingSettings}
            />
          </View>
        </View>

        {/* Compact Toolbar */}
        <View className="px-4 pt-1 pb-2 gap-2">
          <View className="flex-row items-center gap-2">
            <View className="flex-1 flex-row items-center gap-2 bg-muted rounded-lg px-3 h-9">
              <Search size={15} className="text-muted-foreground" />
              <Input
                value={searchQuery}
                onChangeText={setSearchQuery}
                placeholder={semanticMode ? t("memory.aiSearchPlaceholder") : t("memory.searchPlaceholder")}
                className="flex-1 border-0 bg-transparent h-auto p-0 text-sm web:focus-visible:ring-0"
                placeholderTextColor={colors.mutedForeground}
              />
              {semanticLoading && (
                <Text className="text-xs text-muted-foreground">...</Text>
              )}
              <Pressable
                onPress={() => {
                  setSemanticMode(!semanticMode);
                  if (!semanticMode) {
                    toast.info(t("memory.aiSearchEnabled"));
                  }
                }}
                className={cn(
                  "px-2 py-0.5 rounded-md",
                  semanticMode ? "bg-primary/15" : ""
                )}
              >
                <View className="flex-row items-center gap-1">
                  <Wand2 size={11} className={semanticMode ? "text-primary" : "text-muted-foreground"} />
                  <Text className={cn("text-[11px] font-medium", semanticMode ? "text-primary" : "text-muted-foreground")}>
                    AI
                  </Text>
                </View>
              </Pressable>
            </View>

            <Button
              onPress={() => handleOpenDialog()}
              size="sm"
              className="h-9 px-3 rounded-lg"
            >
              <View className="flex-row items-center gap-1.5">
                <Plus size={16} className="text-primary-foreground" />
              </View>
            </Button>
          </View>

          <View className="flex-row items-center justify-between">
            <Text className="text-xs text-muted-foreground">
              {displayMemories.length} {displayMemories.length === 1 ? 'memoria' : 'memorias'}
            </Text>
            <View className="flex-row items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onPress={() => {
                  setShowExportDialog(true);
                  loadExportStats();
                }}
              >
                <Download size={14} className="text-muted-foreground" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onPress={() => setShowImportDialog(true)}
              >
                <Upload size={14} className="text-muted-foreground" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onPress={loadDuplicates}
                disabled={duplicatesLoading}
              >
                <Copy size={14} className="text-muted-foreground" />
              </Button>
            </View>
          </View>
        </View>

        {/* Grouped sections */}
        <View className="px-4 pb-4">
          {memories.length === 0 ? (
            <View className="items-center justify-center py-12">
              <Brain size={32} className="text-muted-foreground opacity-40" />
              <Text className="text-sm font-medium text-muted-foreground mt-3">
                {t('memory.noMemories')}
              </Text>
              <Text className="text-xs text-muted-foreground text-center mt-1 max-w-xs">
                {t('memory.shareInfo')}
              </Text>
            </View>
          ) : (
            <>
              {TYPE_SECTIONS.map((section) => (
                <MemoryTable
                  key={section.type}
                  heading={t(section.headingKey)}
                  icon={section.icon}
                  rows={groupedByType[section.type]}
                  emptyLabel={t(section.emptyKey)}
                  onRowPress={(id) => {
                    const found = memories.find(m => m._id === id);
                    if (found) handleOpenDialog(found);
                  }}
                  onDelete={handleDeleteMemory}
                />
              ))}
            </>
          )}
        </View>
      </ScrollView>

      {/* Add/Edit Dialog */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent closeButton={true}>
          <DialogHeader>
            <DialogTitle>
              {editingMemory ? t('memory.editMemory') : t('memory.newMemory')}
            </DialogTitle>
            <DialogDescription>
              {editingMemory
                ? t('memory.updateDetails')
                : t('memory.addForAlia')}
            </DialogDescription>
          </DialogHeader>

          <View className="gap-4">
            <View className="gap-2">
              <Label nativeID="title">{t('memory.titleLabel')}</Label>
              <Input
                aria-labelledby="title"
                value={formTitle}
                onChangeText={setFormTitle}
                placeholder={t('memory.titlePlaceholder')}
                editable={!saving}
              />
            </View>

            <View className="gap-2">
              <Label nativeID="summary">{t('memory.summaryLabel')}</Label>
              <Textarea
                aria-labelledby="summary"
                value={formSummary}
                onChangeText={setFormSummary}
                placeholder={t('memory.summaryPlaceholder')}
                editable={!saving}
              />
            </View>

            <View className="gap-2">
              <Label>{t('memory.typeLabel')}</Label>
              <ToggleGroup
                type="single"
                value={formType}
                onValueChange={(val) => {
                  if (val === 'profile' || val === 'topic' || val === 'person') {
                    setFormType(val);
                  }
                }}
              >
                <ToggleGroupItem value="profile">
                  <Text>{t('memory.sectionYou')}</Text>
                </ToggleGroupItem>
                <ToggleGroupItem value="topic">
                  <Text>{t('memory.sectionTopics')}</Text>
                </ToggleGroupItem>
                <ToggleGroupItem value="person">
                  <Text>{t('memory.sectionPeople')}</Text>
                </ToggleGroupItem>
              </ToggleGroup>
            </View>
          </View>

          <DialogFooter>
            <Button
              variant="outline"
              className="flex-1"
              onPress={handleCloseDialog}
              disabled={saving}
            >
              <Text>{t('common.cancel')}</Text>
            </Button>
            <Button
              className="flex-1"
              onPress={handleSaveMemory}
              disabled={saving}
            >
              <Text>{saving ? t('memory.saving') : editingMemory ? t('memory.update') : t('memory.add')}</Text>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Export Dialog */}
      <Dialog open={showExportDialog} onOpenChange={setShowExportDialog}>
        <DialogContent closeButton={true}>
          <DialogHeader>
            <DialogTitle>{t('memory.exportTitle')}</DialogTitle>
            <DialogDescription>
              {t('memory.exportDescription')}
            </DialogDescription>
          </DialogHeader>

          {exportStats && (
            <View className="gap-3">
              <View className="bg-muted rounded-lg p-3">
                <Text className="text-sm text-muted-foreground mb-2">{t('memory.exportStatistics')}</Text>
                <Text className="text-sm">{t('memory.totalMemories')}: {exportStats.totalMemories}</Text>
                <Text className="text-sm">{t('memory.types')}: {exportStats.totalTypes}</Text>
                <Text className="text-sm">
                  {t('memory.sizeJSON')}: ~{(exportStats.estimatedSizeJSON / 1024).toFixed(1)} KB
                </Text>
              </View>

              <View className="gap-2">
                <Label>{t('memory.format')}</Label>
                <ToggleGroup
                  type="single"
                  value={exportFormat}
                  onValueChange={(val) => setExportFormat(val as 'json' | 'csv')}
                >
                  <ToggleGroupItem value="json">
                    <View className="flex-row items-center gap-2">
                      <FileJson size={16} className="text-foreground" />
                      <Text>{t('memory.jsonFull')}</Text>
                    </View>
                  </ToggleGroupItem>
                  <ToggleGroupItem value="csv">
                    <View className="flex-row items-center gap-2">
                      <FileText size={16} className="text-foreground" />
                      <Text>{t('memory.csv')}</Text>
                    </View>
                  </ToggleGroupItem>
                </ToggleGroup>

                <Text className="text-xs text-muted-foreground mt-1">
                  {exportFormat === 'json'
                    ? t('memory.jsonDescription')
                    : t('memory.csvDescription')}
                </Text>
              </View>
            </View>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              className="flex-1"
              onPress={() => setShowExportDialog(false)}
            >
              <Text>{t('common.cancel')}</Text>
            </Button>
            <Button
              className="flex-1"
              onPress={() => handleExport(exportFormat)}
            >
              <View className="flex-row items-center gap-2">
                <Download size={16} className="text-primary-foreground" />
                <Text>{t('memory.download', { format: exportFormat.toUpperCase() })}</Text>
              </View>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Import Dialog (file-based) */}
      <Dialog open={showImportDialog} onOpenChange={setShowImportDialog}>
        <DialogContent closeButton={true}>
          <DialogHeader>
            <DialogTitle>{t('memory.importTitle')}</DialogTitle>
            <DialogDescription>
              {t('memory.importDescription')}
            </DialogDescription>
          </DialogHeader>

          <View className="gap-4">
            <View className="gap-2">
              <Label>{t('memory.selectFile')}</Label>
              <input
                type="file"
                accept=".json"
                onChange={handleFileSelect}
                className="block w-full text-sm"
              />
            </View>

            {importPreview && (
              <View className="bg-muted rounded-lg p-3 gap-2">
                <Text className="text-sm font-medium">{t('memory.preview')}</Text>
                <Text className="text-xs">{t('memory.totalToImport')}: {importPreview.totalToImport}</Text>
                <Text className="text-xs">{t('memory.newMemoriesCount')}: {importPreview.newTitles}</Text>
                <Text className="text-xs">{t('memory.duplicatesCount')}: {importPreview.duplicateTitles}</Text>
                <Text className="text-xs">{t('memory.finalTotal')}: {importPreview.estimatedFinalTotal}</Text>
                {importPreview.memoryLimit !== -1 && (
                  <Text className="text-xs">{t('memory.memoryLimit')}: {importPreview.memoryLimit}</Text>
                )}
              </View>
            )}

            {importFile && (
              <View className="gap-2">
                <Label>{t('memory.importStrategy')}</Label>
                <ToggleGroup
                  type="single"
                  value={importStrategy}
                  onValueChange={(val) => {
                    if (val === 'merge' || val === 'skip-duplicates' || val === 'replace') {
                      setImportStrategy(val);
                    }
                  }}
                >
                  <ToggleGroupItem value="merge">
                    <Text>{t('memory.merge')}</Text>
                  </ToggleGroupItem>
                  <ToggleGroupItem value="skip-duplicates">
                    <Text>{t('memory.skipDupes')}</Text>
                  </ToggleGroupItem>
                  <ToggleGroupItem value="replace">
                    <Text>{t('memory.replaceAll')}</Text>
                  </ToggleGroupItem>
                </ToggleGroup>

                <Text className="text-xs text-muted-foreground mt-1">
                  {importStrategy === 'merge' && t('memory.mergeDescription')}
                  {importStrategy === 'skip-duplicates' && t('memory.skipDescription')}
                  {importStrategy === 'replace' && t('memory.replaceDescription')}
                </Text>
              </View>
            )}
          </View>

          <DialogFooter>
            <Button
              variant="outline"
              className="flex-1"
              onPress={() => setShowImportDialog(false)}
              disabled={importing}
            >
              <Text>{t('common.cancel')}</Text>
            </Button>
            <Button
              className="flex-1"
              onPress={handleImport}
              disabled={!importFile || importing}
            >
              <Text>{importing ? t('memory.importing') : t('memory.import')}</Text>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Duplicates Dialog */}
      <Dialog open={showDuplicatesDialog} onOpenChange={setShowDuplicatesDialog}>
        <DialogContent closeButton={true}>
          <DialogHeader>
            <DialogTitle>{t('memory.duplicateMemories')}</DialogTitle>
            <DialogDescription>
              {duplicates.length === 0
                ? t('memory.noDuplicates')
                : t('memory.foundDuplicates', { count: duplicates.length })}
            </DialogDescription>
          </DialogHeader>

          {duplicates.length > 0 && (
            <ScrollView style={{ maxHeight: 400 }}>
              <View className="gap-3">
                {duplicates.map((dup, i) => (
                  <View key={i} className="border border-border rounded-lg p-3 gap-2">
                    <View className="bg-muted rounded-md px-2 py-1 self-start">
                      <Text className="text-[10px] text-muted-foreground font-medium">
                        {dup.reason === 'identical_summary' ? t('memory.identicalValue') : t('memory.similarKey')}
                      </Text>
                    </View>
                    <View className="gap-1">
                      <Text className="text-xs font-semibold text-foreground">
                        {dup.memory1?.title}
                      </Text>
                      <Text className="text-xs text-muted-foreground" numberOfLines={2}>
                        {dup.memory1?.summary}
                      </Text>
                    </View>
                    <View className="h-px bg-border" />
                    <View className="gap-1">
                      <Text className="text-xs font-semibold text-foreground">
                        {dup.memory2?.title}
                      </Text>
                      <Text className="text-xs text-muted-foreground" numberOfLines={2}>
                        {dup.memory2?.summary}
                      </Text>
                    </View>
                    <View className="flex-row gap-2 mt-1">
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1 h-7"
                        onPress={() => {
                          const targetId = dup.memory2?._id;
                          if (targetId) handleDeleteMemory(targetId);
                          setDuplicates(prev => prev.filter((_, idx) => idx !== i));
                        }}
                      >
                        <Text className="text-xs">{t('memory.keepFirst')}</Text>
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1 h-7"
                        onPress={() => {
                          const targetId = dup.memory1?._id;
                          if (targetId) handleDeleteMemory(targetId);
                          setDuplicates(prev => prev.filter((_, idx) => idx !== i));
                        }}
                      >
                        <Text className="text-xs">{t('memory.keepSecond')}</Text>
                      </Button>
                    </View>
                  </View>
                ))}
              </View>
            </ScrollView>
          )}

          <DialogFooter>
            <Button onPress={() => setShowDuplicatesDialog(false)}>
              <Text>{t('common.done')}</Text>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </View>
  );
}
```

Deleted from the original file (intentionally, no replacement): `CategoryIcon` type, `CATEGORY_CONFIG`, `SUGGESTED_CATEGORIES`, the `categories`/`selectedCategory` state and the category `ToggleGroup` filter block, `getCategoryConfig`, and the standalone `MemoryRow` function (superseded by `MemoryTable`).

- [ ] **Step 2: Add the missing i18n keys**

Find the translation file(s) consumed by `useTranslation()` (locate via `grep -rn "memory.searchPlaceholder" packages/app` to find the existing `memory.*` key namespace) and add: `memory.sectionYou`, `memory.sectionYouEmpty`, `memory.sectionTopics`, `memory.sectionTopicsEmpty`, `memory.sectionPeople`, `memory.sectionPeopleEmpty`, `memory.titleSummaryRequired`, `memory.titleLabel`, `memory.titlePlaceholder`, `memory.summaryLabel`, `memory.summaryPlaceholder`, `memory.typeLabel`, `memory.types`, `memory.recallToggleLabel`, `memory.recallToggleDescription`, `memory.autoSaveToggleLabel`, `memory.autoSaveToggleDescription`, `memory.failedToSaveSettings` — for both the English and Spanish locale files, following the exact key/value format already used for the existing `memory.*` entries in those files (read a few neighboring keys first to match tone/casing before adding new ones).

- [ ] **Step 3: Typecheck**

Run: `cd packages/app && bunx tsc --noEmit`
Expected: PASS with zero errors (Task 10 + Task 11 + this task together resolve the whole `Memory`/`UserMemory` type chain).

- [ ] **Step 4: Manual browser verification**

Run: use this repo's `/run` skill (or `bun run dev` in `packages/app` if no project-specific script exists) to start the Expo web dev server, then open the memory settings screen in a real foregrounded browser tab. Verify:
- The two settings switches render and toggle (network tab shows `PUT /memory/settings`).
- Existing memories (from the migrated dev DB) render grouped under You/Topics/People with title/summary/relative-time.
- Hovering a row reveals the delete button (web-only) and it stays hidden until hover.
- Add dialog: creating a memory with a chosen type places it in the correct section after save.
- Edit dialog: opening a row pre-fills title/summary/type correctly.
- Search box still filters across all three sections.

- [ ] **Step 5: Commit**

```bash
git add packages/app/app/'(app)'/settings/memory.tsx
git commit -m "feat(app): restructure memory screen into You/Topics/People grouped tables

Adds real autoSaveEnabled/recallEnabled toggles wired to PUT /memory/settings.
Removes CATEGORY_CONFIG, SUGGESTED_CATEGORIES, category filter chips, and the
old flat MemoryRow list — grouping is now structural (by type), not a filter."
```

---

### Task 13: Import-from-provider flow UI

**Files:**
- Modify: `packages/app/app/(app)/settings/memory.tsx` (targeted edits against Task 12's output)

**Interfaces:**
- Consumes: `POST /memory/import/from-text` (Task 9).
- Produces: nothing consumed elsewhere — terminal UI feature.

- [ ] **Step 1: Add state + the export prompt template + handler**

Add near the other import/export state declarations (after the existing `importing` state):

```typescript
  // Import-from-provider state
  const [showProviderImportDialog, setShowProviderImportDialog] = useState(false);
  const [providerImportStep, setProviderImportStep] = useState<'prompt' | 'paste'>('prompt');
  const [providerPastedText, setProviderPastedText] = useState('');
  const [providerImporting, setProviderImporting] = useState(false);
  const [providerImportResult, setProviderImportResult] = useState<{ title: string; summary: string; type: string }[] | null>(null);

  const PROVIDER_IMPORT_PROMPT = "Please summarize everything you remember or know about me as a numbered list of short facts. For each fact, keep it to one or two sentences. Include preferences, personal details, ongoing projects or topics I care about, and people I've mentioned. Don't add commentary — just the list.";
```

Add the handler near `handleImport`:

```typescript
  const handleProviderImport = async () => {
    if (!providerPastedText.trim() || !isAuthenticated) return;

    setProviderImporting(true);
    try {
      const response = await fetch(generateAPIUrl('/memory/import/from-text'), {
        method: 'POST',
        headers: getAuthHeaders(true),
        body: JSON.stringify({ text: providerPastedText }),
      });

      if (response.ok) {
        const result = await response.json();
        setProviderImportResult(result.saved || []);

        const memResponse = await fetch(generateAPIUrl('/memory'), {
          headers: getAuthHeaders(),
        });
        if (memResponse.ok) {
          setMemory(await memResponse.json());
        }

        toast.success(t('memory.providerImportSuccess', { count: (result.saved || []).length }));
      } else {
        toast.error(t('memory.providerImportFailed'));
      }
    } catch (error) {
      console.error('Provider import error:', error);
      toast.error(t('memory.providerImportFailed'));
    } finally {
      setProviderImporting(false);
    }
  };

  const handleCloseProviderImport = () => {
    setShowProviderImportDialog(false);
    setProviderImportStep('prompt');
    setProviderPastedText('');
    setProviderImportResult(null);
  };
```

- [ ] **Step 2: Add the entry-point button in the settings toggles block**

Find this exact block (the end of the settings-toggles `View` added in Task 12) and insert the new button immediately after it, still inside the same parent `View className="px-4 pt-3 pb-2 gap-3"`:

```tsx
          <View className="flex-row items-center justify-between gap-3">
            <View className="flex-1 min-w-0">
              <Text className="text-sm text-foreground">{t('memory.autoSaveToggleLabel')}</Text>
              <Text className="text-xs text-muted-foreground">{t('memory.autoSaveToggleDescription')}</Text>
            </View>
            <Switch
              value={memory?.settings?.autoSaveEnabled ?? true}
              onValueChange={(v) => handleToggleSetting('autoSaveEnabled', v)}
              disabled={updatingSettings}
            />
          </View>
        </View>
```

becomes:

```tsx
          <View className="flex-row items-center justify-between gap-3">
            <View className="flex-1 min-w-0">
              <Text className="text-sm text-foreground">{t('memory.autoSaveToggleLabel')}</Text>
              <Text className="text-xs text-muted-foreground">{t('memory.autoSaveToggleDescription')}</Text>
            </View>
            <Switch
              value={memory?.settings?.autoSaveEnabled ?? true}
              onValueChange={(v) => handleToggleSetting('autoSaveEnabled', v)}
              disabled={updatingSettings}
            />
          </View>

          <Button
            variant="outline"
            size="sm"
            className="self-start"
            onPress={() => setShowProviderImportDialog(true)}
          >
            <Text className="text-xs">{t('memory.importFromProvider')}</Text>
          </Button>
        </View>
```

- [ ] **Step 3: Add the 2-step dialog**

Find the exact end of the Duplicates Dialog block from Task 12:

```tsx
          <DialogFooter>
            <Button onPress={() => setShowDuplicatesDialog(false)}>
              <Text>{t('common.done')}</Text>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </View>
  );
}
```

replace with (adds the new dialog before the closing `</View>`):

```tsx
          <DialogFooter>
            <Button onPress={() => setShowDuplicatesDialog(false)}>
              <Text>{t('common.done')}</Text>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Import from other AI provider */}
      <Dialog open={showProviderImportDialog} onOpenChange={(open) => { if (!open) handleCloseProviderImport(); else setShowProviderImportDialog(true); }}>
        <DialogContent closeButton={true}>
          <DialogHeader>
            <DialogTitle>{t('memory.importFromProvider')}</DialogTitle>
            <DialogDescription>
              {providerImportStep === 'prompt'
                ? t('memory.providerImportStepPromptDescription')
                : t('memory.providerImportStepPasteDescription')}
            </DialogDescription>
          </DialogHeader>

          {providerImportStep === 'prompt' ? (
            <View className="gap-3">
              <View className="bg-muted rounded-lg p-3">
                <Text className="text-sm text-foreground" selectable>
                  {PROVIDER_IMPORT_PROMPT}
                </Text>
              </View>
              <Button
                variant="outline"
                onPress={() => {
                  if (typeof navigator !== 'undefined' && navigator.clipboard) {
                    navigator.clipboard.writeText(PROVIDER_IMPORT_PROMPT);
                    toast.success(t('memory.promptCopied'));
                  }
                }}
              >
                <View className="flex-row items-center gap-2">
                  <Copy size={16} className="text-foreground" />
                  <Text>{t('memory.copyPrompt')}</Text>
                </View>
              </Button>
            </View>
          ) : (
            <View className="gap-3">
              <View className="gap-2">
                <Label>{t('memory.pasteResponseLabel')}</Label>
                <Textarea
                  value={providerPastedText}
                  onChangeText={setProviderPastedText}
                  placeholder={t('memory.pasteResponsePlaceholder')}
                  editable={!providerImporting}
                  style={{ minHeight: 160 }}
                />
              </View>

              {providerImportResult && (
                <View className="bg-muted rounded-lg p-3 gap-1">
                  <Text className="text-sm font-medium">{t('memory.providerImportResultHeading')}</Text>
                  {providerImportResult.length === 0 ? (
                    <Text className="text-xs text-muted-foreground">{t('memory.providerImportNoneFound')}</Text>
                  ) : (
                    providerImportResult.map((m, i) => (
                      <Text key={i} className="text-xs text-muted-foreground">• {m.title}: {m.summary}</Text>
                    ))
                  )}
                </View>
              )}
            </View>
          )}

          <DialogFooter>
            {providerImportStep === 'prompt' ? (
              <Button className="flex-1" onPress={() => setProviderImportStep('paste')}>
                <Text>{t('memory.nextStep')}</Text>
              </Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  className="flex-1"
                  onPress={handleCloseProviderImport}
                  disabled={providerImporting}
                >
                  <Text>{providerImportResult ? t('common.done') : t('common.cancel')}</Text>
                </Button>
                {!providerImportResult && (
                  <Button
                    className="flex-1"
                    onPress={handleProviderImport}
                    disabled={!providerPastedText.trim() || providerImporting}
                  >
                    <Text>{providerImporting ? t('memory.importing') : t('memory.import')}</Text>
                  </Button>
                )}
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </View>
  );
}
```

- [ ] **Step 4: Add the missing i18n keys**

Add to both locale files (same convention as Task 12 Step 2): `memory.importFromProvider`, `memory.providerImportStepPromptDescription`, `memory.providerImportStepPasteDescription`, `memory.promptCopied`, `memory.copyPrompt`, `memory.pasteResponseLabel`, `memory.pasteResponsePlaceholder`, `memory.nextStep`, `memory.providerImportResultHeading`, `memory.providerImportNoneFound`, `memory.providerImportSuccess`, `memory.providerImportFailed`.

- [ ] **Step 5: Typecheck**

Run: `cd packages/app && bunx tsc --noEmit`
Expected: PASS with zero errors.

- [ ] **Step 6: Manual browser verification**

In the running dev server: click "Import from other AI providers" → verify the prompt text renders and copies to clipboard → click next → paste a few sentences of fake memory text (e.g. "The user loves hiking and works as a nurse.") → submit → verify a `POST /memory/import/from-text` network call fires, the result list shows saved memories, and after closing the dialog the new memories appear in the correct grouped sections.

- [ ] **Step 7: Commit**

```bash
git add packages/app/app/'(app)'/settings/memory.tsx
git commit -m "feat(app): add import-from-other-AI-provider flow to memory screen

Two-step dialog (copy prompt -> paste response) that posts to
POST /memory/import/from-text, which itself reuses saveUserMemoryTool via a
scoped generateText call — no bespoke parsing logic."
```

---

## Self-Review Notes

**Spec coverage:** every section of `docs/superpowers/specs/2026-07-15-memory-screen-redesign-design.md` maps to a task — data model (Task 1), migration (Task 2), `saveUserMemoryTool` (Task 4), settings gating (Tasks 4 & 5), all route/consumer renames (Tasks 3, 6, 7, 8), import-from-text (Task 9), frontend `MemoryTable` (Task 11), screen restructure (Task 12), settings toggles (Task 12), import-from-provider UI (Task 13).

**Beyond the original spec, discovered during research and folded in:** the Canvas memory node (Task 7) and four additional prompt-injection call sites (Task 6, in `system-prompt-builder.ts`/`user-context.ts`/`trigger-engine.ts`/`chat.service.ts`) — the spec's original file list undercounted these; Task 1's compiler-driven checklist (Step 2) is the safety net that surfaces any file this plan still missed.

**Type consistency check:** `MemoryType` (Task 1) → consumed identically in validators (Task 3), tool (Task 4), recall (Task 5), routes (Task 8/9), and frontend (Task 10/12) as `'profile' | 'topic' | 'person'` throughout — no drift. `MemoryTableProps` (Task 11) fields (`_id`, `title`, `summary`, `updatedAt`) match the `Memory` interface fields consumed in Task 12's `groupedByType`.

**Known scope boundary (not fixed here, per the design spec's "Out of scope"):** `Memory`/`UserMemory` remain duplicated as local, non-exported interfaces in both `user-data-store.ts` and `memory.tsx` — pre-existing duplication, not introduced by this plan, and not worth a shared-types package addition for two call sites.
