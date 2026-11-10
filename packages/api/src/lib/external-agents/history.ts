/** What the person said, as plain text, from an OpenAI-shaped message list. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (part): part is { type: 'text'; text: string } =>
        part !== null &&
        typeof part === 'object' &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string',
    )
    .map((part) => part.text)
    .join('\n');
}

/** The conversation before the last user message, as the daemon wants it (oldest first). */
export function externalHistoryOf(messages: readonly { role: string; content?: unknown }[]): {
  task: string;
  history: { role: 'user' | 'assistant'; content: string }[];
} {
  const turns = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: textOf(m.content) }))
    .filter((m) => m.content !== '');
  const lastUser = turns.map((m) => m.role).lastIndexOf('user');
  if (lastUser < 0) return { task: 'Continue', history: [] };
  return { task: turns[lastUser].content, history: turns.slice(0, lastUser).slice(-20) };
}
