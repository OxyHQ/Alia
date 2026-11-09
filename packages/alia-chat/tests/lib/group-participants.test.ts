import { describe, expect, it, vi } from 'vitest';

vi.mock('@oxy.so/bloom/agent-avatar', () => ({ parseAvatarCharacter: (value: unknown) => value }));

import { ALIA_LEAD, type AliaParticipant, groupParticipants } from '../../src/lib/participants';

const member = (id: string): AliaParticipant => ({
  id,
  name: id,
  character: { preset: 'blue_beret' } as never,
});

describe('groupParticipants', () => {
  it('stands the first member in as the lead and lists the rest as already joined', () => {
    const { lead, joined } = groupParticipants([member('a'), member('b'), member('c')]);
    expect(lead).toMatchObject({ id: 'a', isAlia: false, starters: [] });
    expect(joined.map((m) => m.id)).toEqual(['b', 'c']);
  });

  it('is Alia alone for no members', () => {
    expect(groupParticipants([])).toEqual({ lead: ALIA_LEAD, joined: [] });
  });
});
