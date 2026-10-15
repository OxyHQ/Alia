import { describe, expect, it } from 'vitest';

import { flatConversations, groupHistory, sidebarSections } from '../sidebar-history';
import { type Conversation } from '@alia.onl/sdk/model';

/**
 * Where a chat sits in the sidebar's tree, and which day of History it is under.
 *
 * The days are the reader's own: "Yesterday" starts at local midnight, not 24
 * hours ago, so a chat from 23:50 last night is Yesterday at 00:10 today.
 */

const NOW = new Date(2026, 8, 21, 0, 10);

function chat(id: string, updatedAt: Date, agentId?: string | null): Conversation {
  return {
    id,
    title: id,
    createdAt: updatedAt,
    updatedAt,
    messages: [],
    ...(agentId === undefined ? {} : { agentId }),
  };
}

const ids = (rows: readonly { id: string }[]) => rows.map((row) => row.id);

describe('History by day', () => {
  it('buckets by local midnights, keeps the incoming order and leaves empty buckets out', () => {
    const rows = [
      chat('just-now', new Date(2026, 8, 21, 0, 5)),
      chat('last-night', new Date(2026, 8, 20, 23, 50)),
      chat('yesterday-morning', new Date(2026, 8, 20, 0, 0)),
      chat('two-days', new Date(2026, 8, 19, 23, 59)),
      chat('a-week', new Date(2026, 8, 14, 0, 0)),
      chat('eight-days', new Date(2026, 8, 13, 23, 59)),
    ];
    expect(groupHistory(rows, NOW).map((b) => [b.key, ids(b.items)])).toEqual([
      ['today', ['just-now']],
      ['yesterday', ['last-night', 'yesterday-morning']],
      ['previous7Days', ['two-days', 'a-week']],
      ['earlier', ['eight-days']],
    ]);
    expect(groupHistory([rows[5]!], NOW).map((b) => b.key)).toEqual(['earlier']);
    expect(groupHistory([], NOW)).toEqual([]);
  });
});

describe('the tree sections', () => {
  const today = new Date(2026, 8, 21, 0, 1);
  const conversations = [
    chat('plain', today, null),
    chat('pinned', today),
    chat('favorite', today),
    chat('both', today),
    chat('in-project', today),
    chat('in-folder', today),
    chat('folder-favorite', today),
    chat('with-agent', today, 'agent_pepe'),
  ];
  const sections = sidebarSections({
    conversations,
    projects: [{ id: 'project-1', conversationIds: ['in-project', 'in-folder-too'] }],
    folders: [{ id: 'folder-1', conversationIds: ['in-folder', 'folder-favorite', 'in-project'] }],
    pinnedIds: ['pinned', 'both', 'with-agent'],
    favoriteIds: ['favorite', 'both', 'folder-favorite'],
    now: NOW,
  });

  it('lists pinned chats under Pinned and favourites under Favorites, once each', () => {
    expect(ids(sections.pinned)).toEqual(['pinned', 'both']);
    expect(ids(sections.favorites)).toEqual(['favorite', 'folder-favorite']);
  });

  it('files a chat in its project before its folder, favourites first', () => {
    expect(ids(sections.projects[0]!.conversations)).toEqual(['in-project']);
    expect(ids(sections.folders[0]!.conversations)).toEqual(['folder-favorite', 'in-folder']);
  });

  it('keeps pinned, favourite, filed and agent chats out of History', () => {
    expect(sections.history.map((b) => [b.key, ids(b.items)])).toEqual([['today', ['plain']]]);
  });
});

describe('The flat list of chats', () => {
  const at = (hour: number) => new Date(2026, 8, 21, hour, 0);
  const rows = [
    chat('old', new Date(2026, 8, 1, 9, 0)),
    chat('new', at(9)),
    chat('pinned-old', new Date(2026, 7, 1, 9, 0)),
    chat('favourite', new Date(2026, 8, 5, 9, 0)),
    chat('in-project', at(8)),
    chat('in-folder', at(7)),
    chat('agent-thread', at(6), 'agent-1'),
  ];
  const flat = flatConversations({
    conversations: rows,
    projects: [{ conversationIds: ['in-project'] }],
    folders: [{ conversationIds: ['in-folder'] }],
    pinnedIds: ['pinned-old'],
    favoriteIds: ['favourite'],
  });

  it('is the chats filed nowhere: no project, no folder, no agent thread', () => {
    expect(ids(flat)).not.toContain('in-project');
    expect(ids(flat)).not.toContain('in-folder');
    expect(ids(flat)).not.toContain('agent-thread');
  });

  it('puts the pinned first, then the favourites, then the rest newest first', () => {
    expect(ids(flat)).toEqual(['pinned-old', 'favourite', 'new', 'old']);
  });

  it('does not reorder or mutate what it is given', () => {
    const before = ids(rows);
    flatConversations({
      conversations: rows,
      projects: [],
      folders: [],
      pinnedIds: [],
      favoriteIds: [],
    });
    expect(ids(rows)).toEqual(before);
  });
});
