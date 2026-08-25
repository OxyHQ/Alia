import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The agent's page opens threads. It does not start them.
 *
 * Its "Chat" button used to call `useCreateConversation` and land on `/c/:id`,
 * which was two wrongs at once. A thread with an agent is many ordinary
 * conversations, so creating one is beginning a NEW STRETCH — and somebody
 * pressing a button labelled "Chat" is asking to continue, not to begin. Every
 * press left an empty stretch behind: five presses, five empty rows in the
 * owner's database.
 *
 * Beginning a stretch is a separate act with its own places — the agent can
 * offer it mid-thread and a person can accept — and neither of them is a
 * button on a profile.
 *
 * Verified in Chromium as well: pressing Chat moves `/agents/:id` to `/@handle`
 * and issues no `POST /conversations/new`. That is the real evidence; this is
 * the part a runner without a browser can hold, and it is deliberately narrow.
 * A screen that needs to create a conversation later should delete this and say
 * why, not work around it.
 */

const SOURCE = readFileSync(
  fileURLToPath(new URL('../app/(app)/agents/[id].tsx', import.meta.url)),
  'utf8',
);

describe('the agent detail screen', () => {
  it('is read at all', () => {
    // Without this every assertion below would pass over an empty string, and
    // would keep passing if the file were renamed away.
    expect(SOURCE).toContain('handleChat');
    expect(SOURCE.length).toBeGreaterThan(1000);
  });

  it('creates no conversation', () => {
    expect(SOURCE).not.toContain('useCreateConversation');
    expect(SOURCE).not.toContain('conversations/new');
  });

  it('opens the thread rather than a single conversation', () => {
    expect(SOURCE).toContain('[username]');
    expect(SOURCE).not.toMatch(/pathname:\s*["'][^"']*\/c\/\[id\]/);
  });

  it('would catch the button that mints one', () => {
    // The control, against the shape this replaced.
    const broken = SOURCE.replace(
      'const handleChat = useCallback(() => {',
      'const createConversation = useCreateConversation();\n  const handleChat = useCallback(() => {',
    );

    expect(broken).not.toBe(SOURCE);
    expect(broken).toContain('useCreateConversation');
  });
});
