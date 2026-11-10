/**
 * `askAlia` — how an agent that is in a SPACE reaches Alia (ADR 0028).
 *
 * A space's agents may talk to each other (`consultAgent`, narrowed to their peers) or to Alia, the
 * person's main assistant, who stays outside every space. She answers in a nested turn for the SAME
 * person: her own prompt, her tools and her memory of them, with no tool that could reach back into
 * another consultation (`nested`), billed to whoever funds the outer turn, like every consultation.
 *
 * Built only for a member of a space (`tool-pipeline.ts`): an agent outside a space has no such door,
 * and asking Alia is not a way around the space's cut (it returns an answer, never a handle on anyone).
 */

import { tool } from 'ai';
import { z } from 'zod';
import { getErrorMessage } from '../errors/index.js';
import { log } from '../logger.js';
import { type AgentTurnPerson, runAgentTurn } from './agent-turn.js';

export const ASK_ALIA_TOOL = 'askAlia';

export interface AskAliaResult {
  success: boolean;
  response: string;
  /** What the answer cost the payer, so the caller can stop before it spends the person dry. */
  creditsCharged: number;
  error?: string;
}

export function buildAskAliaTool(options: {
  person: AgentTurnPerson;
  /** The account that funds the outer turn, and therefore this one. */
  payerOxyUserId: string;
}) {
  return {
    [ASK_ALIA_TOOL]: tool({
      description:
        "Ask Alia, the person's main assistant, something only she can answer: what she knows about the person, their preferences and history, or what their apps hold. She cannot see this conversation, so put everything she needs in `question`. She answers once and briefly; do not ask her to do the space's work.",
      inputSchema: z.object({
        question: z
          .string()
          .min(1)
          .describe('The question, with all the context Alia needs to answer it'),
      }),
      execute: async ({ question }): Promise<AskAliaResult> => {
        try {
          const outcome = await runAgentTurn({
            agent: null,
            task: question,
            person: options.person,
            payerOxyUserId: options.payerOxyUserId,
          });
          return {
            success: outcome.error === undefined,
            response: outcome.response,
            creditsCharged: outcome.creditsCharged,
            ...(outcome.error === undefined ? {} : { error: outcome.error }),
          };
        } catch (error: unknown) {
          log.general.error({ err: error }, 'askAlia failed');
          return { success: false, response: '', creditsCharged: 0, error: getErrorMessage(error) };
        }
      },
    }),
  };
}
