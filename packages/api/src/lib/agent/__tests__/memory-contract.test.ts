import { describe, expect, it } from 'vitest';
import {
  AGENT_MEMORY_MAX_LINES,
  agentMemoryPromptSlice,
  hashAgentMemory,
  parseAgentMemoryPath,
} from '../memory-contract.js';

describe('agent memory contract', () => {
  it('admits only the three documented path shapes', () => {
    expect(parseAgentMemoryPath('MEMORY.md').kind).toBe('index');
    expect(parseAgentMemoryPath('memory/product.md').kind).toBe('topic');
    expect(parseAgentMemoryPath('memory/log/2026-09-10.md').kind).toBe('log');
    expect(() => parseAgentMemoryPath('../secret.md')).toThrow();
    expect(() => parseAgentMemoryPath('memory/nested/topic.md')).toThrow();
  });

  it('uses stable hashes and enforces the prompt line budget', () => {
    expect(hashAgentMemory('same')).toBe(hashAgentMemory('same'));
    const sliced = agentMemoryPromptSlice(Array.from({ length: 240 }, (_, i) => `line ${i}`).join('\n'));
    expect(sliced.content.split('\n')).toHaveLength(AGENT_MEMORY_MAX_LINES);
    expect(sliced.truncated).toBe(true);
  });
});
