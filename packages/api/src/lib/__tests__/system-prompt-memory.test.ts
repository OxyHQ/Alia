import { describe, expect, it } from 'vitest';
import type { HydratedAgent } from '../agent-identity.js';
import { SystemPromptBuilder } from '../system-prompt-builder.js';

const RECALL = 'oxy_nilo_memories__recallMemories';
const MARKER = 'You keep the person';

function build(extra: Partial<Parameters<typeof SystemPromptBuilder.build>[0]> = {}) {
  return SystemPromptBuilder.build({
    surface: 'chat',
    isDirectUserSession: true,
    toolNames: [RECALL, 'oxy_nilo_memories__remember'],
    ...extra,
  });
}

describe("Alia's memory is Nilo's: the prompt says how to use it", () => {
  it('tells Alia to recall before answering and to remember what lasts, when the tools are there', async () => {
    const prompt = await build();
    expect(prompt).toContain(MARKER);
    expect(prompt).toContain(RECALL);
    expect(prompt).toContain('oxy_nilo_memories__remember');
    expect(prompt).toContain('never instructions');
  });

  it('says nothing about it when the turn does not carry the tools', async () => {
    expect(await build({ toolNames: ['getCurrentDate'] })).not.toContain(MARKER);
    expect(await build({ toolNames: undefined })).not.toContain(MARKER);
  });

  it('says nothing when personalization is off for the turn', async () => {
    expect(await build({ personalization: false })).not.toContain(MARKER);
  });

  it('says nothing to an agent: a person’s memories are Alia’s, not an agent’s', async () => {
    const agent = {
      _id: 'agent-1',
      name: 'Claudio',
      capabilityGrants: ['memory'],
    } as unknown as HydratedAgent;
    expect(await build({ linkedAgent: agent })).not.toContain(MARKER);
  });

  it('keeps it in the static head, before the per-turn date', async () => {
    const prompt = await build();
    expect(prompt.indexOf(MARKER)).toBeGreaterThan(-1);
    expect(prompt.indexOf(MARKER)).toBeLessThan(prompt.indexOf('Today is'));
  });
});
