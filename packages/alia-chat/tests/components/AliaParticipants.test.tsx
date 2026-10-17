import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The header's participants: the lead, then the agents it consulted, joined through Bloom's
 * `useAvatarJoin` (ADR 0020 §7). The choreography itself — flying in, one batch at a time, joining
 * as it lands — is Bloom's and is tested there (`avatar-flight/__tests__/use-avatar-join.test.tsx`).
 * What is the SDK's is the wiring: who arrives, from which anchor, into which, and when a
 * conversation starts over.
 */

interface JoinOptions {
  arrivals: Array<{ agent: { id: string; character: unknown }; live: boolean }>;
  flights: unknown;
  from: (agent: { id: string }) => string;
  to: string;
  character: (agent: { character: unknown }) => unknown;
  resetKey?: string | number;
}

const seen = vi.hoisted(() => ({
  profiles: [] as Array<{ agents: Array<{ id: string }>; avatarHidden?: boolean }>,
  joins: [] as JoinOptions[],
}));

vi.mock('@oxy.so/bloom/agent-reply', () => ({
  AgentProfile: (props: { agents: Array<{ id: string }>; avatarHidden?: boolean }) => {
    seen.profiles.push(props);
    return null;
  },
}));
vi.mock('@oxy.so/bloom/avatar-flight', () => ({
  useAvatarJoin: (options: JoinOptions) => {
    seen.joins.push(options);
    return options.arrivals.map((arrival) => arrival.agent);
  },
}));
vi.mock('../../src/lib/agent-character', () => ({ readAgentCharacter: (value: unknown) => value }));
vi.mock('../../src/lib/alia-character', () => ({ ALIA_AVATAR: { preset: 'alia' } }));

import { AliaParticipants, useParticipants } from '../../src/components/AliaParticipants';
import { ALIA_LEAD, type AliaChatParticipants, type AliaLead } from '../../src/lib/participants';
import type { Message } from '../../src/runtime/types';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const FLIGHTS = { flights: true };
let participants: AliaChatParticipants | null = null;

function Chat({ messages, lead = ALIA_LEAD }: { messages: Message[]; lead?: AliaLead }) {
  participants = useParticipants({ lead, messages, flights: FLIGHTS as never });
  return <AliaParticipants participants={participants} />;
}

const agentMessage = (id: string, isStreaming: boolean): Message => ({
  id: `m-${id}`,
  role: 'assistant',
  content: '',
  agentInfo: { id, name: id.toUpperCase(), character: { color: id } },
  ...(isStreaming ? { isStreaming: true } : {}),
});
const question: Message = { id: 'u', role: 'user', content: 'hola' };

let renderer: ReactTestRenderer | null = null;
async function render(element: React.ReactElement) {
  await act(async () => {
    if (renderer === null) renderer = create(element);
    else renderer.update(element);
  });
}
const lastJoin = () => seen.joins.at(-1);
const drawn = () => seen.profiles.at(-1)?.agents.map((agent) => agent.id);

beforeEach(() => {
  seen.profiles = [];
  seen.joins = [];
  participants = null;
});
afterEach(async () => {
  if (renderer !== null) await act(async () => renderer?.unmount());
  renderer = null;
});

describe('the participants', () => {
  it('join each consulted agent from its reply into the header, live while it is answering', async () => {
    await render(
      <Chat messages={[question, agentMessage('lumi', false), agentMessage('sindi', true)]} />,
    );

    const join = lastJoin();
    expect(join?.arrivals.map(({ agent, live }) => [agent.id, live])).toEqual([
      ['lumi', false],
      ['sindi', true],
    ]);
    expect(join?.flights).toBe(FLIGHTS);
    expect(join?.from({ id: 'sindi' })).toBe('reply:sindi');
    expect(join?.to).toBe('participants');
    expect(join?.character({ character: { color: 'sindi' } })).toEqual({ color: 'sindi' });
    expect(participants?.joined.map((agent) => agent.id)).toEqual(['lumi', 'sindi']);
    expect(drawn()).toEqual(['alia', 'lumi', 'sindi']);
  });

  it('start over when the conversation has a new lead', async () => {
    await render(<Chat messages={[question]} />);
    expect(lastJoin()?.resetKey).toBe('alia');
    const sindi = { ...ALIA_LEAD, id: 'sindi', name: 'Sindi', isAlia: false };
    await render(<Chat messages={[question]} lead={sindi} />);
    expect(lastJoin()?.resetKey).toBe('sindi');
  });

  it('never count the lead as joining its own conversation', async () => {
    await render(<Chat messages={[question, agentMessage('alia', true)]} />);
    expect(lastJoin()?.arrivals).toEqual([]);
  });
});

describe('AliaParticipants', () => {
  it('draws the lead first', async () => {
    const lead = { ...ALIA_LEAD, id: 'sindi', name: 'Sindi', isAlia: false };
    await render(<AliaParticipants participants={{ lead, joined: [] }} />);
    expect(drawn()).toEqual(['sindi']);
  });
});
