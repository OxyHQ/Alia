# SQLite Frontend Data Layer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace AsyncStorage with expo-sqlite as the primary local persistence layer for conversations, messages, projects, folders, roles, favorites, preferences, and user memory — enabling indexed queries, FTS5 search, offline-first messaging, and efficient incremental writes.

**Architecture:** Typed repository functions over raw expo-sqlite. Zustand stores become thin wrappers reading from SQLite. React Query stays for API cache. One-time migration moves existing AsyncStorage data to SQLite on first launch.

**Tech Stack:** expo-sqlite, Zustand, TanStack React Query, TypeScript

---

## File Structure

```
apps/app/lib/db/
├── database.ts              -- singleton + init (DatabaseProvider, useDatabase)
├── migrations.ts            -- version-based schema migrations
├── migrate-from-async.ts    -- one-time AsyncStorage → SQLite data migration
├── types.ts                 -- TypeScript row interfaces for all tables
├── repositories/
│   ├── preferences.ts       -- get/set key-value preferences
│   ├── projects.ts          -- projects CRUD + conversation linking
│   ├── folders.ts           -- folders CRUD + conversation linking
│   ├── roles.ts             -- roles CRUD + default seeding + usage tracking
│   ├── conversations.ts     -- conversations CRUD + pagination
│   ├── messages.ts          -- messages CRUD + FTS5 search
│   ├── user-memory.ts       -- user memory items CRUD
│   └── sync-queue.ts        -- enqueue/dequeue offline operations
└── hooks/
    ├── use-conversations-db.ts  -- React hooks wrapping conversation + message repos
    └── use-search.ts            -- FTS5 full-text search hook
```

---

## Task 1: Install expo-sqlite and create database foundation

**Files:**
- Create: `apps/app/lib/db/types.ts`
- Create: `apps/app/lib/db/migrations.ts`
- Create: `apps/app/lib/db/database.ts`
- Modify: `apps/app/app/_layout.tsx`

- [ ] **Step 1: Install expo-sqlite**

```bash
cd apps/app && bun add expo-sqlite
```

- [ ] **Step 2: Create row type interfaces**

Create `apps/app/lib/db/types.ts`:

```typescript
export interface ConversationRow {
  id: string;
  title: string | null;
  source: string | null;
  agent_id: string | null;
  last_message: string | null;
  is_favorite: number; // 0 or 1
  is_pinned: number;   // 0 or 1
  created_at: number;  // unix ms
  updated_at: number;
  synced_at: number | null;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string | null;
  thinking: string | null;
  tool_invocations: string | null; // JSON array
  source: string | null;
  speaker: string | null;
  agent_info: string | null; // JSON object
  audio_url: string | null;
  created_at: number;
}

export interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  is_expanded: number;
  created_at: number;
  updated_at: number;
}

export interface FolderRow {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
  is_favorite: number;
  is_expanded: number;
  created_at: number;
  updated_at: number;
}

export interface CollectionConversationRow {
  collection_type: string; // 'project' | 'folder'
  collection_id: string;
  conversation_id: string;
  added_at: number;
}

export interface RoleRow {
  id: string;
  name: string;
  tagline: string | null;
  description: string | null;
  category: string | null;
  system_prompt: string | null;
  config: string | null; // JSON blob
  is_custom: number;
  is_featured: number;
  usage_count: number;
  rating: number;
  created_at: number;
  updated_at: number;
}

export interface UserMemoryRow {
  id: string;
  key: string;
  value: string;
  category: string | null;
  created_at: number;
  updated_at: number;
}

export interface PreferenceRow {
  key: string;
  value: string; // JSON-encoded
}

export interface SyncQueueRow {
  id: number;
  entity_type: string;
  entity_id: string;
  action: string;
  payload: string | null; // JSON
  created_at: number;
  attempts: number;
}
```

- [ ] **Step 3: Create migration system**

Create `apps/app/lib/db/migrations.ts`:

```typescript
import type { SQLiteDatabase } from 'expo-sqlite';

interface Migration {
  version: number;
  up: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT,
        source TEXT,
        agent_id TEXT,
        last_message TEXT,
        is_favorite INTEGER DEFAULT 0,
        is_pinned INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        synced_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_conv_updated ON conversations(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_conv_agent ON conversations(agent_id);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT,
        thinking TEXT,
        tool_invocations TEXT,
        source TEXT,
        speaker TEXT,
        agent_info TEXT,
        audio_url TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_msg_conv_created ON messages(conversation_id, created_at);

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        icon TEXT,
        color TEXT,
        is_expanded INTEGER DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS folders (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        icon TEXT,
        color TEXT,
        is_favorite INTEGER DEFAULT 0,
        is_expanded INTEGER DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS collection_conversations (
        collection_type TEXT NOT NULL,
        collection_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        added_at INTEGER NOT NULL,
        PRIMARY KEY (collection_type, collection_id, conversation_id)
      );
      CREATE INDEX IF NOT EXISTS idx_cc_conv ON collection_conversations(conversation_id);

      CREATE TABLE IF NOT EXISTS roles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        tagline TEXT,
        description TEXT,
        category TEXT,
        system_prompt TEXT,
        config TEXT,
        is_custom INTEGER DEFAULT 0,
        is_featured INTEGER DEFAULT 0,
        usage_count INTEGER DEFAULT 0,
        rating REAL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS user_memory (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        category TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS preferences (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sync_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        action TEXT NOT NULL,
        payload TEXT,
        created_at INTEGER NOT NULL,
        attempts INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_sync_created ON sync_queue(created_at);
    `,
  },
  {
    version: 2,
    up: `
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content,
        conversation_id UNINDEXED,
        content='messages',
        content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content, conversation_id)
        VALUES (new.rowid, new.content, new.conversation_id);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content, conversation_id)
        VALUES ('delete', old.rowid, old.content, old.conversation_id);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content, conversation_id)
        VALUES ('delete', old.rowid, old.content, old.conversation_id);
        INSERT INTO messages_fts(rowid, content, conversation_id)
        VALUES (new.rowid, new.content, new.conversation_id);
      END;
    `,
  },
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

- [ ] **Step 4: Create database singleton with provider**

Create `apps/app/lib/db/database.ts`:

```typescript
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { openDatabaseSync, type SQLiteDatabase } from 'expo-sqlite';
import { runMigrations } from './migrations';

const DB_NAME = 'alia.db';

let dbInstance: SQLiteDatabase | null = null;

export function getDatabase(): SQLiteDatabase {
  if (!dbInstance) {
    dbInstance = openDatabaseSync(DB_NAME, { enableChangeListener: true });
    dbInstance.execSync('PRAGMA journal_mode = WAL');
    dbInstance.execSync('PRAGMA foreign_keys = ON');
  }
  return dbInstance;
}

const DatabaseContext = createContext<SQLiteDatabase | null>(null);

export function useDatabase(): SQLiteDatabase {
  const db = useContext(DatabaseContext);
  if (!db) {
    throw new Error('useDatabase must be used within a DatabaseProvider');
  }
  return db;
}

interface DatabaseProviderProps {
  children: ReactNode;
}

export function DatabaseProvider({ children }: DatabaseProviderProps) {
  const [db, setDb] = useState<SQLiteDatabase | null>(null);

  useEffect(() => {
    async function init() {
      const database = getDatabase();
      await runMigrations(database);
      setDb(database);
    }
    init();
  }, []);

  if (!db) return null; // Block render until DB is ready

  return (
    <DatabaseContext.Provider value={db}>
      {children}
    </DatabaseContext.Provider>
  );
}
```

- [ ] **Step 5: Wire DatabaseProvider into app layout**

Modify `apps/app/app/_layout.tsx`. Add import at top:

```typescript
import { DatabaseProvider } from '@/lib/db/database';
```

Wrap the return of `RootLayout` so `DatabaseProvider` sits inside `OxyProvider` but outside `AppContent`:

```typescript
function RootLayout() {
  const [loaded, error] = useFonts({
    SpaceMono: require('../assets/fonts/SpaceMono-Regular.ttf'),
    Inter: require('../assets/fonts/Inter-VariableFont_opsz,wght.ttf'),
    'Inter-Italic': require('../assets/fonts/Inter-Italic-VariableFont_opsz,wght.ttf'),
    ...FontAwesome.font,
  });

  useEffect(() => {
    if (error) throw error;
  }, [error]);

  useEffect(() => {
    if (loaded) SplashScreen.hideAsync();
  }, [loaded]);

  if (!loaded) return null;

  return (
    <AppErrorBoundary>
      <OxyProvider
        baseURL={OXY_API_URL}
        authRedirectUri={Platform.OS !== 'web' ? AUTH_REDIRECT_URI : undefined}
      >
        <DatabaseProvider>
          <AppContent />
        </DatabaseProvider>
      </OxyProvider>
    </AppErrorBoundary>
  );
}
```

- [ ] **Step 6: Verify build**

```bash
cd /home/nate/Oxy/Alia && bun run build:frontend
```

Expected: Build succeeds, no TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add apps/app/lib/db/types.ts apps/app/lib/db/migrations.ts apps/app/lib/db/database.ts apps/app/app/_layout.tsx apps/app/package.json bun.lock
git commit -m "feat: add SQLite foundation with expo-sqlite, migrations, and DatabaseProvider"
```

---

## Task 2: Preferences repository — migrate theme, locale, organization stores

**Files:**
- Create: `apps/app/lib/db/repositories/preferences.ts`
- Modify: `apps/app/lib/stores/theme-store.ts`
- Modify: `apps/app/lib/stores/i18n-store.ts`
- Modify: `apps/app/lib/stores/organization-store.ts`

- [ ] **Step 1: Create preferences repository**

Create `apps/app/lib/db/repositories/preferences.ts`:

```typescript
import type { SQLiteDatabase } from 'expo-sqlite';

export function getPreference(db: SQLiteDatabase, key: string): string | null {
  const row = db.getFirstSync<{ value: string }>('SELECT value FROM preferences WHERE key = ?', [key]);
  return row?.value ?? null;
}

export function setPreference(db: SQLiteDatabase, key: string, value: string): void {
  db.runSync(
    'INSERT INTO preferences (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value]
  );
}

export function deletePreference(db: SQLiteDatabase, key: string): void {
  db.runSync('DELETE FROM preferences WHERE key = ?', [key]);
}

export function getAllPreferences(db: SQLiteDatabase): Record<string, string> {
  const rows = db.getAllSync<{ key: string; value: string }>('SELECT key, value FROM preferences');
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}
```

- [ ] **Step 2: Rewrite theme-store to use SQLite**

Replace `apps/app/lib/stores/theme-store.ts` with:

```typescript
import { create } from 'zustand';
import { Platform } from 'react-native';
import { type AppColorName, applyAppColorToDocument } from '../app-color-presets';
import { setColorSchemeSafe } from '../set-color-scheme-safe';
import { getDatabase } from '../db/database';
import { getPreference, setPreference } from '../db/repositories/preferences';

export type ThemeMode = 'light' | 'dark' | 'system';

interface ThemeState {
  mode: ThemeMode;
  appColor: AppColorName;
  hydrated: boolean;
  setMode: (mode: ThemeMode) => void;
  setAppColor: (color: AppColorName) => void;
  hydrate: () => void;
}

export const useThemeStore = create<ThemeState>((set) => ({
  mode: 'system',
  appColor: 'purple',
  hydrated: false,

  setMode: (mode: ThemeMode) => {
    const db = getDatabase();
    setPreference(db, 'theme_mode', mode);
    set({ mode });
  },

  setAppColor: (appColor: AppColorName) => {
    const db = getDatabase();
    setPreference(db, 'theme_app_color', appColor);
    set({ appColor });
  },

  hydrate: () => {
    const db = getDatabase();
    const mode = (getPreference(db, 'theme_mode') as ThemeMode) ?? 'system';
    const appColor = (getPreference(db, 'theme_app_color') as AppColorName) ?? 'purple';

    setColorSchemeSafe(mode);
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      const resolved = mode === 'system'
        ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : mode;
      document.documentElement.classList.toggle('dark', resolved === 'dark');
      if (appColor !== 'purple') {
        applyAppColorToDocument(appColor, resolved as 'light' | 'dark');
      }
    }

    set({ mode, appColor, hydrated: true });
  },
}));
```

- [ ] **Step 3: Rewrite i18n-store to use SQLite**

Replace `apps/app/lib/stores/i18n-store.ts` with:

```typescript
import { create } from 'zustand';
import { getLocales } from 'expo-localization';
import i18n from '@/lib/i18n';
import { getDatabase } from '../db/database';
import { getPreference, setPreference } from '../db/repositories/preferences';

