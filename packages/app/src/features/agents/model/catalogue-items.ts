import type { Agent } from '@/shared/contracts/agents';

/** One thing the catalogue draws, top to bottom: a section title, or a row of agents. */
export type CatalogueItem =
  | {
      kind: 'title';
      key: string;
      label: string;
      /** Set where the section is a category's preview: "View all" selects that category. */
      category?: string;
    }
  | { kind: 'row'; key: string; agents: Agent[] };

/** How many agents a category's preview shows before "View all". */
const CATEGORY_PREVIEW = 4;
/** How many featured agents the Featured section shows. */
const FEATURED_PREVIEW = 6;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
}

function section(
  key: string,
  label: string,
  agents: readonly Agent[],
  columns: number,
  category?: string,
): CatalogueItem[] {
  return [
    { kind: 'title', key: `${key}:title`, label, ...(category === undefined ? {} : { category }) },
    ...chunk(agents, columns).map(
      (row, index): CatalogueItem => ({ kind: 'row', key: `${key}:row:${index}`, agents: row }),
    ),
  ];
}

/**
 * The catalogue as a flat list a virtualised list can draw.
 *
 * With nothing typed and no category chosen it is the overview: Featured, then one section per
 * category (the biggest first) holding a preview of its agents, each with "View all". Otherwise it
 * is the one section of what matched, in full. Rows hold as many agents as there are columns, so a
 * long result stays virtualised row by row.
 */
export function catalogueItems({
  agents,
  overview,
  columns,
  featuredLabel,
  categoryLabel,
  matchedLabel,
}: {
  agents: readonly Agent[];
  overview: boolean;
  columns: number;
  featuredLabel: string;
  categoryLabel: (category: string) => string;
  matchedLabel: (count: number) => string;
}): CatalogueItem[] {
  if (!overview) return section('matched', matchedLabel(agents.length), agents, columns);

  const featured = agents.filter((agent) => agent.isFeatured).slice(0, FEATURED_PREVIEW);
  const byCategory = new Map<string, Agent[]>();
  for (const agent of agents) {
    byCategory.set(agent.category, [...(byCategory.get(agent.category) ?? []), agent]);
  }
  const categories = [...byCategory.entries()].sort(
    ([nameA, a], [nameB, b]) => b.length - a.length || nameA.localeCompare(nameB),
  );
  return [
    ...(featured.length === 0 ? [] : section('featured', featuredLabel, featured, columns)),
    ...categories.flatMap(([category, inCategory]) =>
      section(
        `category:${category}`,
        categoryLabel(category),
        inCategory.slice(0, CATEGORY_PREVIEW),
        columns,
        category,
      ),
    ),
  ];
}
