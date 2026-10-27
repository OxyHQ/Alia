import type React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

/**
 * A deck and a dashboard drawn in the app's own panel: every slide in order,
 * and every widget on the renderer that draws its kind.
 */

vi.mock('react-native', async () => ({
  View: (await import('../../support/panel-bloom-stubs')).host('View'),
}));
vi.mock('@oxy.so/bloom/typography', async () => {
  const { host } = await import('../../support/panel-bloom-stubs');
  return { Text: host('Text'), Muted: host('Muted') };
});
vi.mock('../../../src/components/canvas/MarkdownRenderer', async () => ({
  MarkdownRenderer: (await import('../../support/panel-bloom-stubs')).host('Markdown'),
}));
vi.mock('../../../src/components/canvas/ChartRenderer', async () => ({
  ChartRenderer: (await import('../../support/panel-bloom-stubs')).host('Chart'),
}));
vi.mock('../../../src/components/canvas/TableRenderer', async () => ({
  TableRenderer: (await import('../../support/panel-bloom-stubs')).host('Table'),
}));

import { DashboardRenderer } from '../../../src/components/canvas/DashboardRenderer';
import { DeckRenderer } from '../../../src/components/canvas/DeckRenderer';

function render(element: React.ReactElement): ReactTestRenderer {
  let r: ReactTestRenderer | undefined;
  act(() => {
    r = create(element);
  });
  return r!;
}
const all = (r: ReactTestRenderer, name: string) => r.root.findAll((n) => String(n.type) === name);
const text = (r: ReactTestRenderer) =>
  all(r, 'Text')
    .concat(all(r, 'Muted'))
    .map((n) => n.props.children);

describe('a deck', () => {
  it('draws every slide with its number, bullets and body', () => {
    const r = render(
      <DeckRenderer
        data={{
          slides: [
            { title: 'Astro', subtitle: 'A browser' },
            { title: 'Why', bullets: ['Fast', 'Calm'], body: 'With **Alia**.' },
          ],
        }}
      />,
    );
    expect(text(r)).toEqual(expect.arrayContaining(['Astro', 'Why', 1, 2, 'A browser']));
    expect(all(r, 'Markdown').map((n) => n.props.data.content)).toEqual([
      '- Fast\n- Calm',
      'With **Alia**.',
    ]);
  });

  it('draws nothing for a deck with no slides', () => {
    expect(all(render(<DeckRenderer data={{}} />), 'Text')).toHaveLength(0);
  });
});

describe('a dashboard', () => {
  it('puts the stats first and each other widget on its renderer', () => {
    const r = render(
      <DashboardRenderer
        data={{
          widgets: [
            { kind: 'text', title: 'Notes', content: 'Steady.' },
            { kind: 'stat', label: 'Revenue', value: '10M', delta: '+12%' },
            {
              kind: 'chart',
              title: 'Monthly',
              chartType: 'bar',
              labels: ['Jan'],
              datasets: [{ label: 'R', values: [1] }],
            },
            { kind: 'table', title: 'Regions', headers: ['Region'], rows: [['EU']] },
          ],
        }}
      />,
    );
    expect(text(r)).toEqual(expect.arrayContaining(['10M', 'Revenue', '+12%', 'Notes', 'Regions']));
    expect(all(r, 'Chart')[0]?.props.title).toBe('Monthly');
    expect(all(r, 'Table')[0]?.props.data.rows).toEqual([['EU']]);
    expect(all(r, 'Markdown')[0]?.props.data.content).toBe('Steady.');
  });
});
