import { getDb } from '../../db/index.js';
import { findExternalLink } from '../../db/agents/externalAgentRepository.js';
import { log } from '../logger.js';

export interface ExternalTurnResult {
  response: string;
  tokensUsed: number;
  creditsCharged: number;
  error?: string;
}

/** True when `agentId` is served by a person's daemon rather than by Alia's models. */
export async function isExternalAgent(agentId: string): Promise<boolean> {
  return (await findExternalLink(getDb(), agentId)) !== undefined;
}

/**
 * One turn of an external agent, in the shape `runAgentTurn` returns.
 *
 * Nothing is billed: the model runs on the person's own subscription, on their machine. A failure
 * is a VALUE with words the calling model (or the room) can relay, never a throw, exactly like a
 * nested turn of an ordinary agent.
 */
export async function runExternalAgentTurn(input: {
  agentId: string;
  task: string;
  history?: readonly { role: 'user' | 'assistant'; content: string }[];
  threadKey?: string;
  onTextDelta?: (text: string) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<ExternalTurnResult> {
  // Loaded on first use: the relay pulls the Oxy socket verifier in at import time, which a caller
  // that only asks `isExternalAgent` (every agent turn) must not pay for.
  const { ExternalAgentOfflineError, runExternalTurn } = await import('./relay.js');
  try {
    const { response } = await runExternalTurn({
      agentId: input.agentId,
      task: input.task,
      history: input.history ?? [],
      ...(input.threadKey ? { threadKey: input.threadKey } : {}),
      ...(input.onTextDelta ? { onDelta: input.onTextDelta } : {}),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return { response, tokensUsed: 0, creditsCharged: 0 };
  } catch (err: unknown) {
    const offline = err instanceof ExternalAgentOfflineError;
    if (!offline) log.general.warn({ err, agentId: input.agentId }, 'External agent turn failed');
    return {
      response: '',
      tokensUsed: 0,
      creditsCharged: 0,
      error: offline
        ? 'That agent is offline: its computer is not connected to Alia right now.'
        : err instanceof Error
          ? err.message
          : 'The external agent failed',
    };
  }
}
