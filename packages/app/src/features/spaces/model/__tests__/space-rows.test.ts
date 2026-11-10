import type { Agent } from '@/shared/contracts/agents';
import type { Space } from '@/shared/contracts/spaces';
import type { Conversation } from '@alia.onl/sdk/model';
import type { SidebarTreeItem } from '@oxy.so/bloom/sidebar';
import { describe, expect, it } from 'vitest';
import {
  agentsOutsideSpaces,
  buildSpacesSection,
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

function section(
  spaces: Space[],
  agents: Agent[],
  over: { query?: string; closedIds?: string[]; conversations?: Conversation[] } = {},
) {
  return buildSpacesSection({
    plans: planSpaces(spaces, agents, over.conversations ?? []),
    label: 'Spaces',
    query: over.query ?? '',
    closedIds: over.closedIds ?? [],
    onOpenChange: () => undefined,
    folderActions: () => null,
    agentRow: (a) => row(`agent:${a._id}`),
    roomRow: ({ space: s }) => row(s.conversationId),
    addAgentsRow: (s) => row(`space-add:${s.id}`),
  });
}

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

describe('the Spaces section', () => {
  it('is absent without spaces', () => {
    expect(section([], [agent('a1', 'Pepe')])).toBeUndefined();
  });

  it('makes one folder per space: the room, then the members in the space’s order', () => {
    const result = section(
      [space('s1', ['a2', 'a1'])],
      [agent('a1', 'Pepe', 's1'), agent('a2', 'Ana', 's1')],
    );
    expect(result).toMatchObject({ key: 'spaces', label: 'Spaces' });
    expect(result?.folders?.[0]).toMatchObject({ key: 'space:s1', label: 'Space s1', open: true });
    expect(result?.folders?.[0]?.items.map((i) => i.key)).toEqual([
      'room-s1',
      'agent:a2',
      'agent:a1',
    ]);
  });

  it('has the room row only when the space has a member, and the add-agents row only when empty', () => {
    const result = section([space('s1', []), space('s2', ['a1'])], [agent('a1', 'Pepe', 's2')]);
    const [empty, full] = result?.folders ?? [];
    expect(empty?.items.map((i) => i.key)).toEqual(['space-add:s1']);
    expect(full?.items.map((i) => i.key)).toEqual(['room-s2', 'agent:a1']);
  });

  it('leaves out a member id the person’s agent list lacks, without an add-agents row', () => {
    const result = section([space('s1', ['gone', 'a1'])], [agent('a1', 'Pepe', 's1')]);
    expect(result?.folders?.[0]?.items.map((i) => i.key)).toEqual(['room-s1', 'agent:a1']);
  });

  it('finds the room’s conversation for its last line', () => {
    const room = conversation('room-s1', { spaceId: 's1', lastMessage: 'Listo' });
    const [plan] = planSpaces([space('s1', ['a1'])], [agent('a1', 'Pepe', 's1')], [room]);
    expect(plan?.room).toBe(room);
    expect(plan?.showRoom).toBe(true);
  });

  it('draws a closed folder closed', () => {
    const result = section([space('s1', ['a1']), space('s2', ['a1'])], [agent('a1', 'Pepe')], {
      closedIds: ['s2'],
    });
    expect(result?.folders?.map((f) => f.open)).toEqual([true, false]);
  });

  it('keeps a folder whose name matches the search whole, else only the members that match', () => {
    const agents = [agent('a1', 'Pepe', 's1'), agent('a2', 'Ana', 's1'), agent('a3', 'Luis', 's2')];
    const spaces = [space('s1', ['a1', 'a2'], 'Ventas'), space('s2', ['a3'], 'Soporte')];
    expect(
      section(spaces, agents, { query: 'vent' })?.folders?.map((f) => f.items.map((i) => i.key)),
    ).toEqual([['room-s1', 'agent:a1', 'agent:a2']]);
    expect(
      section(spaces, agents, { query: 'ana' })?.folders?.map((f) => f.items.map((i) => i.key)),
    ).toEqual([['agent:a2']]);
    expect(section(spaces, agents, { query: 'zzz' })).toBeUndefined();
  });
});
