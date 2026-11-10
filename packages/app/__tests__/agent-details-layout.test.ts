import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * An agent's page (`/@handle/details`): its sections flow into as many columns as the room allows,
 * in a column that never stretches them across a big screen, and the agent's terminal is not part
 * of it (it lives in the chat's side panel, not on the page).
 */
const SOURCE = readFileSync(
  fileURLToPath(new URL('../src/features/agents/ui/detail/agent-detail.tsx', import.meta.url)),
  'utf8',
);

describe('the agent details page', () => {
  it('has no terminal: neither the component nor its "Activity" column', () => {
    expect(SOURCE).not.toMatch(/AgentTerminal|agent-terminal/);
    // One "Activity" remains, the contributions grid; the terminal's second one is gone.
    expect(SOURCE.match(/t\('agents\.activity'\)/g)).toHaveLength(1);
    expect(SOURCE).toContain('<ActivityGrid');
  });

  it('puts its sections in Bloom’s responsive grid, flowing, up to three columns', () => {
    expect(SOURCE).toContain("from '@oxy.so/bloom/grid'");
    expect(SOURCE).toMatch(/<ResponsiveGrid[\s\S]*flow="columns"/);
    expect(SOURCE).toMatch(/maxColumns=\{3\}/);
    expect(SOURCE).toMatch(/minItemWidth=\{SECTION_MIN_WIDTH\}/);
  });

  it('caps the page’s width so no section is stretched, and chooses columns by that room alone', () => {
    expect(SOURCE).toMatch(/PAGE_MAX_WIDTH = \d+/);
    expect(SOURCE).toMatch(/maxWidth: PAGE_MAX_WIDTH/);
    // No viewport media query, no screen-size switch: the grid measures its own container.
    expect(SOURCE).not.toMatch(/useIsLargeScreen|useWindowDimensions|useWindowBreakpoint/);
  });

  it('draws no cell that would be empty: a gap under nothing is still a gap', () => {
    expect(SOURCE).toMatch(/agentThreads\.length > 0/);
  });
});
