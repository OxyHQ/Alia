/**
 * The agent proposing that the next stretch of the thread start fresh.
 *
 * A thread with an agent is many ordinary conversations, and what the model is
 * given as context is the ACTIVE one — so "start a new conversation" is what
 * keeps that context bounded. The person has a button for it. This is the agent
 * asking for the same thing when it can see the subject has changed.
 *
 * ## It SUGGESTS, and it is structurally incapable of doing
 *
 * The whole safety property, and it is worth stating as a shape rather than as
 * an intention: **this tool creates nothing.** Its only effect is one SSE frame.
 * Starting the conversation is `POST /conversations/new` with the same
 * `agentId` — a request the client makes after a person accepts.
 *
 * If the agent could cut by itself it would be throwing away its own context
 * mid-task, and the person would watch their conversation split without having
 * asked for anything. `__tests__/suggest-new-conversation.test.ts` pins it with
 * a positive control: the repository is a spy, and it must never have been
 * called.
 *
 * Ignoring a suggestion changes nothing. There is no state to clear because
 * nothing was written.
 *
 * ## A TOOL, not a server-side event
 *
 * The requirement is that the agent suggests it *when it considers it
 * necessary*, which means the model decides. A server-emitted event can only be
 * fired by a heuristic, and the heuristic available — elapsed time — is the one
 * already rejected: it lies the day somebody comes back a week later to
 * continue the same idea.
 *
 * ## At most one per turn, enforced HERE
 *
 * The bound is the server's, not the model's good behaviour: a model that calls
 * this on every step of a long turn would push a suggestion behind a suggestion
 * and the screen would never settle. The factory runs once per turn, so the
 * closure below is per-turn state, and every call after the first answers
 * without emitting. The model is told so, so a second call reads as "already
 * done" rather than as a failure.
 *
 * ## No capability family, and that is argued rather than assumed
 *
 * It reads nothing, writes nothing and reaches nothing outside the process, so
 * there is no capability to grant. It is not `delegation` — it delegates to
 * nobody. A tool whose only power is to propose something the person must
 * accept does not need permission, which is why it sits in `UNGRANTED_TOOLS`
 * beside `planPreview` and `plan`.
 */

import { tool } from 'ai';
import { z } from 'zod';

/** What the client receives. `reason` is what lets the UI say WHY. */
export interface NewConversationSuggestion {
  readonly eventVersion: 1;
  readonly reason: string;
}

/** The longest reason that travels. A paragraph is not a chip's label. */
const MAX_REASON = 200;

export const createSuggestNewConversationTool = (
  emit: (suggestion: NewConversationSuggestion) => void,
) => {
  /** Per-turn, because the factory is called once per turn. See the file comment. */
  let suggested = false;

  return tool({
    description:
      'Suggest to the person that the conversation continue in a NEW one, when the subject has clearly changed and carrying the current context forward no longer helps. It only SUGGESTS: it does not start anything, and the person decides. Use it at most once, and not at all if the current subject is still open.',

    inputSchema: z.object({
      reason: z
        .string()
        .describe(
          'One short sentence the person will read, saying why a fresh start would help — e.g. "we have moved from the migration to the billing bug".',
        ),
    }),

    execute: async ({ reason }) => {
      if (suggested) {
        return {
          suggested: false,
          message:
            'A suggestion was already made this turn and the person can see it. Carry on with the answer.',
        };
      }
      suggested = true;
      emit({ eventVersion: 1, reason: reason.trim().slice(0, MAX_REASON) });
      return {
        suggested: true,
        message:
          'The person has been shown the suggestion. Nothing has been created — they choose. Continue answering in this conversation.',
      };
    },
  });
};
