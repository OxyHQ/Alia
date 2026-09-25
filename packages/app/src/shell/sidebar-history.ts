import type { Conversation } from '@/features/chat/runtime/use-conversations';

/**
 * What the sidebar's History lists: everything not already shown somewhere else.
 *
 * Two exclusions, for the same reason. A conversation inside a project is listed
 * under its project. A conversation with an agent is one stretch of that agent's
 * THREAD, listed once by the agent above — without that, an agent somebody has
 * talked to five times puts five rows in History beside its single row in
 * Agents, which is the shape the permanent thread exists to replace.
 *
 * `agentId` is checked for a usable VALUE rather than against `undefined`: the
 * wire carries an explicit `null` for every ordinary conversation, so comparing
 * to `undefined` keeps all of them and hides none — and comparing to `null`
 * alone would drop the ones restored from local storage, which have neither.
 */
export function conversationsForHistory(
  conversations: readonly Conversation[],
  projects: readonly { readonly conversationIds: readonly string[] }[],
): Conversation[] {
  return conversations.filter((conversation) =>
    !conversation.agentId
    && !projects.some((project) => project.conversationIds.includes(conversation.id))
  );
}

/** The primary sidebar rows that are routes, keyed by the first path segment they own. */
const ROUTE_ITEMS = ['agents', 'library', 'tasks', 'automations', 'skills', 'shows', 'notifications'] as const;

/**
 * The sidebar's selected primary row for a pathname: its first segment, when
 * that is one of the rows (`/agents/abc` selects Agents). A chat is selected
 * through the tree instead, and every other route selects nothing.
 */
export function selectedItemForPath(pathname: string): string | undefined {
  const first = pathname.split('/').filter(Boolean)[0];
  return first !== undefined && (ROUTE_ITEMS as readonly string[]).includes(first) ? first : undefined;
}

/** History's date buckets, newest first; each is also its `sidebar.*` label key. */
export const HISTORY_BUCKETS = ['today', 'yesterday', 'previous7Days', 'earlier'] as const;
export type HistoryBucket = (typeof HISTORY_BUCKETS)[number];

/**
 * History split into Today / Yesterday / Previous 7 days / Earlier, by the
 * reader's LOCAL midnights rather than 24-hour windows (so a DST day is still
 * one day), keeping the incoming order inside each bucket. Empty buckets are
 * left out.
 */
export function groupHistory<T extends { readonly updatedAt: Date }>(
  rows: readonly T[],
  now: Date = new Date(),
): { key: HistoryBucket; items: T[] }[] {
  const midnight = (daysAgo: number) =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo).getTime();
  const [today, yesterday, weekAgo] = [midnight(0), midnight(1), midnight(7)];
  const buckets = HISTORY_BUCKETS.map((key) => ({ key, items: [] as T[] }));
  for (const row of rows) {
    const time = row.updatedAt.getTime();
    const index = time >= today ? 0 : time >= yesterday ? 1 : time >= weekAgo ? 2 : 3;
    buckets[index]!.items.push(row);
  }
  return buckets.filter((bucket) => bucket.items.length > 0);
}

interface Filed {
  readonly id: string;
  readonly conversationIds: readonly string[];
}

export interface SidebarSections<P extends Filed, F extends Filed> {
  pinned: Conversation[];
  favorites: Conversation[];
  projects: { project: P; conversations: Conversation[] }[];
  folders: { folder: F; conversations: Conversation[] }[];
  history: { key: HistoryBucket; items: Conversation[] }[];
}

/**
 * Where each chat sits in the sidebar's tree.
 *
 * A chat is FILED in at most one place: its project, else its folder, else the
 * dated History. Pinned and Favorites are shortcuts on top of that: they list a
 * chat without taking it out of its project or folder, but they do take it out
 * of History — the same row twice in the same undifferentiated list is noise.
 * A chat both pinned and favourite is listed under Pinned only.
 *
 * Agent conversations stay out of all of it (see `conversationsForHistory`);
 * the agent's own row stands for them. Inside a project or folder, favourites
 * come first and recency decides the rest.
 */
export function sidebarSections<P extends Filed, F extends Filed>({
  conversations,
  projects,
  folders,
  pinnedIds,
  favoriteIds,
  now,
}: {
  conversations: readonly Conversation[];
  projects: readonly P[];
  folders: readonly F[];
  pinnedIds: readonly string[];
  favoriteIds: readonly string[];
  now?: Date;
}): SidebarSections<P, F> {
  const pinned = new Set(pinnedIds);
  const favorite = new Set(favoriteIds);
  const favoritesFirst = (rows: Conversation[]) =>
    rows.sort((a, b) => Number(favorite.has(b.id)) - Number(favorite.has(a.id)));
  const ownChats = conversations.filter((conversation) => !conversation.agentId);
  const unfiled = conversationsForHistory(conversations, projects);
  const inFolder = new Set(folders.flatMap((folder) => folder.conversationIds));

  return {
    pinned: ownChats.filter((c) => pinned.has(c.id)),
    favorites: ownChats.filter((c) => favorite.has(c.id) && !pinned.has(c.id)),
    projects: projects.map((project) => ({
      project,
      conversations: favoritesFirst(conversations.filter((c) => project.conversationIds.includes(c.id))),
    })),
    folders: folders.map((folder) => ({
      folder,
      conversations: favoritesFirst(unfiled.filter((c) => folder.conversationIds.includes(c.id))),
    })),
    history: groupHistory(
      unfiled.filter((c) => !inFolder.has(c.id) && !pinned.has(c.id) && !favorite.has(c.id)),
      now,
    ),
  };
}
