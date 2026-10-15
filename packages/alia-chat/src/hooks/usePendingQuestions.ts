import { useCallback, useMemo, useState } from 'react';
import { type AskedQuestion, pendingQuestions } from '../lib/questions';
import type { Message } from '../runtime/types';

/**
 * What Alia asked in her last turn and the person has not answered: asked above the composer,
 * not in the thread. Any later message, typed or sent from the card, is the answer; `dismiss`
 * puts the card away until she asks again.
 */
export function usePendingQuestions(
  messages: readonly Pick<Message, 'id' | 'role' | 'toolInvocations'>[],
  isStreaming: boolean,
): { questions: AskedQuestion[]; dismiss: () => void } {
  const asked = useMemo(() => pendingQuestions(messages, isStreaming), [messages, isStreaming]);
  const lastMessageId = messages.at(-1)?.id ?? null;
  const [dismissedOf, setDismissedOf] = useState<string | null>(null);
  const dismiss = useCallback(() => setDismissedOf(lastMessageId), [lastMessageId]);
  return { questions: dismissedOf === lastMessageId ? [] : asked, dismiss };
}
