/**
 * What an agent was asked and what it answered, rebuilt from the thread alone.
 *
 * A consultation (`consultAgent`, ADR 0020 §5) is never a conversation of its own in storage. It
 * leaves two traces in the turn it happened in: the asker's reply carries the tool invocation (its
 * `args.task` is what was asked, its `result` the answer with the agent's identity), and the
 * consulted agent's own message (`agentInfo`) holds the answer. Both are already loaded with the
 * thread, so the internal exchange needs no request.
 *
 * Several consultations of one agent in a turn come out in the order they were made. A turn whose
 * task was not kept (an older message, a trimmed invocation) still yields the answers, with no
 * question.
 */
import { messageText } from '../../lib/content-utils';
import type { Message } from '../types';

/** The tool the lead consults with (`lib/tools/consult-agent.ts`). */
export const CONSULT_AGENT_TOOL = 'consultAgent';

/** An agent as a message carries it (`Message.agentInfo`). */
export type ExchangeAgent = NonNullable<Message['agentInfo']>;

export interface AgentExchangePair {
  /** Who asked: the agent whose reply held the call, or `null` for the conversation's own lead. */
  asker: ExchangeAgent | null;
  /** What was asked; `null` when the stored invocation has no task. */
  task: string | null;
  /** What the consulted agent answered. */
  answer: string;
}

export interface AgentExchange {
  /** The consulted agent. */
  agent: ExchangeAgent;
  pairs: AgentExchangePair[];
}

type ExchangeRow = Pick<Message, 'id' | 'role' | 'content' | 'toolInvocations' | 'agentInfo'>;

interface Consultation {
  asker: ExchangeAgent | null;
  task: string | null;
  response: string | null;
}

/**
 * The exchange between the conversation and the agent that speaks at `anchorId`, over the turn
 * (the rows between the questions of the person) that message is in. `null` when `anchorId` is
 * not a message of a consulted agent.
 */
export function agentExchange(
  rows: readonly ExchangeRow[],
  anchorId: string,
): AgentExchange | null {
  const anchorIndex = rows.findIndex((row) => row.id === anchorId);
  const agent = rows[anchorIndex]?.agentInfo;
  if (anchorIndex < 0 || !agent) return null;

  let start = anchorIndex;
  while (start > 0 && rows[start - 1]?.role !== 'user') start -= 1;
  let end = anchorIndex + 1;
  while (end < rows.length && rows[end]?.role !== 'user') end += 1;
  const turn = rows.slice(start, end);

  const consultations: Consultation[] = [];
  for (const row of turn) {
    for (const call of row.toolInvocations ?? []) {
      if (call.toolName !== CONSULT_AGENT_TOOL || call.state !== 'result') continue;
      const result = call.result;
      if (!result || typeof result !== 'object' || result.error || result.agentId !== agent.id) {
        continue;
      }
      const task = call.args?.task;
      consultations.push({
        asker: row.agentInfo ?? null,
        task: typeof task === 'string' && task.trim() !== '' ? task : null,
        response: typeof result.response === 'string' ? result.response : null,
      });
    }
  }
  const answers = turn.filter((row) => row.role === 'assistant' && row.agentInfo?.id === agent.id);

  const pairs: AgentExchangePair[] = [];
  for (let i = 0; i < Math.max(consultations.length, answers.length); i += 1) {
    const consultation = consultations[i];
    const stored = answers[i];
    const answer = stored ? messageText(stored) : (consultation?.response ?? '');
    if (answer === '' && !consultation?.task) continue;
    pairs.push({ asker: consultation?.asker ?? null, task: consultation?.task ?? null, answer });
  }
  return { agent, pairs };
}
