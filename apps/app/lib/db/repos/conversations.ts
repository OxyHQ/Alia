import type { SQLiteDatabase } from 'expo-sqlite';
import type { ConversationRow } from '../types';

interface ListConversationsOptions {
  limit?: number;
  offset?: number;
  agentId?: string;
}

export function listConversations(
  db: SQLiteDatabase,
  options?: ListConversationsOptions,
): ConversationRow[] {
  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;

  if (options?.agentId) {
    return db.getAllSync<ConversationRow>(
      'SELECT * FROM conversations WHERE agent_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?',
      [options.agentId, limit, offset],
    );
  }

  return db.getAllSync<ConversationRow>(
    'SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ? OFFSET ?',
    [limit, offset],
  );
}

export function getConversation(db: SQLiteDatabase, id: string): ConversationRow | null {
  return db.getFirstSync<ConversationRow>('SELECT * FROM conversations WHERE id = ?', [id]);
}

export function upsertConversation(
  db: SQLiteDatabase,
  conv: Omit<ConversationRow, 'synced_at'>,
): void {
  db.runSync(
    `INSERT OR REPLACE INTO conversations
       (id, title, source, agent_id, last_message, is_favorite, is_pinned, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      conv.id,
      conv.title,
      conv.source,
      conv.agent_id,
      conv.last_message,
      conv.is_favorite,
      conv.is_pinned,
      conv.created_at,
      conv.updated_at,
    ],
  );
}

export function deleteConversation(db: SQLiteDatabase, id: string): void {
  db.runSync('DELETE FROM conversations WHERE id = ?', [id]);
}

export function setFavorite(db: SQLiteDatabase, id: string, value: boolean): void {
  db.runSync('UPDATE conversations SET is_favorite = ? WHERE id = ?', [value ? 1 : 0, id]);
}

export function setPinned(db: SQLiteDatabase, id: string, value: boolean): void {
  db.runSync('UPDATE conversations SET is_pinned = ? WHERE id = ?', [value ? 1 : 0, id]);
}

export function markSynced(db: SQLiteDatabase, id: string): void {
  db.runSync('UPDATE conversations SET synced_at = ? WHERE id = ?', [Date.now(), id]);
}

export function getUnsyncedConversations(db: SQLiteDatabase): ConversationRow[] {
  return db.getAllSync<ConversationRow>(
    'SELECT * FROM conversations WHERE synced_at IS NULL ORDER BY updated_at DESC',
  );
}

export function searchConversations(db: SQLiteDatabase, query: string): ConversationRow[] {
  const pattern = `%${query}%`;
  return db.getAllSync<ConversationRow>(
    'SELECT * FROM conversations WHERE title LIKE ? ORDER BY updated_at DESC',
    [pattern],
  );
}
