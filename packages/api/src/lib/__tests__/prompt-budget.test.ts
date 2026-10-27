import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../tools/mcp.js', () => ({ buildMcpTools: async () => ({}) }));
vi.mock('../tools/integrations.js', () => ({ buildIntegrationTools: async () => ({}) }));
vi.mock('../tools/ask-agent.js', () => ({ buildAskAgentTool: async () => ({}) }));
vi.mock('../tools/oxy-services.js', () => ({
  buildOxyServiceTools: async () => ({}),
  getOxyServicePromptFragment: () => '',
  getOxyServiceContext: async () => '',
  agentIdentityPrompt: () => '',
}));

const { measureScenarios, formatReport } = await import('./support/prompt-scenarios.js');

/** Each limit sits a little above the measured size: growth has to be argued for. */
const BUDGET: Record<string, number> = {
  '1 chat (all tools)': 5900,
  '2 voice': 5900,
  '3 telegram': 580,
  '4 dev-key codea': 1620,
  '4 dev-key cowork': 1550,
  '5 agent run (browser only)': 990,
};

describe('prompt token budget', () => {
  it('keeps every scenario under its budget', async () => {
    const measures = await measureScenarios();
    console.log(`\n${formatReport(measures)}\n`);
    // PROMPT_DUMP=<dir> writes every assembled system message and tool definition, for reading.
    const dump = process.env.PROMPT_DUMP;
    if (dump) {
      const { mkdirSync, writeFileSync } = await import('node:fs');
      mkdirSync(dump, { recursive: true });
      for (const m of measures) {
        const slug = m.name.replace(/[^a-z0-9]+/gi, '-');
        writeFileSync(`${dump}/${slug}.system.txt`, m.system);
        writeFileSync(`${dump}/${slug}.tools.json`, JSON.stringify(m.wire, null, 1));
      }
    }
    for (const m of measures) {
      expect(BUDGET[m.name], `no budget for ${m.name}`).toBeDefined();
      expect(m.total, m.name).toBeLessThanOrEqual(BUDGET[m.name] as number);
    }
  });
});
