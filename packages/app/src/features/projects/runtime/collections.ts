/**
 * The person's folders, projects, pins and favourites, as the app's screens use them. They are the
 * account's (`@gemies/sdk/runtime` `useConversationCollections`, kept live by the realtime
 * connection), never the device's: what one device files, every other shows.
 */

import { toast } from '@oxy.so/bloom/toast';
import {
  type CollectionFields,
  type ConversationCollection,
  useCollectionActions,
  useConversationCollections,
} from '@gemies/sdk/runtime';
import { useMemo } from 'react';
import i18n from '@/shared/i18n';

export type Folder = ConversationCollection;
export type Project = ConversationCollection;

const FOLDER_ICONS = ['Folder', 'FolderOpen', 'FolderClosed', 'Archive', 'Inbox', 'BookMarked'];
const PROJECT_ICONS = [
  'FolderOpen',
  'Briefcase',
  'Folder',
  'Package',
  'Rocket',
  'Target',
  'Lightbulb',
  'Star',
  'Heart',
  'Zap',
];
const COLORS = [
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
  '#f59e0b',
  '#10b981',
  '#06b6d4',
  '#f97316',
  '#ef4444',
];
const pick = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)] as T;

/** A change the server refused: said, and the server's state is already back on screen. */
function reported(change: Promise<void>): Promise<void> {
  return change.catch(() => {
    toast.error(i18n.t('sidebar.collectionsError'));
  });
}

export function useAccountCollections() {
  const { collections, pinned, favorites } = useConversationCollections();
  const actions = useCollectionActions();

  return useMemo(() => {
    const folders = collections.filter((c) => c.kind === 'folder');
    const projects = collections.filter((c) => c.kind === 'project');
    const toggleExpanded = (id: string) => {
      const item = collections.find((c) => c.id === id);
      return item
        ? reported(actions.updateCollection(id, { isExpanded: !item.isExpanded }))
        : Promise.resolve();
    };
    return {
      folders,
      projects,
      pinnedIds: pinned,
      favoriteIds: favorites,
      togglePin: (id: string) => reported(actions.setPinned(id, !pinned.includes(id))),
      toggleFavorite: (id: string) => reported(actions.setFavorite(id, !favorites.includes(id))),
      createFolder: (name: string, icon?: string) =>
        reported(
          actions.createCollection('folder', {
            name,
            icon: icon ?? pick(FOLDER_ICONS),
            color: pick(COLORS),
          }),
        ),
      updateFolder: (id: string, updates: CollectionFields) =>
        reported(actions.updateCollection(id, updates)),
      deleteFolder: (id: string) => reported(actions.deleteCollection(id)),
      toggleFolder: toggleExpanded,
      addConversationToFolder: (id: string, conversationId: string) =>
        reported(actions.addToCollection(id, conversationId)),
      removeConversationFromFolder: (id: string, conversationId: string) =>
        reported(actions.removeFromCollection(id, conversationId)),
      createProject: (name: string, description?: string, icon?: string, color?: string) =>
        reported(
          actions.createCollection('project', {
            name,
            description: description ?? null,
            icon: icon ?? pick(PROJECT_ICONS),
            color: color ?? pick(COLORS),
          }),
        ),
      updateProject: (id: string, updates: CollectionFields) =>
        reported(actions.updateCollection(id, updates)),
      deleteProject: (id: string) => reported(actions.deleteCollection(id)),
      toggleProject: toggleExpanded,
      addConversationToProject: (id: string, conversationId: string) =>
        reported(actions.addToCollection(id, conversationId)),
      removeConversationFromProject: (id: string, conversationId: string) =>
        reported(actions.removeFromCollection(id, conversationId)),
    };
  }, [collections, pinned, favorites, actions]);
}
