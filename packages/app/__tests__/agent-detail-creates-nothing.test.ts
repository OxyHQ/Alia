import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** The agent's page creates no threads and starts no work: it opens what exists. */

/**
 * The screen as a whole: the route, the page it renders and the hooks its
 * buttons call, which is where the requests live since the route was thinned.
 */
const SOURCE = [
  '../app/(app)/[username]/details.tsx',
  '../src/features/agents/ui/detail/agent-details-page.tsx',
  '../src/features/agents/ui/detail/agent-detail.tsx',
  '../src/features/agents/runtime/use-agent-detail-actions.ts',
  '../src/features/agents/runtime/use-agent-thread-actions.ts',
]
  .map((path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8'))
  .join('\n');

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

  it('creates no thread: it opens the one the agent has, at the agent’s address', () => {
    // A thread with an agent is begun by the API when the two first speak (`GET /agents/thread/:username`).
    expect(SOURCE).not.toContain('API_ROUTES.agents.threads');
    // The thread is opened at the agent's address, `/@handle?threadId=…` (`agentThreadHref`).
    expect(SOURCE).toContain('agentThreadHref');
    expect(SOURCE).toContain('threadId');
    expect(SOURCE).not.toMatch(/pathname:\s*["'][^"']*\/c\/\[id\]/);
  });

  it('starts no task and hires nothing: there is no Start task on the screen', () => {
    expect(SOURCE).not.toContain('API_ROUTES.agents.goals');
    expect(SOURCE).not.toContain('Idempotency-Key');
    expect(SOURCE).not.toContain('startTask');
    expect(SOURCE).not.toContain('handleHire');
    expect(SOURCE).not.toContain(`/agents/${'${agent._id}'}/hire`);
  });
});
