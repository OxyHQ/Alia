/**
 * What an autonomous run says to the model: the system prompt (the agent's
 * remit plus the run protocol) and each iteration's context messages (event
 * stream window, plan and state at the tail, a varied continuation prompt).
 * Pure builders; the loop that calls them is `runner.ts`.
 */
import type { ModelMessage } from 'ai';
import type { AgentSessionConfig } from '../../db/agents/agentSessionRepository.js';
import { EVENT_STREAM_BUDGET } from '../constants.js';
import type { HydratedAgent } from '../agent-identity.js';
import { agentRemitPrompt } from './archetype-prompts.js';
import type { EventStream } from './event-stream.js';
import type { AgentStateMachine } from './state-machine.js';
import type { TodoManager } from './todo-manager.js';

/** Continuation prompts — varied to prevent brittle pattern mimicry */
const CONTINUATION_PROMPTS = [
  'Continue working on the task.',
  'What is your next step?',
  'Proceed with the plan.',
  'Continue executing your plan.',
];

// ── System Prompt Builder ──

/**
 * The agent's remit, plus the PROTOCOL of an autonomous run.
 *
 * ## The remit chain moved out, and the protocol stopped being conditional
 *
 * This function used to answer `systemPrompt ?? archetype ?? listing` itself
 * and RETURN EARLY on the first two — so an agent whose owner had written a
 * prompt was never told that `plan` exists, that it must call
 * `plan(action='complete')` to finish, or how many steps it had. The sections
 * below are not a fallback description; they are how a session works, and they
 * are as true of a custom-prompt agent as of any other.
 *
 * What describes the agent is {@link agentRemitPrompt}, shared with the chat,
 * voice and agent-bot surfaces so the four cannot drift. It also stopped
 * opening `You are ${name}.` — the identity guard prepended above this says
 * exactly that, and one fact wants one owner.
 *
 * No `## Actions` list either: the tool schema already describes every tool the
 * agent was handed, and nothing else, so a prose copy could only repeat it or
 * promise one that was withheld. Memory is last in the message because it is the
 * only part that changes between runs.
 *
 * No `## Capabilities` section. It listed `agent.capabilities` — the eight
 * decorative tool ids the generator wrote — so what the model read was
 * `web-browsing, memory` while the actual tool set was decided somewhere
 * else entirely and could contradict it in either direction. What the agent
 * can do is the tools it was handed, each with its own description.
 */
export function buildSystemPrompt(
  agent: HydratedAgent,
  config: AgentSessionConfig,
  spaceSection = '',
): string {
  return `${agentRemitPrompt(agent)}${spaceSection}

## How to Work
- Multi-step task: create a plan with the plan action, execute it step by step, update it after each step. Simple question: respond directly.
- When done, call plan with action='complete' and your final result.
- When an action fails, analyze the error and adjust; don't repeat the same failed action.
- At most ${config.maxSteps} steps. Be efficient: act only when necessary.`;
}

// ── Context Builder (Manus KV-cache optimization) ──

export function buildContextMessages(
  eventStream: EventStream,
  todoManager: TodoManager,
  stateMachine: AgentStateMachine,
  iteration: number,
): ModelMessage[] {
  const messages: ModelMessage[] = [];

  // 1. The stable system prompt (never changes — KV-cache friendly) is not a
  // message: it leaves as the SDK's `system` option at the call site.

  // 2. Event stream as conversation history
  const recentEvents = eventStream.getRecentWindow(EVENT_STREAM_BUDGET);
  const serialized = eventStream.serialize(recentEvents);

  if (serialized) {
    messages.push({ role: 'user', content: serialized });
  }

  // 3. Context tail: todo + state instructions (Manus attention manipulation)
  const tailParts: string[] = [];

  const todoSerialized = todoManager.serialize();
  if (todoSerialized) {
    tailParts.push(`## Current Plan\n${todoSerialized}`);
  }

  const stateInstruction = stateMachine.getStateInstruction();
  if (stateInstruction) {
    tailParts.push(stateInstruction);
  }

  // 4. Continuation prompt with diversity (includes context tail for attention manipulation)
  const continuationPrompt = CONTINUATION_PROMPTS[iteration % CONTINUATION_PROMPTS.length];
  const tailContent = tailParts.length > 0 ? tailParts.join('\n\n') + '\n\n' : '';

  messages.push({ role: 'user', content: tailContent + continuationPrompt });

  return messages;
}
