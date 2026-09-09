import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const conversations = readFileSync(
  new URL('../lib/hooks/use-conversations.ts', import.meta.url),
  'utf8',
);
const chat = readFileSync(
  new URL('../lib/hooks/use-chat-conversation.ts', import.meta.url),
  'utf8',
);

describe('missing conversation recovery', () => {
  it('treats an authenticated 404 as authoritative instead of resurrecting offline data', () => {
    expect(conversations).toMatch(
      /if \(status === 404\) \{\s*await removeStoredConversation\(id\);\s*throw new ConversationNotFoundError\(id\);\s*\}/,
    );
    expect(conversations).toMatch(/if \(status === 401\) \{\s*const stored = await AsyncStorage\.getItem/);
    expect(conversations).not.toMatch(/status === 401 \|\| (?:errorStatus\(error\)|status) === 404/);
  });

  it('leaves an invalid conversation URL and refreshes the visible list', () => {
    expect(chat).toMatch(
      /conversationQueryError instanceof ConversationNotFoundError[\s\S]*?removeQueries[\s\S]*?invalidateQueries[\s\S]*?router\.replace\("\/\(app\)"\)/,
    );
  });
});
