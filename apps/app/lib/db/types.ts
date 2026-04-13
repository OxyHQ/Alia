/** Row types matching the local SQLite schema. */

export interface ConversationRow {
  id: string;
  title: string;
  source: string;
  agent_id: string;
  last_message: string;
  is_favorite: number;
  is_pinned: number;
  created_at: number;
  updated_at: number;
  synced_at: number | null;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  thinking: string;
  /** JSON-serialized ToolInvocation[] */
  tool_invocations: string;
  source: string;
  speaker: string;
  /** JSON-serialized agent metadata */
  agent_info: string;
  audio_url: string;
  created_at: number;
}

export interface ProjectRow {
  id: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  is_expanded: number;
  created_at: number;
  updated_at: number;
}

export interface FolderRow {
  id: string;
  name: string;
  icon: string;
  color: string;
  is_favorite: number;
  is_expanded: number;
  created_at: number;
  updated_at: number;
}

export interface CollectionConversationRow {
  collection_type: 'project' | 'folder';
  collection_id: string;
  conversation_id: string;
  added_at: number;
}

export interface RoleRow {
  id: string;
  name: string;
  tagline: string;
  description: string;
  category: string;
  system_prompt: string;
  /** JSON-serialized role config */
  config: string;
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
  category: string;
  created_at: number;
  updated_at: number;
}

export interface PreferenceRow {
  key: string;
  /** JSON-serialized preference value */
  value: string;
}

export interface SyncQueueRow {
  id: number;
  entity_type: string;
  entity_id: string;
  action: string;
  /** JSON-serialized payload */
  payload: string;
  created_at: number;
  attempts: number;
}
