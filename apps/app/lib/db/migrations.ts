import type { SQLiteDatabase } from 'expo-sqlite';

interface Migration {
  version: number;
  up: (db: SQLiteDatabase) => void;
}

const migrations: Migration[] = [
  {
    version: 1,
    up(db: SQLiteDatabase) {
      db.execSync(`
        CREATE TABLE IF NOT EXISTS conversations (
          id            TEXT PRIMARY KEY NOT NULL,
          title         TEXT NOT NULL DEFAULT '',
          source        TEXT NOT NULL DEFAULT '',
          agent_id      TEXT NOT NULL DEFAULT '',
          last_message  TEXT NOT NULL DEFAULT '',
          is_favorite   INTEGER NOT NULL DEFAULT 0,
          is_pinned     INTEGER NOT NULL DEFAULT 0,
          created_at    INTEGER NOT NULL,
          updated_at    INTEGER NOT NULL,
          synced_at     INTEGER
        );

        CREATE TABLE IF NOT EXISTS messages (
          id                TEXT PRIMARY KEY NOT NULL,
          conversation_id   TEXT NOT NULL,
          role              TEXT NOT NULL,
          content           TEXT NOT NULL DEFAULT '',
          thinking          TEXT NOT NULL DEFAULT '',
          tool_invocations  TEXT NOT NULL DEFAULT '[]',
          source            TEXT NOT NULL DEFAULT '',
          speaker           TEXT NOT NULL DEFAULT '',
          agent_info        TEXT NOT NULL DEFAULT '{}',
          audio_url         TEXT NOT NULL DEFAULT '',
          created_at        INTEGER NOT NULL,
          FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS projects (
          id          TEXT PRIMARY KEY NOT NULL,
          name        TEXT NOT NULL DEFAULT '',
          description TEXT NOT NULL DEFAULT '',
          icon        TEXT NOT NULL DEFAULT '',
          color       TEXT NOT NULL DEFAULT '',
          is_expanded INTEGER NOT NULL DEFAULT 0,
          created_at  INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS folders (
          id          TEXT PRIMARY KEY NOT NULL,
          name        TEXT NOT NULL DEFAULT '',
          icon        TEXT NOT NULL DEFAULT '',
          color       TEXT NOT NULL DEFAULT '',
          is_favorite INTEGER NOT NULL DEFAULT 0,
          is_expanded INTEGER NOT NULL DEFAULT 0,
          created_at  INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS collection_conversations (
          collection_type TEXT NOT NULL CHECK(collection_type IN ('project', 'folder')),
          collection_id   TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          added_at        INTEGER NOT NULL,
          PRIMARY KEY (collection_type, collection_id, conversation_id),
          FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS roles (
          id            TEXT PRIMARY KEY NOT NULL,
          name          TEXT NOT NULL DEFAULT '',
          tagline       TEXT NOT NULL DEFAULT '',
          description   TEXT NOT NULL DEFAULT '',
          category      TEXT NOT NULL DEFAULT '',
          system_prompt TEXT NOT NULL DEFAULT '',
          config        TEXT NOT NULL DEFAULT '{}',
          is_custom     INTEGER NOT NULL DEFAULT 0,
          is_featured   INTEGER NOT NULL DEFAULT 0,
          usage_count   INTEGER NOT NULL DEFAULT 0,
          rating        REAL NOT NULL DEFAULT 0,
          created_at    INTEGER NOT NULL,
          updated_at    INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS user_memory (
          id         TEXT PRIMARY KEY NOT NULL,
          key        TEXT NOT NULL,
          value      TEXT NOT NULL DEFAULT '',
          category   TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS preferences (
          key   TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL DEFAULT '{}'
        );

        CREATE TABLE IF NOT EXISTS sync_queue (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          entity_type TEXT NOT NULL,
          entity_id   TEXT NOT NULL,
          action      TEXT NOT NULL,
          payload     TEXT NOT NULL DEFAULT '{}',
          created_at  INTEGER NOT NULL,
          attempts    INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_messages_conversation
          ON messages(conversation_id);

        CREATE INDEX IF NOT EXISTS idx_messages_created
          ON messages(created_at);

        CREATE INDEX IF NOT EXISTS idx_conversations_updated
          ON conversations(updated_at);

        CREATE INDEX IF NOT EXISTS idx_conversations_agent
          ON conversations(agent_id);

        CREATE INDEX IF NOT EXISTS idx_collection_conv_collection
          ON collection_conversations(collection_type, collection_id);

        CREATE INDEX IF NOT EXISTS idx_roles_category
          ON roles(category);

        CREATE INDEX IF NOT EXISTS idx_user_memory_key
          ON user_memory(key);

        CREATE INDEX IF NOT EXISTS idx_user_memory_category
          ON user_memory(category);

        CREATE INDEX IF NOT EXISTS idx_sync_queue_entity
          ON sync_queue(entity_type, entity_id);
      `);
    },
  },
  {
    version: 2,
    up(db: SQLiteDatabase) {
      db.execSync(`
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
          USING fts5(id UNINDEXED, content, content=messages, content_rowid=rowid);

        CREATE TRIGGER IF NOT EXISTS messages_fts_insert
          AFTER INSERT ON messages
        BEGIN
          INSERT INTO messages_fts(rowid, id, content)
            VALUES (NEW.rowid, NEW.id, NEW.content);
        END;

        CREATE TRIGGER IF NOT EXISTS messages_fts_delete
          AFTER DELETE ON messages
        BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, id, content)
            VALUES ('delete', OLD.rowid, OLD.id, OLD.content);
        END;

        CREATE TRIGGER IF NOT EXISTS messages_fts_update
          AFTER UPDATE OF content ON messages
        BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, id, content)
            VALUES ('delete', OLD.rowid, OLD.id, OLD.content);
          INSERT INTO messages_fts(rowid, id, content)
            VALUES (NEW.rowid, NEW.id, NEW.content);
        END;
      `);
    },
  },
];

/**
 * Run all pending migrations against the given database.
 * Creates the `_migrations` tracking table on first run.
 */
export function runMigrations(db: SQLiteDatabase): void {
  db.execSync(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version    INTEGER PRIMARY KEY NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  const applied = db
    .getAllSync<{ version: number }>('SELECT version FROM _migrations ORDER BY version')
    .map((row) => row.version);

  const appliedSet = new Set(applied);

  for (const migration of migrations) {
    if (appliedSet.has(migration.version)) continue;

    db.withTransactionSync(() => {
      migration.up(db);
      db.runSync('INSERT INTO _migrations (version, applied_at) VALUES (?, ?)', [
        migration.version,
        Date.now(),
      ]);
    });
  }
}
