# SQLite Frontend Data Layer — Design Spec

## Context

Alia's frontend (Expo 55 / React Native) currently uses AsyncStorage + Zustand for all local persistence. This approach has scaling problems:

- **Whole-collection serialization**: Every update to projects/folders/roles re-serializes the entire JSON blob to AsyncStorage
- **No indexed queries**: Finding conversations in a project requires loading all data and filtering in JS
- **No full-text search**: Can't search message content locally
- **No offline queue**: Crude AsyncStorage fallback, no proper mutation queue or sync
- **Unbounded memory**: Full conversation message history loaded into memory on open

This spec replaces AsyncStorage with SQLite (`expo-sqlite`) as the primary local persistence layer, enabling indexed queries, FTS5 search, offline-first messaging, and efficient incremental updates — matching what production apps like ChatGPT do.

## Architecture

```
┌─────────────────────────────────────────────┐
│                React Components              │
├──────────────┬──────────────┬───────────────┤
│  Zustand     │  React Query │  DB Hooks     │
│  (UI state)  │  (API cache) │  (SQLite)     │
├──────────────┴──────┬───────┴───────────────┤
│         Repository Layer (typed helpers)      │
├─────────────────────┼───────────────────────┤
│              expo-sqlite (SQLite)             │
│  ┌──────────┐ ┌──────────┐ ┌──────────────┐ │
│  │ Tables   │ │ Indexes  │ │ FTS5 (search)│ │
│  └──────────┘ └──────────┘ └──────────────┘ │
└──────────────────────────────────────────────┘
```

### What changes
- AsyncStorage → SQLite for all persistent data
- Zustand stores become thin wrappers for UI-only state; persistent reads come from SQLite
- React Query stays for API cache freshness, but seeds SQLite on every fetch

### What stays the same
- React Query for API calls and server-state caching
- Zustand for ephemeral UI state (scroll position, modals, current selection)
- All API routes and backend (MongoDB/Mongoose) — completely unchanged
- @oxyhq/services for auth tokens (stays in its own secure storage)

## File Structure

```
apps/app/lib/db/
├── database.ts              -- singleton SQLiteDatabase + init
├── migrations.ts            -- version-based schema migrations
├── migrate-from-async.ts    -- one-time AsyncStorage → SQLite migration
├── repositories/
│   ├── conversations.ts     -- CRUD, pagination, search
│   ├── messages.ts          -- CRUD, FTS5 search
│   ├── projects.ts          -- CRUD, conversation linking
│   ├── folders.ts           -- CRUD, conversation linking
│   ├── roles.ts             -- CRUD, usage tracking
│   ├── preferences.ts       -- get/set key-value settings
│   ├── user-memory.ts       -- CRUD for memory items
│   └── sync-queue.ts        -- enqueue/dequeue offline ops
├── hooks/
│   ├── use-db.ts            -- DatabaseProvider + useDatabase() context
│   ├── use-conversations-db.ts
│   ├── use-messages-db.ts
│   ├── use-search.ts        -- FTS5 full-text search hook
│   └── use-sync.ts          -- background sync queue processor
└── types.ts                 -- TypeScript row interfaces
```

## Schema

### Core Data

```sql
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  title TEXT,
  source TEXT,                    -- 'web' | 'mobile' | 'extension' | 'api'
  agent_id TEXT,
  last_message TEXT,              -- preview text
  is_favorite INTEGER DEFAULT 0,
  is_pinned INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,    -- unix ms
  updated_at INTEGER NOT NULL,
  synced_at INTEGER               -- last server sync
);
CREATE INDEX idx_conv_updated ON conversations(updated_at DESC);
CREATE INDEX idx_conv_agent ON conversations(agent_id);
```

```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,              -- 'user' | 'assistant' | 'system' | 'tool'
  content TEXT,                   -- plain text or JSON array
  thinking TEXT,                  -- extended thinking
  tool_invocations TEXT,          -- JSON array
  source TEXT,                    -- 'text' | 'voice'
  speaker TEXT,                   -- 'primary' | 'cohost'
  agent_info TEXT,                -- JSON {id, name, avatar, handle}
  audio_url TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_msg_conv_created ON messages(conversation_id, created_at);
```

```sql
CREATE VIRTUAL TABLE messages_fts USING fts5(
  content,
  conversation_id UNINDEXED,
  content='messages',
  content_rowid='rowid'
);
-- Triggers to keep FTS in sync with messages table
CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content, conversation_id)
  VALUES (new.rowid, new.content, new.conversation_id);
END;
CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content, conversation_id)
  VALUES ('delete', old.rowid, old.content, old.conversation_id);
END;
CREATE TRIGGER messages_fts_update AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content, conversation_id)
  VALUES ('delete', old.rowid, old.content, old.conversation_id);
  INSERT INTO messages_fts(rowid, content, conversation_id)
  VALUES (new.rowid, new.content, new.conversation_id);
END;
```

