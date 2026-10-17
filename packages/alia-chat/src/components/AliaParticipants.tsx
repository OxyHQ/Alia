/**
 * The conversation's participants: Bloom's `AgentProfile` with `[lead, ...joined]`, and the
 * agents joining it (ADR 0020 §7).
 *
 * When the lead consults another agent (`alia.agent_start`), the agent's reply appears in the
 * thread under its own identity (anchor `reply:<agentId>`), and that avatar flies into the header
 * through Bloom's `useAvatarJoin`: one choreography for every multi-agent conversation, Bloom's
 * own `MultiAgentChat` included. The header gains the agent only when its flight lands; with
 * reduced motion, or when there is nothing to measure, it gains it at once. An agent already in
 * the conversation when the chat opens is simply there.
 *
 * This is the ONLY file that draws `AgentProfile` or joins agents to it (`one-thread.test.tsx`
 * holds it), so the header of the sheet, the screen and the Alia app are one header.
 */

import { AgentProfile } from '@oxy.so/bloom/agent-reply';
import { type AvatarFlights, useAvatarJoin } from '@oxy.so/bloom/avatar-flight';
import { memo, useMemo } from 'react';
import { ANCHORS, useAliaFlights } from '../lib/flights';
import {
  type AliaChatParticipants,
  type AliaLead,
  type AliaParticipant,
  consultedAgents,
} from '../lib/participants';
import type { Message } from '../runtime/types';

export interface UseParticipantsOptions {
  lead: AliaLead;
  messages: readonly Message[];
  /** The chat's flights; `null` draws everybody in place without flying. */
  flights: AvatarFlights | null;
}

const fromReply = (agent: AliaParticipant) => ANCHORS.reply(agent.id);
const characterOf = (agent: AliaParticipant) => agent.character;

/** Who the header shows: the lead, then the agents it consulted as each one's avatar lands. */
export function useParticipants({
  lead,
  messages,
  flights,
}: UseParticipantsOptions): AliaChatParticipants {
  const arrivals = useMemo(
    () =>
      consultedAgents(messages, lead.id).map(({ participant, live }) => ({
        agent: participant,
        live,
      })),
    [messages, lead.id],
  );
  const joined = useAvatarJoin({
    arrivals,
    flights,
    from: fromReply,
    to: ANCHORS.profile,
    character: characterOf,
    // A new lead is a new conversation: nobody has joined it.
    resetKey: lead.id,
  });
  return useMemo(() => ({ lead, joined: [...joined] }), [lead, joined]);
}

export interface AliaParticipantsProps {
  participants: AliaChatParticipants;
  /** Pressing the profile. Omitted, every avatar in it waves. */
  onPress?: () => void;
}

const noop = () => undefined;

/**
 * The header's participants: the lead's avatar above its name, joined by the agents it consulted
 * ("Alia + Sindi"). Place it in the chat's chrome; it is the conversation's title.
 */
export const AliaParticipants = memo(function AliaParticipants({
  participants,
  onPress,
}: AliaParticipantsProps) {
  const flights = useAliaFlights();
  const agents = useMemo(
    () =>
      [participants.lead, ...participants.joined].map((agent) => ({
        id: agent.id,
        name: agent.name,
        avatar: agent.character,
      })),
    [participants],
  );
  return (
    <AgentProfile
      agents={agents}
      onPress={onPress ?? noop}
      avatarRef={flights?.anchor(ANCHORS.profile)}
      avatarHidden={flights?.isLanding(ANCHORS.profile)}
    />
  );
});
