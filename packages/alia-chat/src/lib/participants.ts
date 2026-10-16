import type { AvatarCharacter } from '@oxy.so/bloom/agent-avatar';
import type { AliaAgentProfile } from '../runtime/agents';
import type { Message } from '../runtime/types';
import { readAgentCharacter } from './agent-character';
import { ALIA_AVATAR } from './alia-character';

/** Somebody in the conversation who answers: its lead, or an agent the lead consulted. */
export interface AliaParticipant {
  id: string;
  name: string;
  handle?: string;
  /** The 3D character it is drawn as. */
  character: AvatarCharacter;
  color?: string;
}

/** The conversation's lead: who greets, whose name is on the composer, who the header shows first. */
export interface AliaLead extends AliaParticipant {
  /** Alia herself, rather than an agent the chat was opened on. */
  isAlia: boolean;
  /** The agent's own greeting; Alia greets with the chat's labels. */
  greeting?: string;
  /** The agent's own starters, offered over the composer of an empty chat. */
  starters: Array<{ title: string; prompt: string }>;
}

/** Who is in the conversation, as the header draws it: the lead, then whoever has joined. */
export interface AliaChatParticipants {
  lead: AliaLead;
  /** The consulted agents that have joined the header, in the order they joined. */
  joined: AliaParticipant[];
}

/** Alia as a lead. */
export const ALIA_LEAD: AliaLead = {
  id: 'alia',
  name: 'Alia',
  handle: 'alia',
  character: ALIA_AVATAR,
  isAlia: true,
  starters: [],
};

/** The lead of a chat: the agent it was opened on (`agent={{ id }}`), or Alia. */
export function leadOf(profile: AliaAgentProfile | null | undefined): AliaLead {
  if (!profile) return ALIA_LEAD;
  return {
    id: profile.id,
    name: profile.name,
    handle: profile.handle,
    character: readAgentCharacter(profile.character),
    color: profile.color,
    isAlia: false,
    greeting: profile.greeting,
    starters: profile.starters,
  };
}

/** A consulted agent as a message carries it (`agentInfo`). */
export function participantOf(agentInfo: NonNullable<Message['agentInfo']>): AliaParticipant {
  return {
    id: agentInfo.id,
    name: agentInfo.name,
    handle: agentInfo.handle,
    character: readAgentCharacter(agentInfo.character),
    color: agentInfo.color,
  };
}

/**
 * The agents that answered in `messages`, besides the lead, in the order they first did — each
 * with whether its first answer is the one being streamed now (it is joining) or one already
 * written (it was there when the chat opened).
 */
export function consultedAgents(
  messages: readonly Message[],
  leadId: string,
): Array<{ participant: AliaParticipant; live: boolean }> {
  const seen = new Map<string, { participant: AliaParticipant; live: boolean }>();
  for (const message of messages) {
    const info = message.agentInfo;
    if (!info || info.id === leadId || seen.has(info.id)) continue;
    seen.set(info.id, { participant: participantOf(info), live: message.isStreaming === true });
  }
  return [...seen.values()];
}
