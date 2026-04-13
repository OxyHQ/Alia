import type { SQLiteDatabase } from 'expo-sqlite';
import type { ProjectRow, FolderRow, CollectionConversationRow } from '../types';

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export function listProjects(db: SQLiteDatabase): ProjectRow[] {
  return db.getAllSync<ProjectRow>('SELECT * FROM projects ORDER BY created_at DESC');
}

export function getProject(db: SQLiteDatabase, id: string): ProjectRow | null {
  return db.getFirstSync<ProjectRow>('SELECT * FROM projects WHERE id = ?', [id]);
}

export function upsertProject(db: SQLiteDatabase, project: ProjectRow): void {
  db.runSync(
    `INSERT OR REPLACE INTO projects (id, name, description, icon, color, is_expanded, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      project.id,
      project.name,
      project.description,
      project.icon,
      project.color,
      project.is_expanded,
      project.created_at,
      project.updated_at,
    ],
  );
}

export function deleteProject(db: SQLiteDatabase, id: string): void {
  db.withTransactionSync(() => {
    db.runSync(
      "DELETE FROM collection_conversations WHERE collection_type = 'project' AND collection_id = ?",
      [id],
    );
    db.runSync('DELETE FROM projects WHERE id = ?', [id]);
  });
}

export function setProjectExpanded(db: SQLiteDatabase, id: string, value: boolean): void {
  db.runSync('UPDATE projects SET is_expanded = ? WHERE id = ?', [value ? 1 : 0, id]);
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export function listFolders(db: SQLiteDatabase): FolderRow[] {
  return db.getAllSync<FolderRow>('SELECT * FROM folders ORDER BY created_at DESC');
}

export function getFolder(db: SQLiteDatabase, id: string): FolderRow | null {
  return db.getFirstSync<FolderRow>('SELECT * FROM folders WHERE id = ?', [id]);
}

export function upsertFolder(db: SQLiteDatabase, folder: FolderRow): void {
  db.runSync(
    `INSERT OR REPLACE INTO folders (id, name, icon, color, is_favorite, is_expanded, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      folder.id,
      folder.name,
      folder.icon,
      folder.color,
      folder.is_favorite,
      folder.is_expanded,
      folder.created_at,
      folder.updated_at,
    ],
  );
}

export function deleteFolder(db: SQLiteDatabase, id: string): void {
  db.withTransactionSync(() => {
    db.runSync(
      "DELETE FROM collection_conversations WHERE collection_type = 'folder' AND collection_id = ?",
      [id],
    );
    db.runSync('DELETE FROM folders WHERE id = ?', [id]);
  });
}

export function setFolderExpanded(db: SQLiteDatabase, id: string, value: boolean): void {
  db.runSync('UPDATE folders SET is_expanded = ? WHERE id = ?', [value ? 1 : 0, id]);
}

export function setFolderFavorite(db: SQLiteDatabase, id: string, value: boolean): void {
  db.runSync('UPDATE folders SET is_favorite = ? WHERE id = ?', [value ? 1 : 0, id]);
}

// ---------------------------------------------------------------------------
// Collection Conversations (junction table)
// ---------------------------------------------------------------------------

export function addConversationToCollection(
  db: SQLiteDatabase,
  type: 'project' | 'folder',
  collectionId: string,
  conversationId: string,
): void {
  db.runSync(
    `INSERT OR IGNORE INTO collection_conversations (collection_type, collection_id, conversation_id, added_at)
     VALUES (?, ?, ?, ?)`,
    [type, collectionId, conversationId, Date.now()],
  );
}

export function removeConversationFromCollection(
  db: SQLiteDatabase,
  type: 'project' | 'folder',
  collectionId: string,
  conversationId: string,
): void {
  db.runSync(
    'DELETE FROM collection_conversations WHERE collection_type = ? AND collection_id = ? AND conversation_id = ?',
    [type, collectionId, conversationId],
  );
}

export function getCollectionConversationIds(
  db: SQLiteDatabase,
  type: 'project' | 'folder',
  collectionId: string,
): string[] {
  const rows = db.getAllSync<{ conversation_id: string }>(
    'SELECT conversation_id FROM collection_conversations WHERE collection_type = ? AND collection_id = ?',
    [type, collectionId],
  );
  return rows.map((row) => row.conversation_id);
}

export function getConversationCollections(
  db: SQLiteDatabase,
  conversationId: string,
): CollectionConversationRow[] {
  return db.getAllSync<CollectionConversationRow>(
    'SELECT * FROM collection_conversations WHERE conversation_id = ?',
    [conversationId],
  );
}

export function moveConversation(
  db: SQLiteDatabase,
  conversationId: string,
  fromType: 'project' | 'folder',
  fromId: string,
  toType: 'project' | 'folder',
  toId: string,
): void {
  db.withTransactionSync(() => {
    db.runSync(
      'DELETE FROM collection_conversations WHERE collection_type = ? AND collection_id = ? AND conversation_id = ?',
      [fromType, fromId, conversationId],
    );
    db.runSync(
      `INSERT OR IGNORE INTO collection_conversations (collection_type, collection_id, conversation_id, added_at)
       VALUES (?, ?, ?, ?)`,
      [toType, toId, conversationId, Date.now()],
    );
  });
}
