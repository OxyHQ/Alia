import type { SQLiteDatabase } from 'expo-sqlite';
import type { UserMemoryRow } from '../types';

export function listMemories(db: SQLiteDatabase): UserMemoryRow[] {
  return db.getAllSync<UserMemoryRow>(
    'SELECT * FROM user_memory ORDER BY updated_at DESC',
  );
}

export function getMemoriesByCategory(
  db: SQLiteDatabase,
  category: string,
): UserMemoryRow[] {
  return db.getAllSync<UserMemoryRow>(
    'SELECT * FROM user_memory WHERE category = ? ORDER BY updated_at DESC',
    [category],
  );
}

export function getMemory(db: SQLiteDatabase, id: string): UserMemoryRow | null {
  return db.getFirstSync<UserMemoryRow>('SELECT * FROM user_memory WHERE id = ?', [id]);
}

export function getMemoryByKey(db: SQLiteDatabase, key: string): UserMemoryRow | null {
  return db.getFirstSync<UserMemoryRow>('SELECT * FROM user_memory WHERE key = ?', [key]);
}

export function upsertMemory(db: SQLiteDatabase, memory: UserMemoryRow): void {
  db.runSync(
    `INSERT OR REPLACE INTO user_memory
       (id, key, value, category, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      memory.id,
      memory.key,
      memory.value,
      memory.category,
      memory.created_at,
      memory.updated_at,
    ],
  );
}

export function deleteMemory(db: SQLiteDatabase, id: string): void {
  db.runSync('DELETE FROM user_memory WHERE id = ?', [id]);
}

export function clearCategory(db: SQLiteDatabase, category: string): void {
  db.runSync('DELETE FROM user_memory WHERE category = ?', [category]);
}

export function countMemories(db: SQLiteDatabase): number {
  const row = db.getFirstSync<{ count: number }>(
    'SELECT COUNT(*) AS count FROM user_memory',
  );
  return row?.count ?? 0;
}