### Organization

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  icon TEXT,
  color TEXT,
  is_expanded INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT,
  color TEXT,
  is_favorite INTEGER DEFAULT 0,
  is_expanded INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE collection_conversations (
  collection_type TEXT NOT NULL,    -- 'project' | 'folder'
  collection_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (collection_type, collection_id, conversation_id)
);
CREATE INDEX idx_cc_conv ON collection_conversations(conversation_id);
```

### Personalization

```sql
CREATE TABLE roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tagline TEXT,
  description TEXT,
  category TEXT,
  system_prompt TEXT,
  config TEXT,                    -- JSON: goodAt, notGoodAt, examplePrompts, priorities, tone, etc.
  is_custom INTEGER DEFAULT 0,
  is_featured INTEGER DEFAULT 0,
  usage_count INTEGER DEFAULT 0,
  rating REAL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE user_memory (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  category TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE preferences (
  key TEXT PRIMARY KEY,           -- 'theme', 'locale', 'response_length', etc.
  value TEXT NOT NULL             -- JSON-encoded value
);
```

### Sync

```sql
CREATE TABLE sync_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,      -- 'conversation' | 'message'
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,           -- 'create' | 'update' | 'delete'
  payload TEXT,                   -- JSON
  created_at INTEGER NOT NULL,
  attempts INTEGER DEFAULT 0
);
CREATE INDEX idx_sync_created ON sync_queue(created_at);
```

## Data Access Pattern

Each repository exports typed functions that take a `SQLiteDatabase` instance:

```typescript
// repositories/conversations.ts
import type { SQLiteDatabase } from 'expo-sqlite';
import type { ConversationRow } from '../types';

export function getConversations(
  db: SQLiteDatabase,
  opts: { limit: number; offset: number }
): Promise<ConversationRow[]> {
  return db.getAllAsync<ConversationRow>(
    'SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ? OFFSET ?',
    [opts.limit, opts.offset]
  );
}

export function getConversation(
  db: SQLiteDatabase,
  id: string
): Promise<ConversationRow | null> {
  return db.getFirstAsync<ConversationRow>(
    'SELECT * FROM conversations WHERE id = ?',
    [id]
  );
}

export function upsertConversation(
  db: SQLiteDatabase,
  conv: ConversationRow
): Promise<void> {
  return db.runAsync(
    `INSERT INTO conversations (id, title, source, agent_id, last_message, is_favorite, is_pinned, created_at, updated_at, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       last_message = excluded.last_message,
       is_favorite = excluded.is_favorite,
       is_pinned = excluded.is_pinned,
       updated_at = excluded.updated_at,
       synced_at = excluded.synced_at`,
    [conv.id, conv.title, conv.source, conv.agent_id, conv.last_message,
     conv.is_favorite ? 1 : 0, conv.is_pinned ? 1 : 0,
     conv.created_at, conv.updated_at, conv.synced_at]
  );
}

export function searchMessages(
  db: SQLiteDatabase,
  query: string,
  conversationId?: string
): Promise<MessageRow[]> {
  if (conversationId) {
    return db.getAllAsync<MessageRow>(
      `SELECT m.* FROM messages m
       JOIN messages_fts fts ON m.rowid = fts.rowid
       WHERE messages_fts MATCH ? AND fts.conversation_id = ?
       ORDER BY rank`,
      [query, conversationId]
    );
  }
  return db.getAllAsync<MessageRow>(
    `SELECT m.* FROM messages m
     JOIN messages_fts fts ON m.rowid = fts.rowid
     WHERE messages_fts MATCH ?
     ORDER BY rank`,
    [query]
  );
}
```

## Migration System

Version-based, append-only migrations:

```typescript
// migrations.ts
interface Migration {
  version: number;
  up: string; // SQL to execute
}

const MIGRATIONS: Migration[] = [
  { version: 1, up: `/* all CREATE TABLE statements from schema above */` },
  // Future: { version: 2, up: `ALTER TABLE conversations ADD COLUMN ...` },
];

