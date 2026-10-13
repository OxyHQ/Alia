// The clarifying questions an assistant turn asked, read back from the stored tool call.
//
// The server's `askUserQuestion` ends the turn at the card, so the question IS the tool
// call: it is stored with the message, survives a reload, and is answered by the person's
// next message. Pure functions, no React Native, so a host's models and tests can use them.

import type { ToolInvocation } from '../types';

/** The tool's name on the wire. */
export const ASK_USER_QUESTION_TOOL = 'askUserQuestion';

export interface AskedOption {
  label: string;
  description?: string;
}

export interface AskedQuestion {
  question: string;
  options: AskedOption[];
  multiSelect: boolean;
}

/** What the person picked for one question: option indexes, in option order, and typed text. */
export interface QuestionAnswer {
  picked: number[];
  other?: string;
}

export const isQuestionInvocation = (inv: Pick<ToolInvocation, 'toolName'>): boolean =>
  inv.toolName === ASK_USER_QUESTION_TOOL;

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

/**
 * The questions of a finished call, or `null` when it is not one or its arguments are not
 * drawable. Model output is data the app did not write: every field is checked, and a
 * malformed card is no card rather than a thrown render.
 */
export function askedQuestions(inv: ToolInvocation): AskedQuestion[] | null {
  if (!isQuestionInvocation(inv) || inv.state !== 'result') return null;
  const raw = (inv.args as { questions?: unknown } | undefined)?.questions;
  if (!Array.isArray(raw)) return null;

  const questions: AskedQuestion[] = [];
  for (const item of raw) {
    const q = item as { question?: unknown; options?: unknown; multiSelect?: unknown };
    const question = text(q.question);
    if (question === null || !Array.isArray(q.options)) return null;
    const options: AskedOption[] = [];
    for (const o of q.options) {
      const label = text((o as { label?: unknown })?.label);
      if (label === null) return null;
      const description = text((o as { description?: unknown }).description);
      options.push(description === null ? { label } : { label, description });
    }
    if (options.length < 2) return null;
    questions.push({ question, options, multiSelect: q.multiSelect === true });
  }
  return questions.length === 0 ? null : questions;
}

/**
 * The answers as the message the person "sends": one line per question, so the thread reads
 * as what they said and the model reads the same text. Language-neutral on purpose.
 */
export function formatAnswers(questions: AskedQuestion[], answers: QuestionAnswer[]): string {
  return questions
    .map((q, i) => {
      const answer = answers[i];
      const parts = [
        ...(answer?.picked ?? []).map((index) => q.options[index]?.label),
        answer?.other?.trim(),
      ].filter((part): part is string => !!part);
      return `${q.question}\n→ ${parts.join(', ')}`;
    })
    .join('\n\n');
}
