import { describe, expect, it } from 'vitest';

import { contextCardProps, parseContextUsage } from '@/features/chat/model/context-usage';

const t = (key: string) => key;

const event = {
  eventVersion: 1,
  conversationId: 'c1',
  max: 128_000,
  system: 2_000,
  tools: 5_000,
  mcp: 1_200,
  memory: 300,
  skills: 0,
  messages: 8_000,
  mcpServers: [{ server: 'github', tokens: 1_200, tools: [{ name: 'list_issues', tokens: 700 }, { name: 'create_issue', tokens: 500 }] }],
};

describe('the context window, from the alia.context event to the card', () => {
  it('draws one segment per category that holds anything, in prompt order', () => {
    const context = contextCardProps(parseContextUsage(event), t);
    expect(context?.max).toBe(128_000);
    expect(context?.segments.map((s) => s.label)).toEqual([
      'chat.bloom.context.system',
      'chat.bloom.context.tools',
      'chat.bloom.context.mcp',
      'chat.bloom.context.memory',
      'chat.bloom.context.messages',
    ]);
  });

  it('lists each MCP server with its tools in the breakdown', () => {
    expect(contextCardProps(parseContextUsage(event), t)?.groups).toEqual([
      { label: 'github', tokens: 1_200, items: [{ label: 'list_issues', tokens: 700 }, { label: 'create_issue', tokens: 500 }] },
    ]);
  });

  it('draws nothing without a window size, and nothing for a payload that is not one', () => {
    expect(contextCardProps(parseContextUsage({ ...event, max: null }), t)).toBeUndefined();
    expect(parseContextUsage('nope')).toBeNull();
    expect(parseContextUsage({ system: -5, tools: 'x' })?.system).toBe(0);
  });
});
