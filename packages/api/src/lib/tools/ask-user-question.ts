/**
 * Ask User Question Tool
 *
 * Lets the model put a few clarifying questions to the person, each with a short
 * list of options, instead of guessing at an underspecified request.
 *
 * ## The turn ENDS at the question
 *
 * Nothing waits. The call is stored with the message like any other tool call, the
 * turn stops right after it (`hasToolCall` in `chat/model-config.ts`, and no
 * tools-disabled synthesis pass in `chat/stream-runner.ts`), and the person's
 * answers arrive as the NEXT user message. A request that blocked would sit under
 * the global timeout, hold a connection open for a decision that may never come,
 * and lose the question on a reload; one that ends survives all three, because the
 * question is the stored tool call.
 *
 * Whether it was answered is not state either: a question is answered once a later
 * message exists. Typing a reply instead of picking is therefore an answer too.
 *
 * Like `planPreview` it needs a screen that draws the card, so it is registered
 * only for a direct session (`tool-pipeline.ts`), and it needs no capability.
 */

import { tool } from 'ai';
import { z } from 'zod';

/** The tool's name as the model and the clients know it. */
export const ASK_USER_QUESTION_TOOL = 'askUserQuestion';

export const MAX_QUESTIONS = 4;

const OptionSchema = z.object({
  label: z.string().trim().min(1).max(80).describe('The choice, in a few words'),
  description: z.string().trim().max(160).optional().describe('One short line on what it means'),
});

const QuestionSchema = z.object({
  question: z.string().trim().min(1).max(200).describe('The full question, ending in "?"'),
  options: z
    .array(OptionSchema)
    .min(2)
    .max(4)
    .describe('2-4 distinct choices. Never add "Other": the person can always type their own.'),
  multiSelect: z
    .boolean()
    .default(false)
    .describe('true only when several options can be true at once'),
});

export type AskedQuestion = z.infer<typeof QuestionSchema>;

export function createAskUserQuestionTool() {
  return tool({
    description:
      'Ask the person 1-4 clarifying questions, each with 2-4 options, when the request is ambiguous in a way that changes the result ' +
      'and you cannot reasonably choose for them (which of several approaches, a missing detail you cannot look up, a preference). ' +
      'The questions appear as a card and YOUR TURN ENDS: write at most one short sentence before calling this, nothing after it. ' +
      'The answers arrive as the next message. ' +
      'NEVER use it for something you can find out with a tool, something a sensible default settles, ' +
      'or more than once for the same request. When in doubt, answer and state the assumption you made.',
    inputSchema: z.object({
      questions: z.array(QuestionSchema).min(1).max(MAX_QUESTIONS),
    }),
    execute: async ({ questions }) => ({
      asked: questions.length,
      note: "The questions are on the person's screen. Do not write anything more this turn; their answers arrive as the next message.",
    }),
  });
}
