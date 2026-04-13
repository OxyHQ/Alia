import type { SQLiteDatabase } from 'expo-sqlite';
import type { SyncQueueRow } from '../types';

export function enqueue(
  db: SQLiteDatabase,
  entityType: string,
  entityId: string,
  action: string,
  payload?: Record<string, unknown>,
): void {
  db.runSync(
    `INSERT INTO sync_queue (entity_type, entity_id, action, payload, created_at, attempts)
     VALUES (?, ?, ?, ?, ?, 0)`,
    [entityType, entityId, action, JSON.stringify(payload ?? {}), Date.now()],
  );
}

export function dequeue(db: SQLiteDatabase, limit?: number): SyncQueueRow[] {
  return db.getAllSync<SyncQueueRow>(
    'SELECT * FROM sync_queue ORDER BY created_at ASC LIMIT ?',
    [limit ?? 10],
  );
}

export function peek(db: SQLiteDatabase): SyncQueueRow | null {
  return db.getFirstSync<SyncQueueRow>(
    'SELECT * FROM sync_queue ORDER BY created_at ASC LIMIT 1',
  );
}

export function incrementAttempts(db: SQLiteDatabase, id: number): void {
  db.runSync('UPDATE sync_queue SET attempts = attempts + 1 WHERE id = ?', [id]);
}

export function remove(db: SQLiteDatabase, id: number): void {
  db.runSync('DELETE FROM sync_queue WHERE id = ?', [id]);
}

export function removeBatch(db: SQLiteDatabase, ids: number[]): void {
  if (ids.length === 0) return;

  const placeholders = ids.map(() => '?').join(', ');
  db.runSync(`DELETE FROM sync_queue WHERE id IN (${placeholders})`, ids);
}

export function removeByEntity(
  db: SQLiteDatabase,
  entityType: string,
  entityId: string,
): void {
  db.runSync(
    'DELETE FROM sync_queue WHERE entity_type = ? AND entity_id = ?',
    [entityType, entityId],
  );
}

export function countPending(db: SQLiteDatabase): number {
  const row = db.getFirstSync<{ count: number }>(
    'SELECT COUNT(*) AS count FROM sync_queue',
  );
  return row?.count ?? 0;
}

export function getFailedItems(db: SQLiteDatabase, maxAttempts: number): SyncQueueRow[] {
  return db.getAllSync<SyncQueueRow>(
    'SELECT * FROM sync_queue WHERE attempts >= ? ORDER BY created_at ASC',
    [maxAttempts],
  );
}
