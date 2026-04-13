import type { SQLiteDatabase } from 'expo-sqlite';
import type { MessageRow } from '../types';

interface ListMessagesOptions {
  limit?: number;
  offset?: number;
}

interface SearchMessagesOptions {
  limit?: number;
}

export function listMessages(
  db: SQLiteDatabase,
  conversationId: string,
  options?: ListMessagesOptions,
): MessageRow[] {
  const limit = options?.limit ?? 100;
  const offset = options?.offset ?? 0;

  return db.getAllSync<MessageRow>(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ? OFFSET ?',
    [conversationId, limit, offset],
  );
}

export function getMessage(db: SQLiteDatabase, id: string): MessageRow | null {
  return db.getFirstSync<MessageRow>('SELECT * FROM messages WHERE id = ?', [id]);
}

export function insertMessage(db: SQLiteDatabase, msg: MessageRow): void {
  db.runSync(
    `INSERT INTO messages
       (id, conversation_id, role, content, thinking, tool_invocations, source, speaker, agent_info, audio_url, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      msg.id,
      msg.conversation_id,
      msg.role,
      msg.content,
      msg.thinking,
      msg.tool_invocations,
      msg.source,
      msg.speaker,
      msg.agent_info,
      msg.audio_url,
      msg.created_at,
    ],
  );
}

export function insertMessages(db: SQLiteDatabase, msgs: MessageRow[]): void {
  db.withTransactionSync(() => {
    for (const msg of msgs) {
      insertMessage(db, msg);
    }
  });
}

export function updateMessageContent(db: SQLiteDatabase, id: string, content: string): void {
  db.runSync('UPDATE messages SET content = ? WHERE id = ?', [content, id]);
}

export function deleteMessage(db: SQLiteDatabase, id: string): void {
  db.runSync('DELETE FROM messages WHERE id = ?', [id]);
}

export function deleteConversationMessages(db: SQLiteDatabase, conversationId: string): void {
  db.runSync('DELETE FROM messages WHERE conversation_id = ?', [conversationId]);
}

export function searchMessages(
  db: SQLiteDatabase,
  query: string,
  options?: SearchMessagesOptions,
): MessageRow[] {
  const limit = options?.limit ?? 50;

  return db.getAllSync<MessageRow>(
    `SELECT m.*
     FROM messages_fts fts
     JOIN messages m ON m.id = fts.id
     WHERE messages_fts MATCH ?
     ORDER BY fts.rank
     LIMIT ?`,
    [query, limit],
  );
}

export function getLatestMessage(db: SQLiteDatabase, conversationId: string): MessageRow | null {
  return db.getFirstSync<MessageRow>(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1',
    [conversationId],
  );
}

export function countMessages(db: SQLiteDatabase, conversationId: string): number {
  const row = db.getFirstSync<{ count: number }>(
    'SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?',
    [conversationId],
  );
  return row?.count ?? 0;
}