export async function runMigrations(db: SQLiteDatabase): Promise<void> {
  await db.execAsync(
    'CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER)'
  );
  const result = await db.getFirstAsync<{ version: number }>(
    'SELECT MAX(version) as version FROM _migrations'
  );
  const currentVersion = result?.version ?? 0;

  for (const migration of MIGRATIONS) {
    if (migration.version > currentVersion) {
      await db.execAsync(migration.up);
      await db.runAsync(
        'INSERT INTO _migrations (version, applied_at) VALUES (?, ?)',
        [migration.version, Date.now()]
      );
    }
  }
}
```

## AsyncStorage → SQLite Migration

One-time migration on first app launch after update:

```typescript
// migrate-from-async.ts
export async function migrateFromAsyncStorage(db: SQLiteDatabase): Promise<void> {
  const done = await db.getFirstAsync<{ value: string }>(
    "SELECT value FROM preferences WHERE key = 'async_migration_complete'"
  );
  if (done) return;

  // 1. Preferences (theme, locale, organization)
  await migratePreferences(db);

  // 2. Projects
  await migrateProjects(db);

  // 3. Folders
  await migrateFolders(db);

  // 4. Favorites + Pinned
  await migrateFavorites(db);

  // 5. Roles
  await migrateRoles(db);

  // 6. User memory/data
  await migrateUserData(db);

  // 7. Cached conversations (if any in AsyncStorage)
  await migrateConversations(db);

  // Mark complete
  await db.runAsync(
    "INSERT INTO preferences (key, value) VALUES ('async_migration_complete', '1')"
  );
}
```

Each `migrate*` function reads from the specific AsyncStorage key, parses JSON, maps to SQLite row format, and bulk inserts. Old AsyncStorage keys are left intact (cleaned up in a later app version).

## Sync Queue Mechanism

### Offline writes
1. User creates conversation or sends message while offline
2. Data written to SQLite immediately (optimistic)
3. Entry added to `sync_queue` with action + payload
4. UI reflects the change instantly

### Reconnection sync
1. `use-sync` hook listens for network state via `@react-native-community/netinfo`
2. On reconnect, processes `sync_queue` entries in FIFO order
3. For each entry: call API, on success delete from queue, on failure increment `attempts`
4. After 5 failed attempts, mark for manual retry

### Server → client sync
1. On app foreground or pull-to-refresh, React Query fetches latest from API
2. Response data upserted into SQLite via repositories
3. `synced_at` timestamp updated on each synced row
4. Stale local-only data (never synced) kept until explicitly deleted

## Implementation Phases

### Phase 1: Foundation (no user-facing changes)
**Files to create:**
- `apps/app/lib/db/database.ts` — singleton, initialization
- `apps/app/lib/db/migrations.ts` — migration runner + v1 schema
- `apps/app/lib/db/types.ts` — row interfaces
- `apps/app/lib/db/hooks/use-db.ts` — DatabaseProvider + useDatabase()

**Files to modify:**
- `apps/app/app/_layout.tsx` — wrap app with DatabaseProvider

### Phase 2: Preferences & simple stores
**Files to create:**
- `apps/app/lib/db/repositories/preferences.ts`
- `apps/app/lib/db/migrate-from-async.ts` (initial: preferences only)

**Files to modify:**
- `apps/app/lib/stores/theme-store.ts` — read from SQLite, remove AsyncStorage persist
- `apps/app/lib/stores/i18n-store.ts` — same
- `apps/app/lib/stores/organization-store.ts` — same

### Phase 3: Collections (projects, folders, favorites, pinned)
**Files to create:**
- `apps/app/lib/db/repositories/projects.ts`
- `apps/app/lib/db/repositories/folders.ts`

**Files to modify:**
- `apps/app/lib/stores/projects-store.ts` — backed by SQLite
- `apps/app/lib/stores/folders-store.ts` — backed by SQLite
- `apps/app/lib/stores/favorites-store.ts` — replaced by `is_favorite` column
- `apps/app/lib/stores/pinned-store.ts` — replaced by `is_pinned` column
- `apps/app/lib/db/migrate-from-async.ts` — add collection migration

### Phase 4: Roles
**Files to create:**
- `apps/app/lib/db/repositories/roles.ts`

**Files to modify:**
- `apps/app/lib/stores/roles-store.ts` — backed by SQLite
- `apps/app/lib/db/migrate-from-async.ts` — add roles migration

### Phase 5: Conversations & Messages (biggest change)
**Files to create:**
- `apps/app/lib/db/repositories/conversations.ts`
- `apps/app/lib/db/repositories/messages.ts`
- `apps/app/lib/db/hooks/use-conversations-db.ts`
- `apps/app/lib/db/hooks/use-messages-db.ts`
- `apps/app/lib/db/hooks/use-search.ts`

**Files to modify:**
- `apps/app/lib/hooks/use-conversations.ts` — read from SQLite, sync with API
- `apps/app/hooks/useChatConversation.ts` — load messages from SQLite
- `apps/app/lib/db/migrate-from-async.ts` — add conversation migration

### Phase 6: Sync queue & offline mutations
**Files to create:**
- `apps/app/lib/db/repositories/sync-queue.ts`
- `apps/app/lib/db/hooks/use-sync.ts`
- `apps/app/lib/db/repositories/user-memory.ts`

**Files to modify:**
- `apps/app/hooks/useStreamingChat.ts` — write to SQLite + queue on offline
- `apps/app/lib/db/migrate-from-async.ts` — add user memory migration

## Verification

After each phase:
1. Run `bun run build:frontend` — ensure no TypeScript errors
2. Test on device/simulator — verify data persists across app restarts
3. Test migration — install old version, add data, upgrade, verify data migrated
4. Test offline — disable network, verify CRUD operations work locally
5. After Phase 5: test FTS search across conversations
6. After Phase 6: test offline message send → reconnect → verify sync

## Dependencies

```json
{
  "expo-sqlite": "latest compatible with Expo 55"
}
```

No other new dependencies. `@react-native-community/netinfo` may already be installed; if not, add it for Phase 6.
