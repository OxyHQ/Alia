import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { codeOfFile, snippet } from '@/shared/testing/source-code';

/**
 * Both read in their canonical form (`src/shared/testing/source-code.ts`):
 * comments, layout and quote style dropped, so the formatter cannot turn an
 * assertion red and a comment cannot satisfy one.
 */
const read = (relative: string): string =>
  codeOfFile(fileURLToPath(new URL(`../src/features/chat/runtime/${relative}`, import.meta.url)));
const conversations = read('use-conversations.ts');
const chat = read('use-chat-conversation.ts');

describe('missing conversation recovery', () => {
  it('treats an authenticated 404 as authoritative instead of resurrecting offline data', () => {
    expect(conversations).toContain(
      snippet(
        'if (status === 404) { await removeStoredConversation(id); throw new ConversationNotFoundError(id); }',
      ),
    );
    expect(conversations).toContain(
      snippet('if (status === 401) { const stored = await offlineConversations.getItem'),
    );
    expect(conversations).not.toMatch(/status===401\|\|(?:errorStatus\(error\)|status)===404/);
  });

  it('leaves an invalid conversation URL and refreshes the visible list', () => {
    // Read inside the one effect that recovers, from its guard to the end of
    // its callback (`},[` opens the dependency list). A match across the whole
    // file would be satisfied by the hook's OTHER `router.replace('/(app)')`.
    const guard = snippet(
      'if (!(conversationQueryError instanceof ConversationNotFoundError)) return;',
    );
    const start = chat.indexOf(guard);
    expect(start).toBeGreaterThan(-1);
    const effect = chat.slice(start, chat.indexOf('},[', start));
    const steps = [
      'queryClient.removeQueries(',
      'queryClient.invalidateQueries(',
      "router.replace('/(app)');",
    ].map((step) => effect.indexOf(snippet(step)));
    expect(steps.every((at) => at > -1)).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
  });
});
