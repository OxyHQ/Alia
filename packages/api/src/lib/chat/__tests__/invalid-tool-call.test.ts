/**
 * A tool call the model got wrong is the model's to read, not the person's.
 *
 * An agent without the `delegation` grant was told by `prompts/base.md` that it
 * had `createAgent`, offered to create one, and called a tool it was never
 * given. The AI SDK marks that `tool-call` `invalid`, follows it with a
 * `tool-error` whose error is a string, and hands the reason back to the model.
 * The stream loop sent the call to the client and wrote "Tool error
 * (createAgent): Tool execution failed" into the answer.
 *
 * Two halves, asserted together: an invalid call reaches the wire in no form,
 * and a tool that really failed still tells the person, in its own words.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { FIXED_FAMILY_TOOLS } from '../../../domain/capability-grants.js';

vi.mock('../../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { v1: child, chat: child, general: child, agents: child, credits: child, providers: child } };
});
vi.mock('../../observability/index.js', () => ({ recordEvent: vi.fn() }));
vi.mock('../../chat-core.js', () => ({ reportModelUsage: vi.fn() }));

const { runChunks } = await import('./stream-harness.js');

describe('a tool error reaches the person only when a tool actually failed', () => {
  it('sends neither the call nor its error when the SDK refused it before running it', async () => {
    const reason = "Model tried to call unavailable tool 'createAgent'. Available tools: getCurrentDate, webSearch.";
    const { assistantResponse, toolInvocations, toolCallCount, written } = await runChunks([
      { type: 'tool-call', toolCallId: 'call-1', toolName: 'createAgent', input: {}, dynamic: true, invalid: true, error: new Error(reason) },
      { type: 'tool-error', toolCallId: 'call-1', toolName: 'createAgent', input: {}, dynamic: true, error: reason },
    ]);

    expect(assistantResponse).toBe('');
    expect(toolInvocations).toEqual([]);
    expect(toolCallCount).toBe(0);
    expect(written.join('')).not.toContain('createAgent');
  });

  it('tells the person, in the tool\'s own words, when a tool ran and failed', async () => {
    const { assistantResponse } = await runChunks([
      { type: 'tool-call', toolCallId: 'call-1', toolName: 'webScraper', input: {} },
      { type: 'tool-error', toolCallId: 'call-1', toolName: 'webScraper', input: {}, error: new Error('page not reachable') },
    ]);

    expect(assistantResponse).toBe('\n\nTool error (webScraper): page not reachable');
  });
});

describe('no prompt file offers a tool that a grant decides', () => {
  it('names none of the grant-gated tools', () => {
    // A prompt file is loaded whatever tools the turn was given; a gated tool
    // it names is one an ungranted agent believes it has, offers, and then
    // cannot call. Guidance for such a tool belongs in its description, which
    // reaches the model only when the tool does.
    const dir = fileURLToPath(new URL('../../../../prompts/', import.meta.url));
    const gated = Object.values(FIXED_FAMILY_TOOLS).flat();
    const named = readdirSync(dir)
      .filter((file) => file.endsWith('.md'))
      .flatMap((file) => {
        const text = readFileSync(`${dir}${file}`, 'utf8');
        return gated.filter((tool) => text.includes(`\`${tool}\``)).map((tool) => `${file}: ${tool}`);
      });

    expect(named).toEqual([]);
  });
});