function getDeviceLocale(): string {
  const locales = getLocales();
  if (!locales || locales.length === 0) return 'en-US';
  return locales[0]?.languageTag || locales[0]?.languageCode || 'en-US';
}

interface I18nState {
  locale: string;
  hydrated: boolean;
  setLocale: (locale: string) => void;
  hydrate: () => void;
}

export const useI18nStore = create<I18nState>((set) => ({
  locale: getDeviceLocale(),
  hydrated: false,

  setLocale: (locale: string) => {
    const db = getDatabase();
    setPreference(db, 'i18n_locale', locale);
    i18n.locale = locale;
    set({ locale });
  },

  hydrate: () => {
    const db = getDatabase();
    const locale = getPreference(db, 'i18n_locale') ?? getDeviceLocale();
    i18n.locale = locale;
    set({ locale, hydrated: true });
  },
}));
```

- [ ] **Step 4: Rewrite organization-store to use SQLite**

Replace `apps/app/lib/stores/organization-store.ts` with:

```typescript
import { create } from 'zustand';
import { getDatabase } from '../db/database';
import { getPreference, setPreference, deletePreference } from '../db/repositories/preferences';

interface OrganizationState {
  selectedOrgId: string | null;
  hydrated: boolean;
  setSelectedOrg: (orgId: string | null) => void;
  hydrate: () => void;
}

export const useOrganizationStore = create<OrganizationState>((set) => ({
  selectedOrgId: null,
  hydrated: false,

  setSelectedOrg: (orgId) => {
    const db = getDatabase();
    if (orgId) {
      setPreference(db, 'selected_org_id', orgId);
    } else {
      deletePreference(db, 'selected_org_id');
    }
    set({ selectedOrgId: orgId });
  },

  hydrate: () => {
    const db = getDatabase();
    const selectedOrgId = getPreference(db, 'selected_org_id');
    set({ selectedOrgId, hydrated: true });
  },
}));
```

- [ ] **Step 5: Verify build**

```bash
cd /home/nate/Oxy/Alia && bun run build:frontend
```

Expected: Build succeeds. The stores now read/write from SQLite instead of AsyncStorage. Existing users will start with default values until the migration (Task 7) runs.

- [ ] **Step 6: Commit**

```bash
git add apps/app/lib/db/repositories/preferences.ts apps/app/lib/stores/theme-store.ts apps/app/lib/stores/i18n-store.ts apps/app/lib/stores/organization-store.ts
git commit -m "feat: migrate theme, i18n, and organization stores to SQLite preferences"
```

---

## Task 3: Projects and folders repositories — replace CollectionPersister

**Files:**
- Create: `apps/app/lib/db/repositories/projects.ts`
- Create: `apps/app/lib/db/repositories/folders.ts`
- Modify: `apps/app/lib/stores/projects-store.ts`
- Modify: `apps/app/lib/stores/folders-store.ts`

- [ ] **Step 1: Create projects repository**

Create `apps/app/lib/db/repositories/projects.ts`:

```typescript
import type { SQLiteDatabase } from 'expo-sqlite';
import type { ProjectRow, CollectionConversationRow } from '../types';

export function getAllProjects(db: SQLiteDatabase): ProjectRow[] {
  return db.getAllSync<ProjectRow>('SELECT * FROM projects ORDER BY updated_at DESC');
}

export function getProject(db: SQLiteDatabase, id: string): ProjectRow | null {
  return db.getFirstSync<ProjectRow>('SELECT * FROM projects WHERE id = ?', [id]) ?? null;
}

export function insertProject(db: SQLiteDatabase, project: ProjectRow): void {
  db.runSync(
    `INSERT INTO projects (id, name, description, icon, color, is_expanded, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [project.id, project.name, project.description, project.icon, project.color,
     project.is_expanded, project.created_at, project.updated_at]
  );
}

export function updateProject(db: SQLiteDatabase, id: string, updates: Partial<ProjectRow>): void {
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
  if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description); }
  if (updates.icon !== undefined) { fields.push('icon = ?'); values.push(updates.icon); }
  if (updates.color !== undefined) { fields.push('color = ?'); values.push(updates.color); }
  if (updates.is_expanded !== undefined) { fields.push('is_expanded = ?'); values.push(updates.is_expanded); }

  fields.push('updated_at = ?');
  values.push(Date.now());
  values.push(id);

  db.runSync(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`, values);
}

export function deleteProject(db: SQLiteDatabase, id: string): void {
  db.runSync('DELETE FROM collection_conversations WHERE collection_type = ? AND collection_id = ?', ['project', id]);
  db.runSync('DELETE FROM projects WHERE id = ?', [id]);
}

export function getProjectConversationIds(db: SQLiteDatabase, projectId: string): string[] {
  const rows = db.getAllSync<{ conversation_id: string }>(
    'SELECT conversation_id FROM collection_conversations WHERE collection_type = ? AND collection_id = ? ORDER BY added_at',
    ['project', projectId]
  );
  return rows.map((r) => r.conversation_id);
}

export function addConversationToProject(db: SQLiteDatabase, projectId: string, conversationId: string): void {
  db.runSync(
    `INSERT OR IGNORE INTO collection_conversations (collection_type, collection_id, conversation_id, added_at)
     VALUES (?, ?, ?, ?)`,
    ['project', projectId, conversationId, Date.now()]
  );
  db.runSync('UPDATE projects SET updated_at = ? WHERE id = ?', [Date.now(), projectId]);
}

export function removeConversationFromProject(db: SQLiteDatabase, projectId: string, conversationId: string): void {
  db.runSync(
    'DELETE FROM collection_conversations WHERE collection_type = ? AND collection_id = ? AND conversation_id = ?',
    ['project', projectId, conversationId]
  );
  db.runSync('UPDATE projects SET updated_at = ? WHERE id = ?', [Date.now(), projectId]);
}

export function getCollectionsForConversation(db: SQLiteDatabase, conversationId: string, type: string): string[] {
  const rows = db.getAllSync<{ collection_id: string }>(
    'SELECT collection_id FROM collection_conversations WHERE collection_type = ? AND conversation_id = ?',
    [type, conversationId]
  );
  return rows.map((r) => r.collection_id);
}
```

- [ ] **Step 2: Create folders repository**

Create `apps/app/lib/db/repositories/folders.ts`:

```typescript
import type { SQLiteDatabase } from 'expo-sqlite';
import type { FolderRow } from '../types';

export function getAllFolders(db: SQLiteDatabase): FolderRow[] {
  return db.getAllSync<FolderRow>('SELECT * FROM folders ORDER BY updated_at DESC');
}

export function getFolder(db: SQLiteDatabase, id: string): FolderRow | null {
  return db.getFirstSync<FolderRow>('SELECT * FROM folders WHERE id = ?', [id]) ?? null;
}

