import type { SQLiteDatabase } from 'expo-sqlite';
import type { RoleRow } from '../types';

export function listRoles(db: SQLiteDatabase): RoleRow[] {
  return db.getAllSync<RoleRow>('SELECT * FROM roles ORDER BY name ASC');
}

export function getRolesByCategory(db: SQLiteDatabase, category: string): RoleRow[] {
  return db.getAllSync<RoleRow>('SELECT * FROM roles WHERE category = ? ORDER BY name ASC', [
    category,
  ]);
}

export function getRole(db: SQLiteDatabase, id: string): RoleRow | null {
  return db.getFirstSync<RoleRow>('SELECT * FROM roles WHERE id = ?', [id]);
}

export function upsertRole(db: SQLiteDatabase, role: RoleRow): void {
  db.runSync(
    `INSERT OR REPLACE INTO roles
       (id, name, tagline, description, category, system_prompt, config, is_custom, is_featured, usage_count, rating, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      role.id,
      role.name,
      role.tagline,
      role.description,
      role.category,
      role.system_prompt,
      role.config,
      role.is_custom,
      role.is_featured,
      role.usage_count,
      role.rating,
      role.created_at,
      role.updated_at,
    ],
  );
}

export function upsertRoles(db: SQLiteDatabase, roles: RoleRow[]): void {
  db.withTransactionSync(() => {
    for (const role of roles) {
      upsertRole(db, role);
    }
  });
}

export function deleteRole(db: SQLiteDatabase, id: string): void {
  db.runSync('DELETE FROM roles WHERE id = ?', [id]);
}

export function incrementUsageCount(db: SQLiteDatabase, id: string): void {
  db.runSync('UPDATE roles SET usage_count = usage_count + 1 WHERE id = ?', [id]);
}

export function getFeaturedRoles(db: SQLiteDatabase): RoleRow[] {
  return db.getAllSync<RoleRow>('SELECT * FROM roles WHERE is_featured = 1 ORDER BY name ASC');
}

export function getCustomRoles(db: SQLiteDatabase): RoleRow[] {
  return db.getAllSync<RoleRow>('SELECT * FROM roles WHERE is_custom = 1 ORDER BY name ASC');
}

export function searchRoles(db: SQLiteDatabase, query: string): RoleRow[] {
  const pattern = `%${query}%`;
  return db.getAllSync<RoleRow>(
    'SELECT * FROM roles WHERE name LIKE ? OR description LIKE ? ORDER BY name ASC',
    [pattern, pattern],
  );
}
