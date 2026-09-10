import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** The profile creates durable agent threads, never bare conversation rows. */

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

  it('does not call the retired bare-conversation creator', () => {
    expect(SOURCE).not.toContain('useCreateConversation');
    expect(SOURCE).not.toContain('conversations/new');
  });

  it('creates and opens an independently addressable agent thread', () => {
    expect(SOURCE).toContain('API_ROUTES.agents.threads');
    expect(SOURCE).toContain('[username]');
    expect(SOURCE).toContain('threadId');
    expect(SOURCE).not.toMatch(/pathname:\s*["'][^"']*\/c\/\[id\]/);
  });

  it('starts priced work through a goal rather than Hire', () => {
    expect(SOURCE).toContain('API_ROUTES.agents.goals');
    expect(SOURCE).toContain('Idempotency-Key');
    expect(SOURCE).not.toContain(`/agents/${'${agent._id}'}/hire`);
  });
});
