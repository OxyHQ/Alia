/**
 * One turn of a GROUP conversation: the person says something and every member answers, in the
 * order the group lists them, each seeing what the members before it said.
 *
 * It is the same act as `consultAgent` (a nested, streamed, paid-for agent turn, Alia ADR 0020 §5)
 * run once per member, so a group draws on the surfaces that already draw a consulted agent: each
 * member's reply streams as `alia.agent_start`, `agent_delta`, `agent_tool` and `agent_end`
 * (`docs/agent-embedding.md` §4) and is stored as a message carrying that agent's identity.
 * There is no lead: nobody answers for the group, so no reply of Alia's is written.
 *
 * ## The request's time is shared
 *
 * The chat request is cut at 80 seconds (`routes/v1/chat-completions.ts`) and a member's own turn
 * allows 45. Run one after another, six members could not all fit, so each is given what is left
 * of a {@link GROUP_BUDGET_MS} budget divided over the members still to answer, never more than
 * its own limit. A member the budget cannot cover is reported failed, not silently dropped: the
 * person sees who did not answer and can ask again.
 *
 * ## One member failing does not end the turn
 *
 * A refusal (credits, a gate), a timeout or an unreachable agent ends THAT member's reply with
 * `alia.agent_end` `failed` and the next member answers. Nothing of a failed reply is stored.
 */

import { randomUUID } from 'node:crypto';
import { findAgentById } from '../../db/agents/agentRepository.js';
import type { AgentInfo } from '../../domain/conversation.js';
import { canReachAgent } from '../agent-account.js';
import { agentPromptName, attachAgentIdentity } from '../agent-identity.js';
import { getErrorMessage } from '../errors/index.js';
import { log } from '../logger.js';
import type { SSEEmitter } from '../sse-emitter.js';
import {
  AGENT_TIMEOUT_MS,
  type AgentTurnMessage,
  type AgentTurnPerson,
  runAgentTurn,
} from '../tools/agent-turn.js';

/** The share of a request's 80 seconds a group may use, leaving the rest to end the stream. */
export const GROUP_BUDGET_MS = 70_000;
/** Under this a member is not started: it could not finish a useful answer. */
const MIN_MEMBER_MS = 5_000;
/** How much of the conversation a member reads: enough to follow it, bounded for cost. */
const HISTORY_MESSAGES = 24;
const HISTORY_CHARS = 4_000;

/** A message as the request carries it: text, or parts of which the text ones count. */
export interface GroupInputMessage {
  readonly id?: string;
  readonly role: string;
  readonly content?: unknown;
  readonly agentInfo?: { readonly name: string } | null;
}

/** The words of a message's content: a string as it is, else its text parts joined. */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((part: unknown) =>
      typeof part === 'object' &&
      part !== null &&
      (part as { type?: unknown }).type === 'text' &&
      typeof (part as { text?: unknown }).text === 'string'
        ? [(part as { text: string }).text]
        : [],
    )
    .join('\n');
}

/** What the person just said: the last user message, or nothing. */
export function lastUserText(messages: readonly GroupInputMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === 'user') return textOf(message.content).trim();
  }
  return '';
}

/**
 * What a member reads before the person's last message: the earlier turns, oldest first. A member's
 * reply is attributed by name (`Nadia: …`) so each agent knows who said what in a conversation with
 * several of them; the person's messages and any lead-less reply are as they were.
 */
export function historyForMembers(messages: readonly GroupInputMessage[]): AgentTurnMessage[] {
  const lastUser = messages.map((m) => m.role).lastIndexOf('user');
  const earlier = lastUser === -1 ? messages : messages.slice(0, lastUser);
  return earlier
    .flatMap((message): AgentTurnMessage[] => {
      if (message.role !== 'user' && message.role !== 'assistant') return [];
      const text = textOf(message.content).trim().slice(0, HISTORY_CHARS);
      if (text === '') return [];
      const named =
        message.role === 'assistant' && message.agentInfo
          ? `${message.agentInfo.name}: ${text}`
          : text;
      return [{ role: message.role, content: named }];
    })
    .slice(-HISTORY_MESSAGES);
}

/**
 * What a member is asked: the person's message and, after the first member, what the members
 * before it already said, marked as theirs so it is not read as the person's own words.
 */
export function taskForMember(task: string, replies: readonly GroupReply[]): string {
  if (replies.length === 0) return task;
  const said = replies.map((reply) => `${reply.agentInfo.name}: ${reply.content}`).join('\n\n');
  return `${task}\n\n---\nOther agents in this group chat have already answered the person:\n\n${said}\n\nAnswer the person yourself, in your own voice. Add what is yours to add; do not repeat what they said.`;
}

