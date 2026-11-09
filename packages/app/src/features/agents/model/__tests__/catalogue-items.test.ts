import { describe, expect, it } from 'vitest';
import type { Agent } from '@/shared/contracts/agents';
import { catalogueItems } from '../catalogue-items';

function agent(id: string, category: string, isFeatured = false): Agent {
  return { _id: id, category, isFeatured } as unknown as Agent;
}

const AGENTS = [
  agent('a1', 'sales', true),
  agent('a2', 'sales'),
  agent('a3', 'design'),
  agent('a4', 'sales'),
  agent('a5', 'sales'),
  agent('a6', 'sales'),
  agent('a7', 'design', true),
];

const labels = {
  featuredLabel: 'Featured',
  categoryLabel: (category: string) => category.toUpperCase(),
  matchedLabel: (count: number) => `${count} matched`,
};

const shape = (items: ReturnType<typeof catalogueItems>) =>
  items.map((item) =>
    item.kind === 'title'
      ? `# ${item.label}${item.category ? ` [${item.category}]` : ''}`
      : item.agents.map((a) => a._id).join(','),
  );

describe('catalogueItems', () => {
  it('lays out the overview: Featured, then the biggest category first, each a preview with View all', () => {
    const items = catalogueItems({ agents: AGENTS, overview: true, columns: 2, ...labels });
    expect(shape(items)).toEqual([
      '# Featured',
      'a1,a7',
      '# SALES [sales]',
      'a1,a2',
      'a4,a5',
      '# DESIGN [design]',
      'a3,a7',
    ]);
  });

  it('keeps a preview to four agents and says nothing of a category with none', () => {
    const items = catalogueItems({ agents: AGENTS, overview: true, columns: 1, ...labels });
    const sales = shape(items).filter((line) => /^a\d(,a\d)*$/.test(line)).length;
    // Featured (2) + sales preview (4) + design (2): one agent per row.
    expect(sales).toBe(8);
    expect(shape(items)).not.toContain('a6');
  });

  it('has no Featured section when nothing is featured', () => {
    const items = catalogueItems({
      agents: AGENTS.map((a) => ({ ...a, isFeatured: false }) as Agent),
      overview: true,
      columns: 2,
      ...labels,
    });
    expect(shape(items)[0]).toBe('# SALES [sales]');
  });

  it('is one section of everything that matched, in full, when searching or filtering', () => {
    const items = catalogueItems({
      agents: AGENTS.slice(0, 5),
      overview: false,
      columns: 2,
      ...labels,
    });
    expect(shape(items)).toEqual(['# 5 matched', 'a1,a2', 'a3,a4', 'a5']);
  });

  it('draws nothing but the title for no matches', () => {
    expect(shape(catalogueItems({ agents: [], overview: false, columns: 2, ...labels }))).toEqual([
      '# 0 matched',
    ]);
  });
});
