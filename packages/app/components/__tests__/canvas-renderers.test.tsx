import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

/**
 * Which Bloom surface a generated canvas component lands on. The chart and the
 * table are Bloom's own (`chart-cards`, `table`); these pin the mapping from
 * the tool's data shape onto them, with Bloom stubbed at its boundary.
 */

vi.mock('react-native', async () => ({ View: (await import('./panel-bloom-stubs')).host('View') }));
vi.mock('@/lib/hooks/use-translation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@oxy.so/bloom/chart-cards', async () => {
  const { host } = await import('./panel-bloom-stubs');
  return { BarListCard: host('BarListCard'), LineChartCard: host('LineChartCard') };
});
vi.mock('@oxy.so/bloom/table', async () => {
  const { host } = await import('./panel-bloom-stubs');
  return {
    Table: host('Table'),
    TableHeader: host('TableHeader'),
    TableColumn: host('TableColumn'),
    TableBody: host('TableBody'),
    TableRow: host('TableRow'),
    TableCell: host('TableCell'),
  };
});

import { ChartRenderer } from '@/components/canvas/chart-renderer';
import { TableRenderer } from '@/components/canvas/table-renderer';

function render(element: React.ReactElement): ReactTestRenderer {
  let r: ReactTestRenderer | undefined;
  act(() => {
    r = create(element);
  });
  return r!;
}
const only = (r: ReactTestRenderer, name: string) => r.root.find((n) => String(n.type) === name);

describe('a chart', () => {
  it('draws one line series as a line card, in plain numbers', () => {
    const r = render(
      <ChartRenderer title="Visits" data={{ chartType: 'line', labels: ['Mon', 'Tue'], datasets: [{ label: 'Visits', values: [3, 5] }] }} />,
    );
    const card = only(r, 'LineChartCard');
    expect(card.props.data).toEqual([{ label: 'Mon', value: 3 }, { label: 'Tue', value: 5 }]);
    expect(card.props.format(1234)).not.toContain('$');
  });

  it('draws a pie as shares of the whole', () => {
    const r = render(
      <ChartRenderer data={{ chartType: 'pie', labels: ['A', 'B'], datasets: [{ label: 'Split', values: [1, 3] }] }} />,
    );
    const card = only(r, 'BarListCard');
    expect(card.props.metric).toBe('share');
    expect(card.props.items).toHaveLength(2);
  });

  it('draws several series as one tab each, every bar shown', () => {
    const r = render(
      <ChartRenderer
        data={{
          chartType: 'bar',
          labels: ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6'],
          datasets: [
            { label: 'North', values: [1, 2, 3, 4, 5, 6] },
            { label: 'South', values: [6, 5, 4, 3, 2, 1] },
          ],
        }}
      />,
    );
    const card = only(r, 'BarListCard');
    expect(card.props.tabs.map((tab: { label: string }) => tab.label)).toEqual(['North', 'South']);
    expect(card.props.limit).toBe(6);
  });
});

describe('a table', () => {
  it('is Bloom’s table, one column per header and one row per row, scrolling below 100px a column', () => {
    const r = render(<TableRenderer title="People" data={{ headers: ['Name', 'Role'], rows: [['Ana', 'Dev'], ['Bo', 'PM']] }} />);
    expect(only(r, 'Table').props.minWidth).toBe(200);
    expect(r.root.findAll((n) => String(n.type) === 'TableColumn')).toHaveLength(2);
    expect(r.root.findAll((n) => String(n.type) === 'TableRow')).toHaveLength(2);
  });
});
