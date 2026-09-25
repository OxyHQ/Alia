import { jsonSchema, tool } from 'ai';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { measureContext } from '../context-breakdown.js';

const plain = (description: string) => tool({ description, inputSchema: z.object({ query: z.string() }) });

describe('what a turn puts in the context window', () => {
  it('splits the system prompt into its memory, its skills and the rest', () => {
    const text = 's'.repeat(400) + 'm'.repeat(200) + 'k'.repeat(100);
    const breakdown = measureContext({
      systemPrompt: { text, memoryChars: 200, skillsChars: 100 },
      tools: {},
      messages: [],
      maxContextTokens: 128_000,
    });
    expect(breakdown.memory).toBe(50);
    expect(breakdown.skills).toBe(25);
    // 700 chars → 175 tokens + 4 of message overhead, less memory and skills.
    expect(breakdown.system).toBe(104);
    expect(breakdown.max).toBe(128_000);
  });

  it("counts Alia's own tools apart from MCP tools, which it groups by server", () => {
    const breakdown = measureContext({
      systemPrompt: { text: '', memoryChars: 0, skillsChars: 0 },
      tools: {
        webSearch: plain('Search the web'),
        mcp_github__list_issues: plain('List issues'),
        mcp_github__create_issue: plain('Create an issue'),
        mcp_linear__search: tool({ description: 'Search Linear', inputSchema: jsonSchema({ type: 'object', properties: {} }) }),
      },
      messages: [],
      maxContextTokens: null,
    });
    expect(breakdown.tools).toBeGreaterThan(0);
    expect(breakdown.mcpServers.map((server) => server.server)).toEqual(['github', 'linear']);
    expect(breakdown.mcpServers[0].tools.map((entry) => entry.name)).toEqual(['list_issues', 'create_issue']);
    expect(breakdown.mcp).toBe(breakdown.mcpServers.reduce((sum, server) => sum + server.tokens, 0));
  });

  it('counts the history — tool calls included — but not a system message the prompt replaces', () => {
    const withTools = measureContext({
      systemPrompt: { text: '', memoryChars: 0, skillsChars: 0 },
      tools: {},
      messages: [
        { role: 'system', content: 'x'.repeat(4000) },
        { role: 'user', content: 'x'.repeat(40) },
        { role: 'assistant', content: '', toolInvocations: [{ toolCallId: '1', toolName: 'webSearch', state: 'result', result: 'y'.repeat(400) }] },
      ],
      maxContextTokens: null,
    });
    expect(withTools.messages).toBeGreaterThan(14 + 100);
    expect(withTools.messages).toBeLessThan(1000);
  });
});
