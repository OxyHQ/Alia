import type { SQLiteDatabase } from 'expo-sqlite';
import type { PreferenceRow } from '../types';

export function getPreference<T>(db: SQLiteDatabase, key: string): T | null {
  const row = db.getFirstSync<PreferenceRow>(
    'SELECT * FROM preferences WHERE key = ?',
    [key],
  );

  if (!row) return null;

  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export function setPreference(db: SQLiteDatabase, key: string, value: unknown): void {
  db.runSync(
    'INSERT OR REPLACE INTO preferences (key, value) VALUES (?, ?)',
    [key, JSON.stringify(value)],
  );
}

export function deletePreference(db: SQLiteDatabase, key: string): void {
  db.runSync('DELETE FROM preferences WHERE key = ?', [key]);
}

export function getAllPreferences(db: SQLiteDatabase): Record<string, unknown> {
  const rows = db.getAllSync<PreferenceRow>('SELECT * FROM preferences');
  const result: Record<string, unknown> = {};

  for (const row of rows) {
    try {
      result[row.key] = JSON.parse(row.value);
    } catch {
      result[row.key] = null;
    }
  }

  return result;
}

export function hasPreference(db: SQLiteDatabase, key: string): boolean {
  const row = db.getFirstSync<{ count: number }>(
    'SELECT COUNT(*) AS count FROM preferences WHERE key = ?',
    [key],
  );
  return (row?.count ?? 0) > 0;
}