/** How long the next member may take: its share of what the group budget has left, capped. */
export function memberTimeoutMs(input: {
  readonly startedAt: number;
  readonly now: number;
  readonly membersLeft: number;
}): number {
  const left = GROUP_BUDGET_MS - (input.now - input.startedAt);
  if (left < MIN_MEMBER_MS) return 0;
  return Math.min(AGENT_TIMEOUT_MS, Math.floor(left / Math.max(input.membersLeft, 1)));
}

/** A member's reply, as it is stored and streamed. */
export interface GroupReply {
  readonly role: 'assistant';
  readonly content: string;
  readonly agentInfo: AgentInfo;
}

export interface GroupTurnInput {
  readonly memberAgentIds: readonly string[];
  readonly person: AgentTurnPerson;
  /** The client's whole history, ending in the person's new message. */
  readonly messages: readonly GroupInputMessage[];
  readonly emitter: SSEEmitter;
  /** When the request began, to share its time between the members. */
  readonly startedAt: number;
  /** Stops the turn between members when the client has gone. */
  readonly signal?: AbortSignal;
}

/**
 * Run the turn. Resolves with the replies that completed, in the order they were given, which is the
 * order they are stored in.
 */
export async function runGroupTurn(input: GroupTurnInput): Promise<GroupReply[]> {
  const { person, emitter } = input;
  const task = lastUserText(input.messages);
  const history = historyForMembers(input.messages);
  const replies: GroupReply[] = [];
  const emit = (event: string, data: Record<string, unknown>) => {
    try {
      emitter.emit(event, { eventVersion: 1, ...data });
    } catch (error: unknown) {
      log.general.warn({ err: error, event }, 'Could not emit a group turn event');
    }
  };

  for (const [index, agentId] of input.memberAgentIds.entries()) {
    if (input.signal?.aborted) break;
    const consultId = randomUUID();
    try {
      const found = await findAgentById((await import('../../db/index.js')).getDb(), agentId);
      if (
        found === null ||
        (await canReachAgent(found, {
          oxyUserId: person.oxyUserId,
          accessToken: person.accessToken,
          surfaceApplicationId: person.surfaceApplicationId,
        })) !== 'reachable'
      ) {
        emit('alia.agent_end', {
          consultId,
          status: 'failed',
          error: { code: 'agent_unavailable' },
        });
        continue;
      }
      const agent = await attachAgentIdentity(found);
      const identity: AgentInfo = {
        id: agentId,
        name: agentPromptName(agent),
        color: agent.color,
        character: agent.character,
        handle: agent.handle ?? 'unknown',
      };
      emit('alia.agent_start', {
        consultId,
        agent: {
          id: identity.id,
          name: identity.name,
          handle: identity.handle,
          color: identity.color,
          character: identity.character,
        },
        task,
      });
      const timeoutMs = memberTimeoutMs({
        startedAt: input.startedAt,
        now: Date.now(),
        membersLeft: input.memberAgentIds.length - index,
      });
      if (timeoutMs === 0) {
        emit('alia.agent_end', { consultId, status: 'failed', error: { code: 'agent_timeout' } });
        continue;
      }
      const outcome = await runAgentTurn({
        agent,
        task: taskForMember(task, replies),
        history,
        timeoutMs,
        person,
        payerOxyUserId: person.oxyUserId,
        observer: {
          onTextDelta: (content) => emit('alia.agent_delta', { consultId, content }),
          onToolCall: ({ toolCallId, name, input: args }) =>
            emit('alia.agent_tool', { consultId, phase: 'call', toolCallId, name, input: args }),
          onToolResult: ({ toolCallId, name, output }) =>
            emit('alia.agent_tool', { consultId, phase: 'result', toolCallId, name, output }),
        },
      });
      if (outcome.error !== undefined || outcome.response.trim() === '') {
        emit('alia.agent_end', {
          consultId,
          status: 'failed',
          error: outcome.refusal
            ? { code: outcome.refusal.code, feature: outcome.refusal.feature }
            : { code: 'agent_unavailable' },
        });
        continue;
      }
      emit('alia.agent_end', { consultId, status: 'completed', content: outcome.response });
      replies.push({ role: 'assistant', content: outcome.response, agentInfo: identity });
    } catch (error: unknown) {
      log.general.error({ err: error, agentId }, 'A group member failed');
      emit('alia.agent_end', {
        consultId,
        status: 'failed',
        error: { code: 'agent_unavailable', message: getErrorMessage(error) },
      });
    }
  }
  return replies;
}
