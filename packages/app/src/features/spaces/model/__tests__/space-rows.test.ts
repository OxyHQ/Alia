import type { Agent } from '@/shared/contracts/agents';
import type { Space } from '@/shared/contracts/spaces';
import type { Conversation } from '@alia.onl/sdk/model';
import type { SidebarTreeItem } from '@oxy.so/bloom/sidebar';
import { describe, expect, it } from 'vitest';
import {
  agentsOutsideSpaces,
  buildSpaceSections,
  conversationsOutsideSpaces,
  planSpaces,
} from '../space-rows';

const agent = (id: string, name: string, spaceId?: string | null): Agent =>
  ({ _id: id, name, handle: name.toLowerCase(), spaceId }) as Agent;

const conversation = (id: string, over: Partial<Conversation> = {}): Conversation => ({
  id,
  title: id,
  createdAt: new Date(),
  updatedAt: new Date(),
  messages: [],
  ...over,
});

const space = (id: string, memberAgentIds: string[], name = `Space ${id}`): Space => ({
  id,
  name,
  instructions: '',
  conversationId: `room-${id}`,
  memberAgentIds,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});

const row = (key: string): SidebarTreeItem => ({ key, label: key });

function sections(
  spaces: Space[],
  agents: Agent[],
  over: { query?: string; closedIds?: string[]; conversations?: Conversation[] } = {},
) {
  return buildSpaceSections({
    plans: planSpaces(spaces, agents, over.conversations ?? []),
    query: over.query ?? '',
    closedIds: over.closedIds ?? [],
    onOpenChange: () => undefined,
    sectionActions: () => null,
    agentRow: (a) => row(`agent:${a._id}`),
    roomRow: ({ space: s }) => row(s.conversationId),
    addAgentsRow: (s) => row(`space-add:${s.id}`),
  });
}

const keys = (list: { items?: readonly SidebarTreeItem[] }[]) =>
  list.map((entry) => (entry.items ?? []).map((item) => item.key));

describe('who is outside every space', () => {
  it('keeps the agents in no space (null or absent) and drops the members', () => {
    const agents = [agent('a1', 'Pepe', 's1'), agent('a2', 'Ana', null), agent('a3', 'Luis')];
    expect(agentsOutsideSpaces(agents).map((a) => a._id)).toEqual(['a2', 'a3']);
  });

  it('drops a space’s room and leaves Alia’s chats, agent threads and groups untouched', () => {
    const all = [
      conversation('alia', { agentId: null, spaceId: null }),
      conversation('old'),
      conversation('thread', { agentId: 'a1' }),
      conversation('group', { memberAgentIds: ['a1', 'a2'], spaceId: null }),
      conversation('room-s1', { memberAgentIds: ['a1', 'a2'], spaceId: 's1' }),
    ];
    expect(conversationsOutsideSpaces(all).map((c) => c.id)).toEqual([
      'alia',
      'old',
      'thread',
      'group',
    ]);
  });
});

describe('the Spaces sections', () => {
  it('are none without spaces', () => {
    expect(sections([], [agent('a1', 'Pepe')])).toEqual([]);
  });

  it('make one section per space, collapsible: the room, then the members in the space’s order', () => {
    const result = sections(
      [space('s1', ['a2', 'a1'])],
      [agent('a1', 'Pepe', 's1'), agent('a2', 'Ana', 's1')],
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      key: 'space:s1',
      label: 'Space s1',
      collapsible: true,
      open: true,
    });
    // A section, never a folder: Bloom draws a section's rows with the agent's picture and last line,
    // and a folder's rows without them.
    expect(result[0]).not.toHaveProperty('folders');
    expect(keys(result)).toEqual([['room-s1', 'agent:a2', 'agent:a1']]);
  });

  it('have the room row only when the space has a member, and the add-agents row only when empty', () => {
    const result = sections([space('s1', []), space('s2', ['a1'])], [agent('a1', 'Pepe', 's2')]);
    expect(keys(result)).toEqual([['space-add:s1'], ['room-s2', 'agent:a1']]);
  });

  it('leave out a member id the person’s agent list lacks, without an add-agents row', () => {
    const result = sections([space('s1', ['gone', 'a1'])], [agent('a1', 'Pepe', 's1')]);
    expect(keys(result)).toEqual([['room-s1', 'agent:a1']]);
  });

  it('find the room’s conversation for its last line', () => {
    const room = conversation('room-s1', { spaceId: 's1', lastMessage: 'Listo' });
    const [plan] = planSpaces([space('s1', ['a1'])], [agent('a1', 'Pepe', 's1')], [room]);
    expect(plan?.room).toBe(room);
    expect(plan?.showRoom).toBe(true);
  });

  it('draw a closed space closed, and report the toggle with its id', () => {
    const toggled: Array<[string, boolean]> = [];
    const result = buildSpaceSections({
      plans: planSpaces([space('s1', ['a1']), space('s2', ['a1'])], [agent('a1', 'Pepe')], []),
      query: '',
      closedIds: ['s2'],
      onOpenChange: (id, open) => toggled.push([id, open]),
      sectionActions: () => null,
      agentRow: (a) => row(`agent:${a._id}`),
      roomRow: ({ space: s }) => row(s.conversationId),
      addAgentsRow: (s) => row(`space-add:${s.id}`),
    });
    expect(result.map((r) => r.open)).toEqual([true, false]);
    result[1]?.onOpenChange?.(true);
    expect(toggled).toEqual([['s2', true]]);
  });

  it('keep a space whose name matches the search whole, else only the members that match', () => {
    const agents = [agent('a1', 'Pepe', 's1'), agent('a2', 'Ana', 's1'), agent('a3', 'Luis', 's2')];
    const spaces = [space('s1', ['a1', 'a2'], 'Ventas'), space('s2', ['a3'], 'Soporte')];
    expect(keys(sections(spaces, agents, { query: 'vent' }))).toEqual([
      ['room-s1', 'agent:a1', 'agent:a2'],
    ]);
    expect(keys(sections(spaces, agents, { query: 'ana' }))).toEqual([['agent:a2']]);
    expect(sections(spaces, agents, { query: 'zzz' })).toEqual([]);
  });

  it('carry the space’s menu beside its name', () => {
    const menu = 'MENU';
    const result = buildSpaceSections({
      plans: planSpaces([space('s1', ['a1'])], [agent('a1', 'Pepe', 's1')], []),
      query: '',
      closedIds: [],
      onOpenChange: () => undefined,
      sectionActions: (s) => `${menu}:${s.id}`,
      agentRow: (a) => row(`agent:${a._id}`),
      roomRow: ({ space: s }) => row(s.conversationId),
      addAgentsRow: (s) => row(`space-add:${s.id}`),
    });
    expect(result[0]?.actions).toBe('MENU:s1');
  });
});
