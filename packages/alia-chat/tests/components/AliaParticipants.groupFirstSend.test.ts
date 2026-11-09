import { describe, expect, it, vi } from 'vitest';

vi.mock('@oxy.so/bloom/agent-avatar', () => ({ parseAvatarCharacter: (value: unknown) => value }));
vi.mock('@oxy.so/bloom/agent-reply', () => ({ AgentProfile: () => null }));
vi.mock('@oxy.so/bloom/avatar-flight', () => ({
  useAvatarJoin: () => [],
  // Bloom's own: a merge into `route.to`, one per agent.
  avatarJoinFlights: (
    agents: Array<{ id: string }>,
    route: { from: (a: { id: string }) => string; to: string; character: (a: never) => unknown },
  ) =>
    agents.map((agent) => ({
      key: `join:${agent.id}`,
      character: route.character(agent as never),
      from: route.from(agent),
      to: route.to,
      merge: true,
    })),
}));

import { groupFirstSend } from '../../src/components/AliaParticipants';
import { ANCHORS } from '../../src/lib/flights';
import type { AliaParticipant } from '../../src/lib/participants';

const member = (id: string): AliaParticipant => ({
  id,
  name: id,
  character: { preset: id } as never,
});

describe('groupFirstSend', () => {
  it('lands the first member on its reply and merges the others into the header', () => {
    const [first, ...others] = groupFirstSend([member('a'), member('b'), member('c')]);
    expect(first).toMatchObject({ from: 'empty:a', to: ANCHORS.reply('a') });
    expect(others.map((flight) => [flight.from, flight.to, flight.merge])).toEqual([
      ['empty:b', ANCHORS.profile, true],
      ['empty:c', ANCHORS.profile, true],
    ]);
  });

  it('flies nothing for no members', () => {
    expect(groupFirstSend([])).toEqual([]);
  });
});