export function insertFolder(db: SQLiteDatabase, folder: FolderRow): void {
  db.runSync(
    `INSERT INTO folders (id, name, icon, color, is_favorite, is_expanded, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [folder.id, folder.name, folder.icon, folder.color, folder.is_favorite,
     folder.is_expanded, folder.created_at, folder.updated_at]
  );
}

export function updateFolder(db: SQLiteDatabase, id: string, updates: Partial<FolderRow>): void {
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
  if (updates.icon !== undefined) { fields.push('icon = ?'); values.push(updates.icon); }
  if (updates.color !== undefined) { fields.push('color = ?'); values.push(updates.color); }
  if (updates.is_favorite !== undefined) { fields.push('is_favorite = ?'); values.push(updates.is_favorite); }
  if (updates.is_expanded !== undefined) { fields.push('is_expanded = ?'); values.push(updates.is_expanded); }

  fields.push('updated_at = ?');
  values.push(Date.now());
  values.push(id);

  db.runSync(`UPDATE folders SET ${fields.join(', ')} WHERE id = ?`, values);
}

export function deleteFolder(db: SQLiteDatabase, id: string): void {
  db.runSync('DELETE FROM collection_conversations WHERE collection_type = ? AND collection_id = ?', ['folder', id]);
  db.runSync('DELETE FROM folders WHERE id = ?', [id]);
}

export function getFolderConversationIds(db: SQLiteDatabase, folderId: string): string[] {
  const rows = db.getAllSync<{ conversation_id: string }>(
    'SELECT conversation_id FROM collection_conversations WHERE collection_type = ? AND collection_id = ? ORDER BY added_at',
    ['folder', folderId]
  );
  return rows.map((r) => r.conversation_id);
}

export function addConversationToFolder(db: SQLiteDatabase, folderId: string, conversationId: string): void {
  db.runSync(
    `INSERT OR IGNORE INTO collection_conversations (collection_type, collection_id, conversation_id, added_at)
     VALUES (?, ?, ?, ?)`,
    ['folder', folderId, conversationId, Date.now()]
  );
  db.runSync('UPDATE folders SET updated_at = ? WHERE id = ?', [Date.now(), folderId]);
}

export function removeConversationFromFolder(db: SQLiteDatabase, folderId: string, conversationId: string): void {
  db.runSync(
    'DELETE FROM collection_conversations WHERE collection_type = ? AND collection_id = ? AND conversation_id = ?',
    ['folder', folderId, conversationId]
  );
  db.runSync('UPDATE folders SET updated_at = ? WHERE id = ?', [Date.now(), folderId]);
}
```

- [ ] **Step 3: Rewrite projects-store to use SQLite**

Replace `apps/app/lib/stores/projects-store.ts` with:

```typescript
import { create } from 'zustand';
import { getDatabase } from '../db/database';
import { getPreference, setPreference, deletePreference } from '../db/repositories/preferences';
import {
  getAllProjects, insertProject, updateProject as updateProjectDb,
  deleteProject as deleteProjectDb, getProjectConversationIds,
  addConversationToProject as addConvDb, removeConversationFromProject as removeConvDb,
} from '../db/repositories/projects';
import { getRandomColor, getRandomIcon, type CollectionItem } from './create-collection-store';
import type { ProjectRow } from '../db/types';

export interface Project extends CollectionItem {
  description?: string;
}

const PROJECT_ICONS = [
  'FolderOpen', 'Briefcase', 'Folder', 'Package', 'Rocket',
  'Target', 'Lightbulb', 'Star', 'Heart', 'Zap',
];

function rowToProject(row: ProjectRow, conversationIds: string[]): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    icon: row.icon ?? undefined,
    color: row.color ?? undefined,
    conversationIds,
    isExpanded: row.is_expanded === 1,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

interface ProjectsStoreState {
  projects: Project[];
  currentProjectId: string | null;
  loadProjects: () => void;
  createProject: (name: string, description?: string, icon?: string) => void;
  updateProject: (id: string, updates: Partial<Project>) => void;
  deleteProject: (id: string) => void;
  setCurrentProject: (id: string | null) => void;
  toggleProject: (id: string) => void;
  addConversationToProject: (projectId: string, conversationId: string) => void;
  removeConversationFromProject: (projectId: string, conversationId: string) => void;
}

export const useProjectsStore = create<ProjectsStoreState>((set, get) => ({
  projects: [],
  currentProjectId: null,

  loadProjects: () => {
    const db = getDatabase();
    const rows = getAllProjects(db);
    const projects = rows.map((row) => rowToProject(row, getProjectConversationIds(db, row.id)));
    const currentProjectId = getPreference(db, 'current_project_id');
    set({ projects, currentProjectId });
  },

  createProject: (name, description, icon) => {
    const db = getDatabase();
    const now = Date.now();
    const row: ProjectRow = {
      id: `project-${now}`,
      name,
      description: description ?? null,
      icon: icon ?? getRandomIcon(PROJECT_ICONS),
      color: getRandomColor(),
      is_expanded: 1,
      created_at: now,
      updated_at: now,
    };
    insertProject(db, row);
    get().loadProjects();
  },

  updateProject: (id, updates) => {
    const db = getDatabase();
    const dbUpdates: Partial<ProjectRow> = {};
    if (updates.name !== undefined) dbUpdates.name = updates.name;
    if (updates.description !== undefined) dbUpdates.description = updates.description ?? null;
    if (updates.icon !== undefined) dbUpdates.icon = updates.icon ?? null;
    if (updates.color !== undefined) dbUpdates.color = updates.color ?? null;
    if (updates.isExpanded !== undefined) dbUpdates.is_expanded = updates.isExpanded ? 1 : 0;
    updateProjectDb(db, id, dbUpdates);
    get().loadProjects();
  },

  deleteProject: (id) => {
    const db = getDatabase();
    const state = get();
    deleteProjectDb(db, id);
    if (state.currentProjectId === id) {
      deletePreference(db, 'current_project_id');
    }
    get().loadProjects();
  },

  setCurrentProject: (id) => {
    const db = getDatabase();
    if (id) {
      setPreference(db, 'current_project_id', id);
    } else {
      deletePreference(db, 'current_project_id');
    }
    set({ currentProjectId: id });
  },

  toggleProject: (id) => {
    const db = getDatabase();
    const project = get().projects.find((p) => p.id === id);
    if (project) {
      updateProjectDb(db, id, { is_expanded: project.isExpanded ? 0 : 1 });
      get().loadProjects();
    }
  },

  addConversationToProject: (projectId, conversationId) => {
    const db = getDatabase();
    addConvDb(db, projectId, conversationId);
    get().loadProjects();
  },

  removeConversationFromProject: (projectId, conversationId) => {
    const db = getDatabase();
    removeConvDb(db, projectId, conversationId);
    get().loadProjects();
  },
}));
```

- [ ] **Step 4: Rewrite folders-store to use SQLite**

Replace `apps/app/lib/stores/folders-store.ts` with:

```typescript
import { create } from 'zustand';
import { getDatabase } from '../db/database';
import {
  getAllFolders, insertFolder, updateFolder as updateFolderDb,
  deleteFolder as deleteFolderDb, getFolderConversationIds,
  addConversationToFolder as addConvDb, removeConversationFromFolder as removeConvDb,
} from '../db/repositories/folders';
import { getRandomColor, getRandomIcon, type CollectionItem } from './create-collection-store';
import type { FolderRow } from '../db/types';

export interface Folder extends CollectionItem {
  isFavorite?: boolean;
}

const FOLDER_ICONS = ['Folder', 'FolderOpen', 'FolderClosed', 'Archive', 'Inbox', 'BookMarked'];

function rowToFolder(row: FolderRow, conversationIds: string[]): Folder {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon ?? undefined,
    color: row.color ?? undefined,
    isFavorite: row.is_favorite === 1,
    conversationIds,
    isExpanded: row.is_expanded === 1,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

interface FoldersStoreState {
  folders: Folder[];
  loadFolders: () => void;
  createFolder: (name: string, icon?: string) => void;
  updateFolder: (id: string, updates: Partial<Folder>) => void;
  deleteFolder: (id: string) => void;
  toggleFolder: (id: string) => void;
  addConversationToFolder: (folderId: string, conversationId: string) => void;
  removeConversationFromFolder: (folderId: string, conversationId: string) => void;
}

export const useFoldersStore = create<FoldersStoreState>((set, get) => ({
  folders: [],

  loadFolders: () => {
    const db = getDatabase();
    const rows = getAllFolders(db);
    const folders = rows.map((row) => rowToFolder(row, getFolderConversationIds(db, row.id)));
    set({ folders });
  },

  createFolder: (name, icon) => {
    const db = getDatabase();
    const now = Date.now();
    const row: FolderRow = {
      id: `folder-${now}`,
      name,
      icon: icon ?? getRandomIcon(FOLDER_ICONS),
      color: getRandomColor(),
      is_favorite: 0,
      is_expanded: 1,
      created_at: now,
      updated_at: now,
    };
    insertFolder(db, row);
    get().loadFolders();
  },

  updateFolder: (id, updates) => {
    const db = getDatabase();
    const dbUpdates: Partial<FolderRow> = {};
    if (updates.name !== undefined) dbUpdates.name = updates.name;
    if (updates.icon !== undefined) dbUpdates.icon = updates.icon ?? null;
    if (updates.color !== undefined) dbUpdates.color = updates.color ?? null;
    if (updates.isFavorite !== undefined) dbUpdates.is_favorite = updates.isFavorite ? 1 : 0;
    if (updates.isExpanded !== undefined) dbUpdates.is_expanded = updates.isExpanded ? 1 : 0;
    updateFolderDb(db, id, dbUpdates);
    get().loadFolders();
  },

  deleteFolder: (id) => {
    const db = getDatabase();
    deleteFolderDb(db, id);
    get().loadFolders();
  },

  toggleFolder: (id) => {
    const db = getDatabase();
    const folder = get().folders.find((f) => f.id === id);
    if (folder) {
      updateFolderDb(db, id, { is_expanded: folder.isExpanded ? 0 : 1 });
      get().loadFolders();
    }
  },

  addConversationToFolder: (folderId, conversationId) => {
    const db = getDatabase();
    addConvDb(db, folderId, conversationId);
    get().loadFolders();
  },

  removeConversationFromFolder: (folderId, conversationId) => {
    const db = getDatabase();
    removeConvDb(db, folderId, conversationId);
    get().loadFolders();
  },
}));
```

- [ ] **Step 5: Verify build**

```bash
cd /home/nate/Oxy/Alia && bun run build:frontend
```

- [ ] **Step 6: Commit**

```bash
git add apps/app/lib/db/repositories/projects.ts apps/app/lib/db/repositories/folders.ts apps/app/lib/stores/projects-store.ts apps/app/lib/stores/folders-store.ts
git commit -m "feat: migrate projects and folders stores to SQLite repositories"
```

---

## Task 4: Roles repository — replace JSON-blob storage

**Files:**
- Create: `apps/app/lib/db/repositories/roles.ts`
- Modify: `apps/app/lib/stores/roles-store.ts`

- [ ] **Step 1: Create roles repository**

Create `apps/app/lib/db/repositories/roles.ts`:

```typescript
import type { SQLiteDatabase } from 'expo-sqlite';
import type { RoleRow } from '../types';

export function getAllRoles(db: SQLiteDatabase): RoleRow[] {
  return db.getAllSync<RoleRow>('SELECT * FROM roles ORDER BY usage_count DESC, name ASC');
}

export function getRole(db: SQLiteDatabase, id: string): RoleRow | null {
  return db.getFirstSync<RoleRow>('SELECT * FROM roles WHERE id = ?', [id]) ?? null;
}

export function insertRole(db: SQLiteDatabase, role: RoleRow): void {
  db.runSync(
    `INSERT OR REPLACE INTO roles (id, name, tagline, description, category, system_prompt, config, is_custom, is_featured, usage_count, rating, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [role.id, role.name, role.tagline, role.description, role.category,
     role.system_prompt, role.config, role.is_custom, role.is_featured,
     role.usage_count, role.rating, role.created_at, role.updated_at]
  );
}

export function updateRole(db: SQLiteDatabase, id: string, updates: Partial<RoleRow>): void {
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
  if (updates.tagline !== undefined) { fields.push('tagline = ?'); values.push(updates.tagline); }
  if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description); }
  if (updates.category !== undefined) { fields.push('category = ?'); values.push(updates.category); }
  if (updates.system_prompt !== undefined) { fields.push('system_prompt = ?'); values.push(updates.system_prompt); }
  if (updates.config !== undefined) { fields.push('config = ?'); values.push(updates.config); }
  if (updates.is_featured !== undefined) { fields.push('is_featured = ?'); values.push(updates.is_featured); }
  if (updates.usage_count !== undefined) { fields.push('usage_count = ?'); values.push(updates.usage_count); }
  if (updates.rating !== undefined) { fields.push('rating = ?'); values.push(updates.rating); }

  if (fields.length === 0) return;

  fields.push('updated_at = ?');
  values.push(Date.now());
  values.push(id);

  db.runSync(`UPDATE roles SET ${fields.join(', ')} WHERE id = ?`, values);
}

export function deleteRole(db: SQLiteDatabase, id: string): void {
  db.runSync('DELETE FROM roles WHERE id = ?', [id]);
}

export function incrementRoleUsage(db: SQLiteDatabase, id: string): void {
  db.runSync(
    'UPDATE roles SET usage_count = usage_count + 1, updated_at = ? WHERE id = ?',
    [Date.now(), id]
  );
}

export function getRolesCount(db: SQLiteDatabase): number {
  const row = db.getFirstSync<{ count: number }>('SELECT COUNT(*) as count FROM roles');
  return row?.count ?? 0;
}
```

- [ ] **Step 2: Rewrite roles-store to use SQLite**

Replace `apps/app/lib/stores/roles-store.ts` with:

```typescript
import { create } from 'zustand';
import { getDatabase } from '../db/database';
import {
  getAllRoles, insertRole, updateRole as updateRoleDb,
  deleteRole as deleteRoleDb, incrementRoleUsage, getRolesCount,
} from '../db/repositories/roles';
import type { RoleRow } from '../db/types';

