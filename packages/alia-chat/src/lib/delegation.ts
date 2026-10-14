import type { ToolInvocation } from '../types';

/** The tools that hand a question to another agent. */
const DELEGATION_TOOLS = new Set(['delegateToAgent', 'askAgent']);

export interface WorkingAgent {
  id: string;
  name: string;
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined;

/**
 * The agent a delegation call is for, from its arguments: an id (`agentId`) and a name
 * (`agentName`, or `agent` when it is a name). Whichever is missing falls back on the other, so
 * the placeholder and the answer that follows agree on who it is as long as the call names them.
 */
export function delegatedAgent(invocation: ToolInvocation): WorkingAgent | null {
  if (!DELEGATION_TOOLS.has(invocation.toolName)) return null;
  const args = invocation.args ?? {};
  const id = text(args.agentId) ?? text(args.agent_id) ?? text(args.agent) ?? text(args.name);
  const name = text(args.agentName) ?? text(args.agent) ?? text(args.name) ?? id;
  if (!id || !name) return null;
  return { id, name };
}

/**
 * The id of an agent's message in a turn. A delegation call creates it empty (the agent is
 * thinking) and the agent's answer fills the same message, so one element carries the avatar from
 * thinking to answered.
 */
export const agentMessageId = (assistantId: string, agentId: string) =>
  `${assistantId}-agent-${agentId}`;
