import type React from 'react';
import { useMemo, useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A consulted agent joins the header by flying from its reply into the participants (ADR 0020 §7,
 * Bloom's multi-agent join). The header gains it only when the flight lands; with reduced motion
 * it gains it at once; an agent already in the conversation is simply there.
 */

const seen = vi.hoisted(() => ({
  profiles: [] as Array<{ agents: Array<{ id: string }>; avatarHidden?: boolean }>,
}));

vi.mock('@oxy.so/bloom/agent-reply', () => ({
  AgentProfile: (props: { agents: Array<{ id: string }>; avatarHidden?: boolean }) => {
    seen.profiles.push(props);
    return null;
  },
}));
vi.mock('@oxy.so/bloom/avatar-flight', () => ({
  centeredLanding: (size: number) => `centered(${size})`,
}));
vi.mock('../../src/lib/agent-character', () => ({ readAgentCharacter: (value: unknown) => value }));
vi.mock('../../src/lib/alia-character', () => ({ ALIA_AVATAR: { preset: 'alia' } }));

import type { AvatarFlights, AvatarFlightSpec } from '@oxy.so/bloom/avatar-flight';
import { AliaParticipants, useParticipants } from '../../src/components/AliaParticipants';
import { AliaFlightsProvider } from '../../src/lib/flights';
import { ALIA_LEAD, type AliaChatParticipants } from '../../src/lib/participants';
import type { Message } from '../../src/runtime/types';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** Bloom's controller, as far as the participants read it: what is in the air, and where to. */
const world = {
  reduced: false,
  launches: [] as AvatarFlightSpec[][],
  land: () => {},
  participants: null as AliaChatParticipants | null,
};

function useFakeFlights(): AvatarFlights {
  const [flying, setFlying] = useState<AvatarFlightSpec[]>([]);
  world.land = () => setFlying([]);
  return useMemo(
    () =>
      ({
        anchor: () => () => undefined,
        snapshot: () => () => undefined,
        launch: async (specs: readonly AvatarFlightSpec[]) => {
          world.launches.push([...specs]);
          if (world.reduced || specs.length === 0) return false;
          setFlying([...specs]);
          return true;
        },
        cancel: () => setFlying([]),
        isLeaving: (key: string) => flying.some((spec) => spec.from === key),
        isLanding: (key: string) => flying.some((spec) => spec.to === key),
        layer: {} as AvatarFlights['layer'],
      }) as AvatarFlights,
    [flying],
  );
}

function Chat({ messages }: { messages: Message[] }) {
  const flights = useFakeFlights();
  const participants = useParticipants({ lead: ALIA_LEAD, messages, flights });
  world.participants = participants;
  return (
    <AliaFlightsProvider value={flights}>
      <AliaParticipants participants={participants} />
    </AliaFlightsProvider>
  );
}

const agentMessage = (id: string, isStreaming: boolean): Message => ({
  id: `m-${id}`,
  role: 'assistant',
  content: '',
  agentInfo: { id, name: id.toUpperCase(), character: { color: id } },
  ...(isStreaming ? { isStreaming: true } : {}),
});
const question: Message = { id: 'u', role: 'user', content: 'hola' };
const reply: Message = { id: 'r', role: 'assistant', content: '', isStreaming: true };

let renderer: ReactTestRenderer | null = null;
async function render(messages: Message[]) {
  await act(async () => {
    if (renderer === null) renderer = create(<Chat messages={messages} />);
    else renderer.update(<Chat messages={messages} />);
  });
}
/** Two frames: the reply carrying the avatar lays out before it is measured. */
const afterLayout = () => act(async () => new Promise((resolve) => setTimeout(resolve, 60)));
const header = () => world.participants?.joined.map((agent) => agent.id);
const drawn = () => seen.profiles.at(-1)?.agents.map((agent) => agent.id);

beforeEach(() => {
  world.reduced = false;
  world.launches = [];
  world.participants = null;
  seen.profiles = [];
});
afterEach(async () => {
  if (renderer !== null) await act(async () => renderer?.unmount());
  renderer = null;
});

describe('an agent joining the conversation', () => {
  it('flies from its reply into the participants, and joins the header when it lands', async () => {
    await render([question, reply]);
    await render([question, agentMessage('sindi', true), reply]);
    await afterLayout();

    expect(world.launches).toEqual([
      [
        {
          key: 'join:sindi',
          character: { color: 'sindi' },
          from: 'reply:sindi',
          to: 'participants',
          landing: 'centered(14)',
          duration: 950,
          delay: 0,
          merge: true,
        },
      ],
    ]);
    // In the air: the header has not gained it, and hides its artwork while it lands.
    expect(header()).toEqual([]);
    expect(drawn()).toEqual(['alia']);
    expect(seen.profiles.at(-1)?.avatarHidden).toBe(true);

    await act(async () => world.land());
    expect(header()).toEqual(['sindi']);
    expect(drawn()).toEqual(['alia', 'sindi']);
    expect(seen.profiles.at(-1)?.avatarHidden).toBe(false);
  });

  it('staggers several that join together, in one batch', async () => {
    await render([question, reply]);
    await render([question, agentMessage('sindi', true), agentMessage('lumi', true), reply]);
    await afterLayout();

    expect(world.launches).toHaveLength(1);
    expect(world.launches[0]?.map((spec) => [spec.from, spec.delay])).toEqual([
      ['reply:sindi', 0],
      ['reply:lumi', 120],
    ]);
    await act(async () => world.land());
    expect(header()).toEqual(['sindi', 'lumi']);
  });

  it('waits for a flight in the air before the next one takes off', async () => {
    await render([question, agentMessage('sindi', true), reply]);
    await afterLayout();
    await render([question, agentMessage('sindi', true), agentMessage('lumi', true), reply]);
    await afterLayout();
    expect(world.launches).toHaveLength(1);

    await act(async () => world.land());
    await afterLayout();
    expect(header()).toEqual(['sindi']);
    expect(world.launches[1]?.map((spec) => spec.key)).toEqual(['join:lumi']);
    await act(async () => world.land());
    expect(header()).toEqual(['sindi', 'lumi']);
  });

  it('joins at once with reduced motion', async () => {
    world.reduced = true;
    await render([question, reply]);
    await render([question, agentMessage('sindi', true), reply]);
    await afterLayout();

    expect(header()).toEqual(['sindi']);
  });

  it('is simply there when it answered before the chat opened', async () => {
    await render([question, agentMessage('sindi', false), { ...reply, isStreaming: false }]);

    expect(world.launches).toEqual([]);
    expect(header()).toEqual(['sindi']);
    expect(drawn()).toEqual(['alia', 'sindi']);
  });
});

// The header draws whoever leads, too.
describe('AliaParticipants', () => {
  it('draws the lead first', async () => {
    const lead = { ...ALIA_LEAD, id: 'sindi', name: 'Sindi', isAlia: false };
    function Lead() {
      return <AliaParticipants participants={{ lead, joined: [] }} />;
    }
    await act(async () => {
      renderer = create((<Lead />) as React.ReactElement);
    });
    expect(drawn()).toEqual(['sindi']);
  });
});
