import type { ChatMessage, ToolInvocation } from '../types';

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

/** The agents still working on a delegation of this message: called, not yet answered. */
export function workingAgents(message: ChatMessage | undefined): WorkingAgent[] {
  const working = new Map<string, WorkingAgent>();
  for (const invocation of message?.toolInvocations ?? []) {
    if (invocation.state === 'result') continue;
    const agent = delegatedAgent(invocation);
    if (agent) working.set(agent.id, agent);
  }
  return [...working.values()];
}