export interface Role {
  id: string;
  name: string;
  tagline: string;
  description: string;
  author: string;
  authorVerified: boolean;
  category: string;
  useCase: string;
  goodAt: string[];
  notGoodAt?: string[];
  examplePrompts: string[];
  reasoning: string;
  writingStyle: string;
  priorities: string[];
  tone: string;
  rating: number;
  reviewCount: number;
  usageCount: number;
  forkCount: number;
  version: string;
  forkedFrom?: string;
  isFeatured: boolean;
  isTrending: boolean;
  isVerified: boolean;
  isCustom: boolean;
  isPublished: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface RolesStoreState {
  roles: Role[];
  loadRoles: () => void;
  createRole: (role: Omit<Role, 'id' | 'createdAt' | 'updatedAt' | 'usageCount'>) => void;
  updateRole: (id: string, updates: Partial<Role>) => void;
  deleteRole: (id: string) => void;
  incrementUsage: (id: string) => void;
  getDefaultRoles: () => Role[];
}

function roleToRow(role: Role): RoleRow {
  const { author, authorVerified, useCase, goodAt, notGoodAt, examplePrompts,
    reasoning, writingStyle, priorities, tone, reviewCount, forkCount, version,
    forkedFrom, isTrending, isVerified, isPublished, ...rest } = role;
  return {
    id: rest.id,
    name: rest.name,
    tagline: rest.tagline,
    description: rest.description,
    category: rest.category,
    system_prompt: null,
    config: JSON.stringify({
      author, authorVerified, useCase, goodAt, notGoodAt, examplePrompts,
      reasoning, writingStyle, priorities, tone, reviewCount, forkCount,
      version, forkedFrom, isTrending, isVerified, isPublished,
    }),
    is_custom: rest.isCustom ? 1 : 0,
    is_featured: rest.isFeatured ? 1 : 0,
    usage_count: rest.usageCount,
    rating: rest.rating,
    created_at: rest.createdAt.getTime(),
    updated_at: rest.updatedAt.getTime(),
  };
}

function rowToRole(row: RoleRow): Role {
  const config = row.config ? JSON.parse(row.config) : {};
  return {
    id: row.id,
    name: row.name,
    tagline: row.tagline ?? '',
    description: row.description ?? '',
    author: config.author ?? 'Alia Team',
    authorVerified: config.authorVerified ?? false,
    category: row.category ?? '',
    useCase: config.useCase ?? '',
    goodAt: config.goodAt ?? [],
    notGoodAt: config.notGoodAt,
    examplePrompts: config.examplePrompts ?? [],
    reasoning: config.reasoning ?? '',
    writingStyle: config.writingStyle ?? '',
    priorities: config.priorities ?? [],
    tone: config.tone ?? '',
    rating: row.rating,
    reviewCount: config.reviewCount ?? 0,
    usageCount: row.usage_count,
    forkCount: config.forkCount ?? 0,
    version: config.version ?? '1.0',
    forkedFrom: config.forkedFrom,
    isFeatured: row.is_featured === 1,
    isTrending: config.isTrending ?? false,
    isVerified: config.isVerified ?? false,
    isCustom: row.is_custom === 1,
    isPublished: config.isPublished ?? true,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

// Default roles — seeded on first load if table is empty
const DEFAULT_ROLES: Omit<Role, 'id' | 'createdAt' | 'updatedAt'>[] = [
  {
    name: 'Creative Writer', tagline: 'Transform ideas into compelling narratives',
    description: 'Crafts engaging stories, vivid descriptions, and emotionally resonant content that captivates readers',
    author: 'Alia Team', authorVerified: true, category: 'Writing',
    useCase: 'Use when creating fiction, blog posts, marketing copy, or any content that needs emotional impact and engagement',
    goodAt: ['Storytelling', 'Emotional resonance', 'Vivid descriptions', 'Character development'],
    notGoodAt: ['Technical documentation', 'Legal writing', 'Data analysis'],
    examplePrompts: ['Write a short story about a time traveler', 'Create compelling product descriptions', 'Draft a blog post about sustainable living'],
    reasoning: 'Emphasizes creativity, narrative flow, and emotional impact',
    writingStyle: 'Expressive, vivid, narrative-driven', priorities: ['Originality', 'Engagement', 'Storytelling'],
    tone: 'Warm and imaginative', rating: 4.8, reviewCount: 234, usageCount: 1520, forkCount: 45,
    version: '2.1', isFeatured: true, isTrending: true, isVerified: true, isCustom: false, isPublished: true,
  },
  {
    name: 'Technical Expert', tagline: 'Deep technical knowledge, zero handwaving',
    description: 'Provides precise, detailed technical explanations with code examples, best practices, and real-world considerations',
    author: 'Alia Team', authorVerified: true, category: 'Technical',
    useCase: 'Perfect for debugging, architecture decisions, API design, or when you need technically accurate answers',
    goodAt: ['Technical accuracy', 'Code examples', 'Architecture design', 'Debugging'],
    notGoodAt: ['Creative writing', 'Marketing content', 'Casual conversation'],
    examplePrompts: ['Explain microservices architecture', 'Debug this memory leak', 'Design a scalable API'],
    reasoning: 'Focuses on accuracy, depth, and technical correctness',
    writingStyle: 'Clear, precise, technical', priorities: ['Accuracy', 'Detail', 'Best Practices'],
    tone: 'Professional and informative', rating: 4.9, reviewCount: 456, usageCount: 2890, forkCount: 78,
    version: '3.0', isFeatured: true, isTrending: false, isVerified: true, isCustom: false, isPublished: true,
  },
  {
    name: 'Strategic Thinker', tagline: 'See the big picture, make smart moves',
    description: 'Analyzes problems through a strategic lens, considers market dynamics, competitive positioning, and long-term value',
    author: 'Alia Team', authorVerified: true, category: 'Business',
    useCase: 'Use for business strategy, competitive analysis, market entry decisions, or pricing strategy',
    goodAt: ['Strategic planning', 'Market analysis', 'ROI thinking', 'Risk assessment'],
    notGoodAt: ['Tactical execution', 'Day-to-day operations', 'Technical implementation'],
    examplePrompts: ['Analyze our go-to-market strategy', 'Should we enter this new market?', 'Evaluate this partnership opportunity'],
    reasoning: 'Prioritizes ROI, competitive advantage, and strategic value',
    writingStyle: 'Structured, analytical, actionable', priorities: ['ROI', 'Strategy', 'Market Position'],
    tone: 'Professional and strategic', rating: 4.7, reviewCount: 189, usageCount: 1120, forkCount: 34,
    version: '1.5', isFeatured: true, isTrending: true, isVerified: true, isCustom: false, isPublished: true,
  },
  {
    name: 'Patient Teacher', tagline: 'Complex concepts, simple explanations',
    description: 'Breaks down difficult topics into clear, digestible explanations with examples, analogies, and step-by-step guidance',
    author: 'Alia Team', authorVerified: true, category: 'Education',
    useCase: 'Learning new concepts, explaining ideas to others, or teaching complex topics',
    goodAt: ['Clear explanations', 'Analogies', 'Step-by-step guidance', 'Patience'],
    notGoodAt: ['Advanced technical depth', 'Speed over clarity', 'Jargon-heavy content'],
    examplePrompts: ['Explain quantum computing like I\'m 12', 'How does blockchain actually work?', 'Teach me React hooks from scratch'],
    reasoning: 'Breaks down complex topics into digestible parts',
    writingStyle: 'Clear, structured, example-rich', priorities: ['Clarity', 'Understanding', 'Examples'],
    tone: 'Patient and encouraging', rating: 4.9, reviewCount: 567, usageCount: 3240, forkCount: 92,
    version: '2.3', isFeatured: false, isTrending: true, isVerified: true, isCustom: false, isPublished: true,
  },
  {
    name: 'Security-First Reviewer', tagline: 'Catch bugs before they ship',
    description: 'Reviews code with security, performance, and maintainability as top priorities, provides actionable feedback',
    author: 'Alia Team', authorVerified: true, category: 'Development',
    useCase: 'Code reviews, security audits, performance optimization, or refactoring guidance',
    goodAt: ['Security analysis', 'Performance optimization', 'Code quality', 'Best practices'],
    notGoodAt: ['Quick prototypes', 'Learning exercises', 'Creative exploration'],
    examplePrompts: ['Review this authentication code', 'Find performance bottlenecks', 'Security audit this API'],
    reasoning: 'Emphasizes code quality, security, and maintainability',
    writingStyle: 'Direct, constructive, detailed', priorities: ['Security', 'Performance', 'Maintainability'],
    tone: 'Constructive and thorough', rating: 4.8, reviewCount: 312, usageCount: 1890, forkCount: 56,
    version: '2.0', isFeatured: false, isTrending: false, isVerified: true, isCustom: false, isPublished: true,
  },
  {
    name: 'Research Scholar', tagline: 'Evidence-based thinking, balanced perspectives',
    description: 'Conducts thorough research with proper citations, considers multiple viewpoints, and maintains academic rigor',
    author: 'Alia Team', authorVerified: true, category: 'Research',
    useCase: 'Academic research, fact-checking, literature reviews, or when you need well-sourced information',
    goodAt: ['Research', 'Citations', 'Balanced analysis', 'Critical thinking'],
    notGoodAt: ['Quick answers', 'Opinion pieces', 'Creative content'],
    examplePrompts: ['Research the impact of remote work', 'Compare these scientific theories', 'Analyze this historical event'],
    reasoning: 'Prioritizes evidence, sources, and balanced analysis',
    writingStyle: 'Academic, thorough, referenced', priorities: ['Evidence', 'Sources', 'Balance'],
    tone: 'Objective and scholarly', rating: 4.7, reviewCount: 178, usageCount: 980, forkCount: 28,
    version: '1.8', isFeatured: false, isTrending: false, isVerified: true, isCustom: false, isPublished: true,
  },
];

function seedDefaultRoles(db: ReturnType<typeof getDatabase>): void {
  const now = Date.now();
  for (let i = 0; i < DEFAULT_ROLES.length; i++) {
    const role = {
      ...DEFAULT_ROLES[i],
      id: `role-default-${i}`,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    } as Role;
    insertRole(db, roleToRow(role));
  }
}

export const useRolesStore = create<RolesStoreState>((set, get) => ({
  roles: [],

  loadRoles: () => {
    const db = getDatabase();
    if (getRolesCount(db) === 0) {
      seedDefaultRoles(db);
    }
    const rows = getAllRoles(db);
    set({ roles: rows.map(rowToRole) });
  },

  createRole: (roleData) => {
    const db = getDatabase();
    const now = new Date();
    const role = { ...roleData, id: `role-${Date.now()}`, createdAt: now, updatedAt: now, usageCount: 0 } as Role;
    insertRole(db, roleToRow(role));
    get().loadRoles();
  },

  updateRole: (id, updates) => {
    const db = getDatabase();
    const existing = get().roles.find((r) => r.id === id);
    if (!existing) return;
    const merged = { ...existing, ...updates, updatedAt: new Date() } as Role;
    const row = roleToRow(merged);
    updateRoleDb(db, id, {
      name: row.name, tagline: row.tagline, description: row.description,
      category: row.category, config: row.config, is_featured: row.is_featured,
      rating: row.rating,
    });
    get().loadRoles();
  },

  deleteRole: (id) => {
    const db = getDatabase();
    const role = get().roles.find((r) => r.id === id);
    if (role && !role.isCustom) return; // Don't delete default roles
    deleteRoleDb(db, id);
    get().loadRoles();
  },

  incrementUsage: (id) => {
    const db = getDatabase();
    incrementRoleUsage(db, id);
    get().loadRoles();
  },

  getDefaultRoles: () => get().roles.filter((role) => !role.isCustom),
}));
```

- [ ] **Step 3: Verify build**

```bash
cd /home/nate/Oxy/Alia && bun run build:frontend
```

- [ ] **Step 4: Commit**

```bash
git add apps/app/lib/db/repositories/roles.ts apps/app/lib/stores/roles-store.ts
git commit -m "feat: migrate roles store to SQLite with individual row updates"
```

---

## Task 5: Favorites, pinned, and agent-favorites — merge into SQLite

**Files:**
- Modify: `apps/app/lib/stores/favorites-store.ts`
- Modify: `apps/app/lib/stores/pinned-store.ts`
- Modify: `apps/app/lib/stores/agent-favorites-store.ts`

- [ ] **Step 1: Rewrite favorites-store to use SQLite conversations table**

Replace `apps/app/lib/stores/favorites-store.ts` with:

```typescript
import { create } from 'zustand';
import { getDatabase } from '../db/database';

interface FavoritesStoreState {
  favoriteConversationIds: string[];
  loadFavorites: () => void;
  toggleFavorite: (conversationId: string) => void;
  isFavorite: (conversationId: string) => boolean;
}

export const useFavoritesStore = create<FavoritesStoreState>((set, get) => ({
  favoriteConversationIds: [],

  loadFavorites: () => {
    const db = getDatabase();
    const rows = db.getAllSync<{ id: string }>(
      'SELECT id FROM conversations WHERE is_favorite = 1 ORDER BY updated_at DESC'
    );
    set({ favoriteConversationIds: rows.map((r) => r.id) });
  },

  toggleFavorite: (conversationId: string) => {
    const db = getDatabase();
    const current = get().favoriteConversationIds.includes(conversationId);
    const newValue = current ? 0 : 1;

    // Upsert: if conversation exists, update; if not, create a minimal row
    const exists = db.getFirstSync('SELECT id FROM conversations WHERE id = ?', [conversationId]);
    if (exists) {
      db.runSync('UPDATE conversations SET is_favorite = ?, updated_at = ? WHERE id = ?',
        [newValue, Date.now(), conversationId]);
    } else {
      const now = Date.now();
      db.runSync(
        'INSERT INTO conversations (id, title, is_favorite, is_pinned, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)',
        [conversationId, 'New chat', newValue, now, now]
      );
    }
    get().loadFavorites();
  },

  isFavorite: (conversationId: string) => get().favoriteConversationIds.includes(conversationId),
}));
```

- [ ] **Step 2: Rewrite pinned-store to use SQLite conversations table**

Replace `apps/app/lib/stores/pinned-store.ts` with:

```typescript
import { create } from 'zustand';
import { getDatabase } from '../db/database';

interface PinnedStoreState {
  pinnedConversationIds: string[];
  loadPinned: () => void;
  togglePin: (conversationId: string) => void;
  isPinned: (conversationId: string) => boolean;
}

export const usePinnedStore = create<PinnedStoreState>((set, get) => ({
  pinnedConversationIds: [],

  loadPinned: () => {
    const db = getDatabase();
    const rows = db.getAllSync<{ id: string }>(
      'SELECT id FROM conversations WHERE is_pinned = 1 ORDER BY updated_at DESC'
    );
    set({ pinnedConversationIds: rows.map((r) => r.id) });
  },

  togglePin: (conversationId: string) => {
    const db = getDatabase();
    const current = get().pinnedConversationIds.includes(conversationId);
    const newValue = current ? 0 : 1;

    const exists = db.getFirstSync('SELECT id FROM conversations WHERE id = ?', [conversationId]);
    if (exists) {
      db.runSync('UPDATE conversations SET is_pinned = ?, updated_at = ? WHERE id = ?',
        [newValue, Date.now(), conversationId]);
    } else {
      const now = Date.now();
      db.runSync(
        'INSERT INTO conversations (id, title, is_pinned, is_favorite, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)',
        [conversationId, 'New chat', newValue, now, now]
      );
    }
    get().loadPinned();
  },

  isPinned: (conversationId: string) => get().pinnedConversationIds.includes(conversationId),
}));
```

- [ ] **Step 3: Rewrite agent-favorites-store to use SQLite preferences**

Replace `apps/app/lib/stores/agent-favorites-store.ts` with:

```typescript
import { create } from 'zustand';
import { getDatabase } from '../db/database';
import { getPreference, setPreference } from '../db/repositories/preferences';

interface AgentFavoritesStoreState {
  favoriteAgentIds: string[];
  loadFavorites: () => void;
  toggleFavorite: (agentId: string) => void;
  isFavorite: (agentId: string) => boolean;
}

export const useAgentFavoritesStore = create<AgentFavoritesStoreState>((set, get) => ({
  favoriteAgentIds: [],

  loadFavorites: () => {
    const db = getDatabase();
    const raw = getPreference(db, 'favorite_agent_ids');
    set({ favoriteAgentIds: raw ? JSON.parse(raw) : [] });
  },

  toggleFavorite: (agentId: string) => {
    const db = getDatabase();
    const current = get().favoriteAgentIds;
    const isFavorited = current.includes(agentId);
    const newFavorites = isFavorited
      ? current.filter((id) => id !== agentId)
      : [...current, agentId];
    setPreference(db, 'favorite_agent_ids', JSON.stringify(newFavorites));
    set({ favoriteAgentIds: newFavorites });
  },

  isFavorite: (agentId: string) => get().favoriteAgentIds.includes(agentId),
}));
```

- [ ] **Step 4: Verify build**

```bash
cd /home/nate/Oxy/Alia && bun run build:frontend
```

- [ ] **Step 5: Commit**

```bash
git add apps/app/lib/stores/favorites-store.ts apps/app/lib/stores/pinned-store.ts apps/app/lib/stores/agent-favorites-store.ts
git commit -m "feat: migrate favorites, pinned, and agent-favorites stores to SQLite"
```

---

## Task 6: Conversations and messages repositories

**Files:**
- Create: `apps/app/lib/db/repositories/conversations.ts`
- Create: `apps/app/lib/db/repositories/messages.ts`

- [ ] **Step 1: Create conversations repository**

Create `apps/app/lib/db/repositories/conversations.ts`:

```typescript
import type { SQLiteDatabase } from 'expo-sqlite';
import type { ConversationRow } from '../types';

export function getConversationsPaginated(
  db: SQLiteDatabase,
  opts: { limit: number; offset: number }
): ConversationRow[] {
  return db.getAllSync<ConversationRow>(
    'SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ? OFFSET ?',
    [opts.limit, opts.offset]
  );
}

export function getConversation(
  db: SQLiteDatabase,
  id: string
): ConversationRow | null {
  return db.getFirstSync<ConversationRow>(
    'SELECT * FROM conversations WHERE id = ?', [id]
  ) ?? null;
}

export function upsertConversation(db: SQLiteDatabase, conv: ConversationRow): void {
  db.runSync(
    `INSERT INTO conversations (id, title, source, agent_id, last_message, is_favorite, is_pinned, created_at, updated_at, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       source = excluded.source,
       agent_id = excluded.agent_id,
       last_message = excluded.last_message,
       updated_at = excluded.updated_at,
       synced_at = excluded.synced_at`,
    [conv.id, conv.title, conv.source, conv.agent_id, conv.last_message,
     conv.is_favorite, conv.is_pinned, conv.created_at, conv.updated_at, conv.synced_at]
  );
}

export function deleteConversation(db: SQLiteDatabase, id: string): void {
  db.runSync('DELETE FROM conversations WHERE id = ?', [id]);
}

export function getConversationsCount(db: SQLiteDatabase): number {
  const row = db.getFirstSync<{ count: number }>('SELECT COUNT(*) as count FROM conversations');
  return row?.count ?? 0;
}

export function getConversationsByIds(db: SQLiteDatabase, ids: string[]): ConversationRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db.getAllSync<ConversationRow>(
    `SELECT * FROM conversations WHERE id IN (${placeholders}) ORDER BY updated_at DESC`,
    ids
  );
}
```

- [ ] **Step 2: Create messages repository**

Create `apps/app/lib/db/repositories/messages.ts`:

```typescript
import type { SQLiteDatabase } from 'expo-sqlite';
import type { MessageRow } from '../types';

export function getMessagesByConversation(
  db: SQLiteDatabase,
  conversationId: string
): MessageRow[] {
  return db.getAllSync<MessageRow>(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC',
    [conversationId]
  );
}

export function insertMessage(db: SQLiteDatabase, msg: MessageRow): void {
  db.runSync(
    `INSERT OR REPLACE INTO messages (id, conversation_id, role, content, thinking, tool_invocations, source, speaker, agent_info, audio_url, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [msg.id, msg.conversation_id, msg.role, msg.content, msg.thinking,
     msg.tool_invocations, msg.source, msg.speaker, msg.agent_info,
     msg.audio_url, msg.created_at]
  );
}

export function insertMessagesBatch(db: SQLiteDatabase, messages: MessageRow[]): void {
  const stmt = db.prepareSync(
    `INSERT OR REPLACE INTO messages (id, conversation_id, role, content, thinking, tool_invocations, source, speaker, agent_info, audio_url, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  try {
    db.execSync('BEGIN TRANSACTION');
    for (const msg of messages) {
      stmt.executeSync([
        msg.id, msg.conversation_id, msg.role, msg.content, msg.thinking,
        msg.tool_invocations, msg.source, msg.speaker, msg.agent_info,
        msg.audio_url, msg.created_at,
      ]);
    }
    db.execSync('COMMIT');
  } catch (error) {
    db.execSync('ROLLBACK');
    throw error;
  } finally {
    stmt.finalizeSync();
  }
}

export function deleteMessagesByConversation(db: SQLiteDatabase, conversationId: string): void {
  db.runSync('DELETE FROM messages WHERE conversation_id = ?', [conversationId]);
}

export function searchMessages(
  db: SQLiteDatabase,
  query: string,
  conversationId?: string
): MessageRow[] {
  if (conversationId) {
    return db.getAllSync<MessageRow>(
      `SELECT m.* FROM messages m
       JOIN messages_fts fts ON m.rowid = fts.rowid
       WHERE messages_fts MATCH ? AND fts.conversation_id = ?
       ORDER BY rank
       LIMIT 50`,
      [query, conversationId]
    );
  }
  return db.getAllSync<MessageRow>(
    `SELECT m.* FROM messages m
     JOIN messages_fts fts ON m.rowid = fts.rowid
     WHERE messages_fts MATCH ?
     ORDER BY rank
     LIMIT 50`,
    [query]
  );
}

export function getMessagesCount(db: SQLiteDatabase, conversationId: string): number {
  const row = db.getFirstSync<{ count: number }>(
    'SELECT COUNT(*) as count FROM messages WHERE conversation_id = ?',
    [conversationId]
  );
  return row?.count ?? 0;
}
```

- [ ] **Step 3: Verify build**

```bash
cd /home/nate/Oxy/Alia && bun run build:frontend
```

- [ ] **Step 4: Commit**

```bash
git add apps/app/lib/db/repositories/conversations.ts apps/app/lib/db/repositories/messages.ts
git commit -m "feat: add conversations and messages SQLite repositories with FTS5 search"
```

---

## Task 7: Rewrite use-conversations hook to use SQLite + API sync

**Files:**
- Modify: `apps/app/lib/hooks/use-conversations.ts`
- Create: `apps/app/lib/db/hooks/use-conversations-db.ts`
- Create: `apps/app/lib/db/hooks/use-search.ts`

- [ ] **Step 1: Create database-backed conversation hooks**

Create `apps/app/lib/db/hooks/use-conversations-db.ts`:

```typescript
import { useCallback } from 'react';
import { useDatabase } from '../database';
import {
  upsertConversation, deleteConversation as deleteConvDb,
  getConversation, getConversationsPaginated,
} from '../repositories/conversations';
import { insertMessagesBatch, deleteMessagesByConversation, getMessagesByConversation } from '../repositories/messages';
import type { ConversationRow, MessageRow } from '../types';
import type { Conversation, Message } from '@/lib/hooks/use-conversations';

function messageToRow(msg: Message, conversationId: string): MessageRow {
  return {
    id: msg.id ?? `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    conversation_id: conversationId,
    role: msg.role,
    content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
    thinking: msg.thinking ?? null,
    tool_invocations: msg.toolInvocations ? JSON.stringify(msg.toolInvocations) : null,
    source: msg.source ?? null,
    speaker: msg.speaker ?? null,
    agent_info: msg.agentInfo ? JSON.stringify(msg.agentInfo) : null,
    audio_url: msg.audioUrl ?? null,
    created_at: Date.now(),
  };
}

function rowToMessage(row: MessageRow): Message {
  let content: string | Array<{ type: string; [key: string]: unknown }> = row.content ?? '';
  if (row.content && row.content.startsWith('[')) {
    try { content = JSON.parse(row.content); } catch { /* keep as string */ }
  }

  return {
    id: row.id,
    role: row.role as Message['role'],
    content,
    thinking: row.thinking ?? undefined,
    toolInvocations: row.tool_invocations ? JSON.parse(row.tool_invocations) : undefined,
    source: row.source as Message['source'],
    speaker: row.speaker as Message['speaker'],
    agentInfo: row.agent_info ? JSON.parse(row.agent_info) : undefined,
    audioUrl: row.audio_url ?? undefined,
  };
}

export function useSyncConversationToDb() {
  const db = useDatabase();

  return useCallback((conversation: Conversation) => {
    const now = Date.now();
    const convRow: ConversationRow = {
      id: conversation.id,
      title: conversation.title,
      source: conversation.source ?? null,
      agent_id: conversation.agentId ?? null,
      last_message: conversation.lastMessage ?? null,
      is_favorite: 0,
      is_pinned: 0,
      created_at: conversation.createdAt.getTime(),
      updated_at: conversation.updatedAt.getTime(),
      synced_at: now,
    };

    // Preserve favorite/pinned status from existing row
    const existing = getConversation(db, conversation.id);
    if (existing) {
      convRow.is_favorite = existing.is_favorite;
      convRow.is_pinned = existing.is_pinned;
    }

    upsertConversation(db, convRow);

    if (conversation.messages.length > 0) {
      deleteMessagesByConversation(db, conversation.id);
      const msgRows = conversation.messages.map((m) => messageToRow(m, conversation.id));
      insertMessagesBatch(db, msgRows);
    }
  }, [db]);
}

export function useLoadConversationFromDb() {
  const db = useDatabase();

  return useCallback((id: string): Conversation | null => {
    const row = getConversation(db, id);
    if (!row) return null;

    const msgRows = getMessagesByConversation(db, id);
    return {
      id: row.id,
      title: row.title ?? 'New chat',
      lastMessage: row.last_message ?? undefined,
      source: row.source ?? undefined,
      agentId: row.agent_id ?? undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      messages: msgRows.map(rowToMessage),
    };
  }, [db]);
}

export function useLoadConversationsFromDb() {
  const db = useDatabase();

  return useCallback((opts: { limit: number; offset: number }): Conversation[] => {
    const rows = getConversationsPaginated(db, opts);
    return rows.map((row) => ({
      id: row.id,
      title: row.title ?? 'New chat',
      lastMessage: row.last_message ?? undefined,
      source: row.source ?? undefined,
      agentId: row.agent_id ?? undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      messages: [],
    }));
  }, [db]);
}

export function useDeleteConversationFromDb() {
  const db = useDatabase();

  return useCallback((id: string) => {
    deleteConvDb(db, id);
  }, [db]);
}
```

- [ ] **Step 2: Create FTS5 search hook**

Create `apps/app/lib/db/hooks/use-search.ts`:

```typescript
import { useState, useCallback } from 'react';
import { useDatabase } from '../database';
import { searchMessages } from '../repositories/messages';

interface SearchResult {
  messageId: string;
  conversationId: string;
  role: string;
  content: string;
  snippet: string;
}

export function useMessageSearch() {
  const db = useDatabase();
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  const search = useCallback((query: string, conversationId?: string) => {
    if (!query.trim()) {
      setResults([]);
      return;
    }

    setSearching(true);
    const rows = searchMessages(db, query, conversationId);
    const mapped: SearchResult[] = rows.map((row) => {
      const content = row.content ?? '';
      const lowerContent = content.toLowerCase();
      const lowerQuery = query.toLowerCase();
      const idx = lowerContent.indexOf(lowerQuery);
      const start = Math.max(0, idx - 40);
      const end = Math.min(content.length, idx + query.length + 40);
      const snippet = (start > 0 ? '...' : '') + content.slice(start, end) + (end < content.length ? '...' : '');

      return {
        messageId: row.id,
        conversationId: row.conversation_id,
        role: row.role,
        content,
        snippet,
      };
    });
    setResults(mapped);
    setSearching(false);
  }, [db]);

  const clear = useCallback(() => setResults([]), []);

  return { results, searching, search, clear };
}
```

- [ ] **Step 3: Update use-conversations.ts to sync API data to SQLite**

Modify `apps/app/lib/hooks/use-conversations.ts`. The key changes are:
1. After each API fetch, upsert results into SQLite
2. On API failure, fall back to SQLite instead of AsyncStorage
3. Keep the React Query hooks as the primary interface

Replace the `fetchConversations` function (lines 44-54) and `fetchConversationsPage` function (lines 57-95) with SQLite-backed versions:

```typescript
import { useQuery, useMutation, useQueryClient, useInfiniteQuery, type QueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import { toast } from '@/components/sonner';
import apiClient from '../api/client';
import { queryKeys } from './query-keys';
import type { ToolInvocation } from '../types/messages';
import { getDatabase } from '../db/database';
import {
  upsertConversation as upsertConvDb,
  getConversationsPaginated,
  getConversation as getConvDb,
  deleteConversation as deleteConvDb,
} from '../db/repositories/conversations';
import {
  insertMessagesBatch,
  deleteMessagesByConversation,
  getMessagesByConversation,
} from '../db/repositories/messages';
import type { ConversationRow, MessageRow } from '../db/types';

export interface Message {
  id?: string;
  role: 'user' | 'assistant' | 'system';
  content: string | Array<{ type: string; [key: string]: any }>;
  thinking?: string;
  toolInvocations?: ToolInvocation[];
  source?: 'text' | 'voice';
  speaker?: 'primary' | 'cohost';
  isStreaming?: boolean;
  agentInfo?: {
    id: string;
    name: string;
    avatar: string | null;
    handle: string;
    accessories?: string[];
  };
  audioUrl?: string;
}

export interface Conversation {
  id: string;
  title: string;
  lastMessage?: string;
  source?: string;
  agentId?: string;
  createdAt: Date;
  updatedAt: Date;
  messages: Message[];
}

// Convert API conversation to SQLite row and upsert
function syncConversationToDb(conv: Conversation): void {
  const db = getDatabase();
  const existing = getConvDb(db, conv.id);
  const row: ConversationRow = {
    id: conv.id,
    title: conv.title,
    source: conv.source ?? null,
    agent_id: conv.agentId ?? null,
    last_message: conv.lastMessage ?? null,
    is_favorite: existing?.is_favorite ?? 0,
    is_pinned: existing?.is_pinned ?? 0,
    created_at: conv.createdAt.getTime(),
    updated_at: conv.updatedAt.getTime(),
    synced_at: Date.now(),
  };
  upsertConvDb(db, row);
}

function messageToRow(msg: Message, conversationId: string, index: number): MessageRow {
  return {
    id: msg.id ?? `msg-${conversationId}-${index}`,
    conversation_id: conversationId,
    role: msg.role,
    content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
    thinking: msg.thinking ?? null,
    tool_invocations: msg.toolInvocations ? JSON.stringify(msg.toolInvocations) : null,
    source: msg.source ?? null,
    speaker: msg.speaker ?? null,
    agent_info: msg.agentInfo ? JSON.stringify(msg.agentInfo) : null,
    audio_url: msg.audioUrl ?? null,
    created_at: Date.now() + index, // preserve ordering
  };
}

function rowToMessage(row: MessageRow): Message {
  let content: string | Array<{ type: string; [key: string]: unknown }> = row.content ?? '';
  if (row.content && row.content.startsWith('[')) {
    try { content = JSON.parse(row.content); } catch { /* keep as string */ }
  }
  return {
    id: row.id,
    role: row.role as Message['role'],
    content,
    thinking: row.thinking ?? undefined,
    toolInvocations: row.tool_invocations ? JSON.parse(row.tool_invocations) : undefined,
    source: row.source as Message['source'],
    speaker: row.speaker as Message['speaker'],
    agentInfo: row.agent_info ? JSON.parse(row.agent_info) : undefined,
    audioUrl: row.audio_url ?? undefined,
  };
}

function rowToConversation(row: ConversationRow, messages: Message[] = []): Conversation {
  return {
    id: row.id,
    title: row.title ?? 'New chat',
    lastMessage: row.last_message ?? undefined,
    source: row.source ?? undefined,
    agentId: row.agent_id ?? undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    messages,
  };
}

// Fetch paginated conversations from API, falling back to SQLite
async function fetchConversationsPage({ pageParam }: { pageParam?: string }): Promise<{
  conversations: Conversation[];
  nextCursor: string | null;
  hasMore: boolean;
}> {
  try {
    const params: Record<string, string | number> = { limit: 20 };
    if (pageParam) params.cursor = pageParam;

    const response = await apiClient.get('/conversations', { params });
    const conversations = response.data.conversations.map((conv: Conversation) => {
      const mapped = {
        ...conv,
        createdAt: new Date(conv.createdAt),
        updatedAt: new Date(conv.updatedAt),
        messages: [],
      };
      syncConversationToDb(mapped);
      return mapped;
    });

    return {
      conversations,
      nextCursor: response.data.nextCursor,
      hasMore: response.data.hasMore,
    };
  } catch (error: unknown) {
    const axiosError = error as { response?: { status: number } };
    if (axiosError.response?.status === 401) {
      // Fall back to SQLite
      const db = getDatabase();
      const offset = pageParam ? parseInt(pageParam, 10) : 0;
      const rows = getConversationsPaginated(db, { limit: 20, offset });
      const conversations = rows.map((row) => rowToConversation(row));
      return {
        conversations,
        nextCursor: rows.length === 20 ? String(offset + 20) : null,
        hasMore: rows.length === 20,
      };
    }
    throw error;
  }
}

export function useConversations() {
  const { isAuthenticated } = useOxy();
  return useInfiniteQuery({
    queryKey: queryKeys.conversations.all,
    queryFn: fetchConversationsPage,
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => lastPage.hasMore ? lastPage.nextCursor : undefined,
    staleTime: 1000 * 60 * 5,
    retry: 2,
    enabled: isAuthenticated,
  });
}

// Fetch single conversation — API first, SQLite fallback
async function fetchConversation(id: string): Promise<Conversation> {
  try {
    const response = await apiClient.get(`/conversations/${id}`);
    const data = response.data;
    const conversation: Conversation = {
      ...data,
      createdAt: new Date(data.createdAt),
      updatedAt: new Date(data.updatedAt),
    };

    // Sync to SQLite
    syncConversationToDb(conversation);
    if (conversation.messages.length > 0) {
      const db = getDatabase();
      deleteMessagesByConversation(db, id);
      const msgRows = conversation.messages.map((m, i) => messageToRow(m, id, i));
      insertMessagesBatch(db, msgRows);
    }

    return conversation;
  } catch (error: unknown) {
    const axiosError = error as { response?: { status: number } };
    if (axiosError.response?.status === 401 || axiosError.response?.status === 404) {
      // Fall back to SQLite
      const db = getDatabase();
      const row = getConvDb(db, id);
      if (row) {
        const msgRows = getMessagesByConversation(db, id);
        return rowToConversation(row, msgRows.map(rowToMessage));
      }
    }
    throw new Error('Conversation not found');
  }
}

export function useConversation(id: string) {
  const { isAuthenticated } = useOxy();
  return useQuery({
    queryKey: queryKeys.conversations.detail(id),
    queryFn: () => fetchConversation(id),
    enabled: isAuthenticated && !!id,
    staleTime: 1000 * 60 * 5,
    retry: 1,
  });
}

export function prefetchConversation(queryClient: QueryClient, id: string) {
  queryClient.prefetchQuery({
    queryKey: queryKeys.conversations.detail(id),
    queryFn: () => fetchConversation(id),
    staleTime: 1000 * 60 * 5,
  });
}

export function useSaveConversation() {
  const queryClient = useQueryClient();

  return useMutation({
    retry: 1,
    mutationFn: async ({ id, messages, title }: { id: string; messages: Message[]; title?: string }) => {
      const lastMessage = messages[messages.length - 1]?.content?.slice(0, 100);

      try {
        const response = await apiClient.post('/conversations', {
          conversationId: id,
          messages,
          ...(title && { title }),
        });

        const data = response.data;
        const conversation: Conversation = {
          id: data.id,
          title: data.title,
          lastMessage: data.lastMessage,
          source: data.source,
          createdAt: new Date(data.createdAt),
          updatedAt: new Date(data.updatedAt),
          messages,
        };

        // Sync to SQLite
        syncConversationToDb(conversation);
        const db = getDatabase();
        deleteMessagesByConversation(db, id);
        const msgRows = messages.map((m, i) => messageToRow(m, id, i));
        insertMessagesBatch(db, msgRows);

        return conversation;
      } catch (error: unknown) {
        const axiosError = error as { response?: { status: number } };
        if (axiosError.response?.status === 401) {
          // Save to SQLite only (offline)
          const db = getDatabase();
          const existing = getConvDb(db, id);
          const offlineTitle = title || (typeof messages[0]?.content === 'string' ? messages[0].content.slice(0, 50) : 'New chat');
          const now = Date.now();

          const convRow: ConversationRow = {
            id,
            title: offlineTitle,
            source: null,
            agent_id: null,
            last_message: typeof lastMessage === 'string' ? lastMessage : null,
            is_favorite: existing?.is_favorite ?? 0,
            is_pinned: existing?.is_pinned ?? 0,
            created_at: existing?.created_at ?? now,
            updated_at: now,
            synced_at: null, // Not synced
          };
          upsertConvDb(db, convRow);
          deleteMessagesByConversation(db, id);
          const msgRows = messages.map((m, i) => messageToRow(m, id, i));
          insertMessagesBatch(db, msgRows);

          return {
            id,
            title: offlineTitle,
            lastMessage: typeof lastMessage === 'string' ? lastMessage : undefined,
            createdAt: existing ? new Date(existing.created_at) : new Date(now),
            updatedAt: new Date(now),
            messages,
          };
        }
        throw error;
      }
    },
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.conversations.all, (oldData: any) => {
        if (!oldData?.pages) {
          return {
            pages: [{ conversations: [{ ...data, messages: [] }], nextCursor: null, hasMore: false }],
            pageParams: [undefined],
          };
        }

        const newPages = [...oldData.pages];
        const conversationMetadata = { ...data, messages: [] };

        for (let i = 0; i < newPages.length; i++) {
          const existingIndex = newPages[i].conversations.findIndex((c: Conversation) => c.id === data.id);
          if (existingIndex >= 0) {
            newPages[i] = {
              ...newPages[i],
              conversations: [
                ...newPages[i].conversations.slice(0, existingIndex),
                ...newPages[i].conversations.slice(existingIndex + 1),
              ],
            };
            break;
          }
        }

        if (newPages[0]) {
          newPages[0] = { ...newPages[0], conversations: [conversationMetadata, ...newPages[0].conversations] };
        }

        return { ...oldData, pages: newPages };
      });

      queryClient.setQueryData(queryKeys.conversations.detail(data.id), data);
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to save conversation');
    },
  });
}

export function useDeleteConversation() {
  const queryClient = useQueryClient();

  return useMutation({
    retry: 1,
    mutationFn: async (id: string) => {
      // Always delete from SQLite
      const db = getDatabase();
      deleteConvDb(db, id);

      try {
        await apiClient.delete(`/conversations/${id}`);
      } catch (error: unknown) {
        const axiosError = error as { response?: { status: number } };
        if (axiosError.response?.status !== 401) throw error;
        // 401 = offline, SQLite deletion is sufficient
      }
      return id;
    },
    onSuccess: (id) => {
      queryClient.setQueryData(queryKeys.conversations.all, (oldData: any) => {
        if (!oldData?.pages) return oldData;
        return {
          ...oldData,
          pages: oldData.pages.map((page: any) => ({
            ...page,
            conversations: page.conversations.filter((c: Conversation) => c.id !== id),
          })),
        };
      });
      queryClient.removeQueries({ queryKey: queryKeys.conversations.detail(id) });
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to delete conversation');
    },
  });
}

export function useCreateConversation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params?: { agentId?: string }): Promise<Conversation> => {
      try {
        const response = await apiClient.post('/conversations/new', {
          ...(params?.agentId && { agentId: params.agentId }),
        });
        const data = response.data;
        const conversation: Conversation = {
          id: data.id,
          title: data.title,
          lastMessage: undefined,
          source: data.source,
          agentId: data.agentId,
          createdAt: new Date(data.createdAt),
          updatedAt: new Date(data.updatedAt),
          messages: [],
        };
        syncConversationToDb(conversation);
        return conversation;
      } catch (error: unknown) {
        const axiosError = error as { response?: { status: number } };
        if (axiosError.response?.status === 401) {
          const { generateUUID } = await import('../utils');
          const id = generateUUID();
          const now = Date.now();
          const db = getDatabase();
          const convRow: ConversationRow = {
            id,
            title: 'New chat',
            source: null,
            agent_id: params?.agentId ?? null,
            last_message: null,
            is_favorite: 0,
            is_pinned: 0,
            created_at: now,
            updated_at: now,
            synced_at: null,
          };
          upsertConvDb(db, convRow);

          return {
            id,
            title: 'New chat',
            lastMessage: undefined,
            agentId: params?.agentId,
            createdAt: new Date(now),
            updatedAt: new Date(now),
            messages: [],
          };
        }
        throw error;
      }
    },
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.conversations.all, (oldData: any) => {
        if (!oldData?.pages) {
          return {
            pages: [{ conversations: [data], nextCursor: null, hasMore: false }],
            pageParams: [undefined],
          };
        }

        const newPages = [...oldData.pages];
        if (newPages[0]) {
          const exists = newPages[0].conversations.some((c: Conversation) => c.id === data.id);
          if (!exists) {
            newPages[0] = { ...newPages[0], conversations: [data, ...newPages[0].conversations] };
          }
        }

        return { ...oldData, pages: newPages };
      });

      queryClient.setQueryData(queryKeys.conversations.detail(data.id), data);
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to create conversation');
    },
  });
}
```

- [ ] **Step 4: Verify build**

```bash
cd /home/nate/Oxy/Alia && bun run build:frontend
```

- [ ] **Step 5: Commit**

```bash
git add apps/app/lib/db/hooks/use-conversations-db.ts apps/app/lib/db/hooks/use-search.ts apps/app/lib/hooks/use-conversations.ts
git commit -m "feat: rewrite conversation hooks to use SQLite with API sync and FTS5 search"
```

---

## Task 8: User memory repository and store migration

**Files:**
- Create: `apps/app/lib/db/repositories/user-memory.ts`
- Modify: `apps/app/lib/stores/user-data-store.ts`

- [ ] **Step 1: Create user memory repository**

Create `apps/app/lib/db/repositories/user-memory.ts`:

```typescript
import type { SQLiteDatabase } from 'expo-sqlite';
import type { UserMemoryRow } from '../types';

export function getAllUserMemories(db: SQLiteDatabase): UserMemoryRow[] {
  return db.getAllSync<UserMemoryRow>('SELECT * FROM user_memory ORDER BY updated_at DESC');
}

export function upsertUserMemory(db: SQLiteDatabase, memory: UserMemoryRow): void {
  db.runSync(
    `INSERT INTO user_memory (id, key, value, category, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       key = excluded.key, value = excluded.value, category = excluded.category, updated_at = excluded.updated_at`,
    [memory.id, memory.key, memory.value, memory.category, memory.created_at, memory.updated_at]
  );
}

export function deleteUserMemory(db: SQLiteDatabase, id: string): void {
  db.runSync('DELETE FROM user_memory WHERE id = ?', [id]);
}

export function clearAllUserMemories(db: SQLiteDatabase): void {
  db.runSync('DELETE FROM user_memory');
}
```

- [ ] **Step 2: Rewrite user-data-store to use SQLite**

Replace `apps/app/lib/stores/user-data-store.ts` with:

```typescript
import { create } from 'zustand';
import { getDatabase } from '../db/database';
import { getPreference, setPreference, deletePreference } from '../db/repositories/preferences';
import { getAllUserMemories, upsertUserMemory, clearAllUserMemories } from '../db/repositories/user-memory';
import type { UserMemoryRow } from '../db/types';

interface Memory {
  _id: string;
  key: string;
  value: string;
  category?: string;
  createdAt: string;
  updatedAt: string;
}

interface UserMemory {
  memories: Memory[];
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
  setMemory: (memory: UserMemory) => void;
  setLoading: (loading: boolean) => void;
  clearMemory: () => void;
  shouldRefetch: () => boolean;
}

const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

export const useUserDataStore = create<UserDataState>((set, get) => ({
  memory: null,
  loading: false,
  lastFetch: null,

  setMemory: (memory) => {
    const db = getDatabase();
    const now = Date.now();

    // Persist memories to SQLite
    clearAllUserMemories(db);
    for (const m of memory.memories) {
      const row: UserMemoryRow = {
        id: m._id,
        key: m.key,
        value: m.value,
        category: m.category ?? null,
        created_at: new Date(m.createdAt).getTime(),
        updated_at: new Date(m.updatedAt).getTime(),
      };
      upsertUserMemory(db, row);
    }

    // Persist preferences and context as JSON in preferences table
    setPreference(db, 'user_memory_preferences', JSON.stringify(memory.preferences));
    setPreference(db, 'user_memory_context', JSON.stringify(memory.context));
    setPreference(db, 'user_data_last_fetch', String(now));

    set({ memory, lastFetch: now });
  },

  setLoading: (loading) => set({ loading }),

  clearMemory: () => {
    const db = getDatabase();
    clearAllUserMemories(db);
    deletePreference(db, 'user_memory_preferences');
    deletePreference(db, 'user_memory_context');
    deletePreference(db, 'user_data_last_fetch');
    set({ memory: null, lastFetch: null });
  },

  shouldRefetch: () => {
    const { lastFetch } = get();
    if (!lastFetch) {
      // Check SQLite for cached data
      const db = getDatabase();
      const cached = getPreference(db, 'user_data_last_fetch');
      if (cached) {
        const cachedTime = parseInt(cached, 10);
        if (Date.now() - cachedTime < CACHE_DURATION) {
          // Hydrate from SQLite
          const memoryRows = getAllUserMemories(db);
          const prefsRaw = getPreference(db, 'user_memory_preferences');
          const contextRaw = getPreference(db, 'user_memory_context');

          const memories: Memory[] = memoryRows.map((r) => ({
            _id: r.id,
            key: r.key,
            value: r.value,
            category: r.category ?? undefined,
            createdAt: new Date(r.created_at).toISOString(),
            updatedAt: new Date(r.updated_at).toISOString(),
          }));

          set({
            memory: {
              memories,
              preferences: prefsRaw ? JSON.parse(prefsRaw) : {},
              context: contextRaw ? JSON.parse(contextRaw) : {},
            },
            lastFetch: cachedTime,
          });

          return false;
        }
      }
      return true;
    }
    return Date.now() - lastFetch > CACHE_DURATION;
  },
}));
```

- [ ] **Step 3: Verify build**

```bash
cd /home/nate/Oxy/Alia && bun run build:frontend
```

- [ ] **Step 4: Commit**

```bash
git add apps/app/lib/db/repositories/user-memory.ts apps/app/lib/stores/user-data-store.ts
git commit -m "feat: migrate user memory and data store to SQLite"
```

---

## Task 9: AsyncStorage → SQLite one-time data migration

**Files:**
- Create: `apps/app/lib/db/migrate-from-async.ts`
- Modify: `apps/app/lib/db/database.ts`

- [ ] **Step 1: Create the migration script**

Create `apps/app/lib/db/migrate-from-async.ts`:

```typescript
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SQLiteDatabase } from 'expo-sqlite';
import { setPreference, getPreference } from './repositories/preferences';
import { insertProject } from './repositories/projects';
import { insertFolder } from './repositories/folders';
import { insertRole } from './repositories/roles';
import { upsertConversation } from './repositories/conversations';
import { insertMessagesBatch } from './repositories/messages';
import type { ProjectRow, FolderRow, RoleRow, ConversationRow, MessageRow } from './types';

const MIGRATION_KEY = 'async_to_sqlite_complete';

export async function migrateFromAsyncStorage(db: SQLiteDatabase): Promise<void> {
  // Check if already migrated
  if (getPreference(db, MIGRATION_KEY)) return;

  // 1. Theme preferences
  const themeRaw = await AsyncStorage.getItem('theme-storage');
  if (themeRaw) {
    try {
      const parsed = JSON.parse(themeRaw);
      const state = parsed.state ?? parsed;
      if (state.mode) setPreference(db, 'theme_mode', state.mode);
      if (state.appColor) setPreference(db, 'theme_app_color', state.appColor);
    } catch { /* skip malformed data */ }
  }

  // 2. Locale
  const i18nRaw = await AsyncStorage.getItem('i18n-storage');
  if (i18nRaw) {
    try {
      const parsed = JSON.parse(i18nRaw);
      const state = parsed.state ?? parsed;
      if (state.locale) setPreference(db, 'i18n_locale', state.locale);
    } catch { /* skip */ }
  }

  // 3. Organization
  const orgRaw = await AsyncStorage.getItem('organization-storage');
  if (orgRaw) {
    try {
      const parsed = JSON.parse(orgRaw);
      const state = parsed.state ?? parsed;
      if (state.selectedOrgId) setPreference(db, 'selected_org_id', state.selectedOrgId);
    } catch { /* skip */ }
  }

  // 4. Projects
  const projectsRaw = await AsyncStorage.getItem('alia-projects');
  if (projectsRaw) {
    try {
      const projects = JSON.parse(projectsRaw);
      db.execSync('BEGIN TRANSACTION');
      for (const p of projects) {
        const row: ProjectRow = {
          id: p.id,
          name: p.name,
          description: p.description ?? null,
          icon: p.icon ?? null,
          color: p.color ?? null,
          is_expanded: p.isExpanded ? 1 : 0,
          created_at: new Date(p.createdAt).getTime(),
          updated_at: new Date(p.updatedAt).getTime(),
        };
        insertProject(db, row);
        // Migrate conversation associations
        if (Array.isArray(p.conversationIds)) {
          for (const convId of p.conversationIds) {
            db.runSync(
              `INSERT OR IGNORE INTO collection_conversations (collection_type, collection_id, conversation_id, added_at)
               VALUES (?, ?, ?, ?)`,
              ['project', p.id, convId, Date.now()]
            );
          }
        }
      }
      db.execSync('COMMIT');
    } catch (error) {
      db.execSync('ROLLBACK');
      // Log but don't block migration
    }
  }

  // 5. Current project
  const currentProject = await AsyncStorage.getItem('alia-current-project');
  if (currentProject) {
    setPreference(db, 'current_project_id', currentProject);
  }

  // 6. Folders
  const foldersRaw = await AsyncStorage.getItem('alia-folders');
  if (foldersRaw) {
    try {
      const folders = JSON.parse(foldersRaw);
      db.execSync('BEGIN TRANSACTION');
      for (const f of folders) {
        const row: FolderRow = {
          id: f.id,
          name: f.name,
          icon: f.icon ?? null,
          color: f.color ?? null,
          is_favorite: f.isFavorite ? 1 : 0,
          is_expanded: f.isExpanded ? 1 : 0,
          created_at: new Date(f.createdAt).getTime(),
          updated_at: new Date(f.updatedAt).getTime(),
        };
        insertFolder(db, row);
        if (Array.isArray(f.conversationIds)) {
          for (const convId of f.conversationIds) {
            db.runSync(
              `INSERT OR IGNORE INTO collection_conversations (collection_type, collection_id, conversation_id, added_at)
               VALUES (?, ?, ?, ?)`,
              ['folder', f.id, convId, Date.now()]
            );
          }
        }
      }
      db.execSync('COMMIT');
    } catch (error) {
      db.execSync('ROLLBACK');
    }
  }

  // 7. Favorites
  const favoritesRaw = await AsyncStorage.getItem('alia-favorite-conversations');
  if (favoritesRaw) {
    try {
      const favoriteIds: string[] = JSON.parse(favoritesRaw);
      for (const id of favoriteIds) {
        const existing = db.getFirstSync('SELECT id FROM conversations WHERE id = ?', [id]);
        if (existing) {
          db.runSync('UPDATE conversations SET is_favorite = 1 WHERE id = ?', [id]);
        } else {
          const now = Date.now();
          db.runSync(
            'INSERT OR IGNORE INTO conversations (id, title, is_favorite, is_pinned, created_at, updated_at) VALUES (?, ?, 1, 0, ?, ?)',
            [id, 'Imported', now, now]
          );
        }
      }
    } catch { /* skip */ }
  }

  // 8. Pinned
  const pinnedRaw = await AsyncStorage.getItem('alia-pinned-conversations');
  if (pinnedRaw) {
    try {
      const pinnedIds: string[] = JSON.parse(pinnedRaw);
      for (const id of pinnedIds) {
        const existing = db.getFirstSync('SELECT id FROM conversations WHERE id = ?', [id]);
        if (existing) {
          db.runSync('UPDATE conversations SET is_pinned = 1 WHERE id = ?', [id]);
        } else {
          const now = Date.now();
          db.runSync(
            'INSERT OR IGNORE INTO conversations (id, title, is_pinned, is_favorite, created_at, updated_at) VALUES (?, ?, 1, 0, ?, ?)',
            [id, 'Imported', now, now]
          );
        }
      }
    } catch { /* skip */ }
  }

  // 9. Agent favorites
  const agentFavRaw = await AsyncStorage.getItem('alia-favorite-agents');
  if (agentFavRaw) {
    setPreference(db, 'favorite_agent_ids', agentFavRaw);
  }

  // 10. Roles (only custom ones — defaults are seeded by the store)
  const rolesRaw = await AsyncStorage.getItem('alia-roles');
  if (rolesRaw) {
    try {
      const roles = JSON.parse(rolesRaw);
      const customRoles = roles.filter((r: { isCustom?: boolean }) => r.isCustom);
      for (const r of customRoles) {
        const { author, authorVerified, useCase, goodAt, notGoodAt, examplePrompts,
          reasoning, writingStyle, priorities, tone, reviewCount, forkCount, version,
          forkedFrom, isTrending, isVerified, isPublished, ...rest } = r;
        const row: RoleRow = {
          id: rest.id,
          name: rest.name,
          tagline: rest.tagline ?? null,
          description: rest.description ?? null,
          category: rest.category ?? null,
          system_prompt: null,
          config: JSON.stringify({
            author, authorVerified, useCase, goodAt, notGoodAt, examplePrompts,
            reasoning, writingStyle, priorities, tone, reviewCount, forkCount,
            version, forkedFrom, isTrending, isVerified, isPublished,
          }),
          is_custom: 1,
          is_featured: rest.isFeatured ? 1 : 0,
          usage_count: rest.usageCount ?? 0,
          rating: rest.rating ?? 0,
          created_at: new Date(rest.createdAt).getTime(),
          updated_at: new Date(rest.updatedAt).getTime(),
        };
        insertRole(db, row);
      }
    } catch { /* skip */ }
  }

  // 11. User data
  const userDataRaw = await AsyncStorage.getItem('user-data-storage');
  if (userDataRaw) {
    try {
      const parsed = JSON.parse(userDataRaw);
      const state = parsed.state ?? parsed;
      if (state.memory) {
        if (state.memory.preferences) {
          setPreference(db, 'user_memory_preferences', JSON.stringify(state.memory.preferences));
        }
        if (state.memory.context) {
          setPreference(db, 'user_memory_context', JSON.stringify(state.memory.context));
        }
        if (Array.isArray(state.memory.memories)) {
          for (const m of state.memory.memories) {
            db.runSync(
              `INSERT OR REPLACE INTO user_memory (id, key, value, category, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)`,
              [m._id, m.key, m.value, m.category ?? null,
               new Date(m.createdAt).getTime(), new Date(m.updatedAt).getTime()]
            );
          }
        }
      }
      if (state.lastFetch) {
        setPreference(db, 'user_data_last_fetch', String(state.lastFetch));
      }
    } catch { /* skip */ }
  }

  // 12. Conversations (offline cache)
  const convsRaw = await AsyncStorage.getItem('alia-conversations');
  if (convsRaw) {
    try {
      const convs = JSON.parse(convsRaw);
      db.execSync('BEGIN TRANSACTION');
      for (const conv of convs) {
        const convRow: ConversationRow = {
          id: conv.id,
          title: conv.title ?? 'Imported',
          source: conv.source ?? null,
          agent_id: conv.agentId ?? null,
          last_message: conv.lastMessage ?? null,
          is_favorite: 0,
          is_pinned: 0,
          created_at: new Date(conv.createdAt).getTime(),
          updated_at: new Date(conv.updatedAt).getTime(),
          synced_at: null,
        };

        // Check if already exists (e.g., from favorites migration)
        const existing = db.getFirstSync<ConversationRow>('SELECT * FROM conversations WHERE id = ?', [conv.id]);
        if (existing) {
          convRow.is_favorite = existing.is_favorite;
          convRow.is_pinned = existing.is_pinned;
        }

        upsertConversation(db, convRow);

        // Migrate messages if present
        if (Array.isArray(conv.messages) && conv.messages.length > 0) {
          const msgRows: MessageRow[] = conv.messages.map((m: Record<string, unknown>, i: number) => ({
            id: (m.id as string) ?? `migrated-${conv.id}-${i}`,
            conversation_id: conv.id,
            role: m.role as string,
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
            thinking: (m.thinking as string) ?? null,
            tool_invocations: m.toolInvocations ? JSON.stringify(m.toolInvocations) : null,
            source: (m.source as string) ?? null,
            speaker: (m.speaker as string) ?? null,
            agent_info: m.agentInfo ? JSON.stringify(m.agentInfo) : null,
            audio_url: (m.audioUrl as string) ?? null,
            created_at: Date.now() + i,
          }));
          insertMessagesBatch(db, msgRows);
        }
      }
      db.execSync('COMMIT');
    } catch (error) {
      db.execSync('ROLLBACK');
    }
  }

  // Mark migration complete
  setPreference(db, MIGRATION_KEY, '1');
}
```

- [ ] **Step 2: Wire migration into database initialization**

Modify `apps/app/lib/db/database.ts`. Update the `init` function inside `DatabaseProvider`:

```typescript
import { migrateFromAsyncStorage } from './migrate-from-async';

// ... existing code ...

// In DatabaseProvider, update the init function:
  useEffect(() => {
    async function init() {
      const database = getDatabase();
      await runMigrations(database);
      await migrateFromAsyncStorage(database);
      setDb(database);
    }
    init();
  }, []);
```

- [ ] **Step 3: Verify build**

```bash
cd /home/nate/Oxy/Alia && bun run build:frontend
```

- [ ] **Step 4: Commit**

```bash
git add apps/app/lib/db/migrate-from-async.ts apps/app/lib/db/database.ts
git commit -m "feat: add one-time AsyncStorage to SQLite data migration"
```

---

## Task 10: Sync queue repository

**Files:**
- Create: `apps/app/lib/db/repositories/sync-queue.ts`

- [ ] **Step 1: Create sync queue repository**

Create `apps/app/lib/db/repositories/sync-queue.ts`:

```typescript
import type { SQLiteDatabase } from 'expo-sqlite';
import type { SyncQueueRow } from '../types';

export function enqueue(
  db: SQLiteDatabase,
  entityType: string,
  entityId: string,
  action: string,
  payload?: Record<string, unknown>
): void {
  db.runSync(
    'INSERT INTO sync_queue (entity_type, entity_id, action, payload, created_at, attempts) VALUES (?, ?, ?, ?, ?, 0)',
    [entityType, entityId, action, payload ? JSON.stringify(payload) : null, Date.now()]
  );
}

export function dequeue(db: SQLiteDatabase, limit: number = 10): SyncQueueRow[] {
  return db.getAllSync<SyncQueueRow>(
    'SELECT * FROM sync_queue WHERE attempts < 5 ORDER BY created_at ASC LIMIT ?',
    [limit]
  );
}

export function markAttempted(db: SQLiteDatabase, id: number): void {
  db.runSync('UPDATE sync_queue SET attempts = attempts + 1 WHERE id = ?', [id]);
}

export function removeFromQueue(db: SQLiteDatabase, id: number): void {
  db.runSync('DELETE FROM sync_queue WHERE id = ?', [id]);
}

export function getQueueSize(db: SQLiteDatabase): number {
  const row = db.getFirstSync<{ count: number }>('SELECT COUNT(*) as count FROM sync_queue');
  return row?.count ?? 0;
}

export function clearQueue(db: SQLiteDatabase): void {
  db.runSync('DELETE FROM sync_queue');
}
```

- [ ] **Step 2: Verify build**

```bash
cd /home/nate/Oxy/Alia && bun run build:frontend
```

- [ ] **Step 3: Commit**

```bash
git add apps/app/lib/db/repositories/sync-queue.ts
git commit -m "feat: add sync queue repository for offline operation tracking"
```

---

## Task 11: Remove AsyncStorage imports from migrated stores

**Files:**
- Modify: `apps/app/lib/stores/create-collection-store.ts` (remove AsyncStorage import, keep utility functions)

- [ ] **Step 1: Clean up create-collection-store.ts**

The `CollectionPersister` class is no longer used by projects-store or folders-store (they use SQLite repositories now). However, if other code still imports `CollectionItem`, `getRandomColor`, or `getRandomIcon`, keep those exports. Remove only the `CollectionPersister` class and the AsyncStorage import.

Replace `apps/app/lib/stores/create-collection-store.ts` with:

```typescript
/**
 * Base interface for items managed by a collection store.
 */
export interface CollectionItem {
  id: string;
  name: string;
  icon?: string;
  color?: string;
  conversationIds: string[];
  isExpanded: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const COLORS = [
  "#3b82f6", "#8b5cf6", "#ec4899", "#f59e0b",
  "#10b981", "#06b6d4", "#f97316", "#ef4444",
];

export function getRandomColor(): string {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

export function getRandomIcon(icons: string[]): string {
  return icons[Math.floor(Math.random() * icons.length)];
}
```

- [ ] **Step 2: Verify no remaining AsyncStorage imports in migrated stores**

Run:
```bash
cd /home/nate/Oxy/Alia && grep -r "AsyncStorage" apps/app/lib/stores/ --include="*.ts" -l
```

Expected: No files listed (all stores have been migrated to SQLite). If any remain, they need to be updated.

- [ ] **Step 3: Verify build**

```bash
cd /home/nate/Oxy/Alia && bun run build:frontend
```

- [ ] **Step 4: Commit**

```bash
git add apps/app/lib/stores/create-collection-store.ts
git commit -m "refactor: remove CollectionPersister and AsyncStorage from collection store base"
```

---

## Task 12: Final verification and cleanup

- [ ] **Step 1: Full build check**

```bash
cd /home/nate/Oxy/Alia && bun run build:frontend
```

Expected: Clean build, no TypeScript errors.

- [ ] **Step 2: Verify AsyncStorage is no longer used for persistence (except in migration)**

```bash
cd /home/nate/Oxy/Alia && grep -r "AsyncStorage" apps/app/lib/ --include="*.ts" -l
```

Expected: Only `apps/app/lib/db/migrate-from-async.ts` should appear (the one-time migration script).

- [ ] **Step 3: Verify all SQLite files are in place**

```bash
ls -la apps/app/lib/db/ apps/app/lib/db/repositories/ apps/app/lib/db/hooks/
```

Expected files:
```
db/database.ts
db/migrations.ts
db/migrate-from-async.ts
db/types.ts
db/repositories/preferences.ts
db/repositories/projects.ts
db/repositories/folders.ts
db/repositories/roles.ts
db/repositories/conversations.ts
db/repositories/messages.ts
db/repositories/user-memory.ts
db/repositories/sync-queue.ts
db/hooks/use-conversations-db.ts
db/hooks/use-search.ts
```

- [ ] **Step 4: Commit everything**

```bash
git add -A
git commit -m "feat: complete SQLite frontend data layer — replace AsyncStorage with expo-sqlite"
```
