import { Muted, Text } from '@oxy.so/bloom/typography';
import { View } from 'react-native';
import { ChartRenderer } from './ChartRenderer';
import { MarkdownRenderer } from './MarkdownRenderer';
import { TableRenderer } from './TableRenderer';

export type DashboardWidget =
  | { kind: 'stat'; label: string; value: string; delta?: string }
  | {
      kind: 'chart';
      title?: string;
      chartType: 'bar' | 'line' | 'pie';
      labels: string[];
      datasets: { label: string; values: number[] }[];
    }
  | { kind: 'table'; title?: string; headers: string[]; rows: string[][] }
  | { kind: 'text'; title?: string; content: string };

interface DashboardRendererProps {
  data: { widgets?: DashboardWidget[] };
}

/** A dashboard: its stats in a row, then its charts, tables and notes, each drawn by its own renderer. */
export function DashboardRenderer({ data }: DashboardRendererProps) {
  const widgets = Array.isArray(data.widgets) ? data.widgets : [];
  const stats = widgets.filter(
    (w): w is Extract<DashboardWidget, { kind: 'stat' }> => w.kind === 'stat',
  );
  const rest = widgets.filter((w) => w.kind !== 'stat');
  return (
    <View className="gap-3">
      {stats.length > 0 && (
        <View className="flex-row flex-wrap gap-3">
          {stats.map((stat, i) => (
            <View
              key={i}
              className="min-w-36 flex-1 gap-1 rounded-2xl border border-border bg-background-tertiary-default p-3"
            >
              <Muted>{stat.label}</Muted>
              <Text variant="headline-semibold">{stat.value}</Text>
              {stat.delta ? <Muted>{stat.delta}</Muted> : null}
            </View>
          ))}
        </View>
      )}
      {rest.map((widget, i) => {
        switch (widget.kind) {
          case 'chart':
            return <ChartRenderer key={i} data={widget} title={widget.title} />;
          case 'table':
            return (
              <View key={i} className="gap-2">
                {widget.title ? <Text variant="body-semibold">{widget.title}</Text> : null}
                <TableRenderer data={widget} title={widget.title} />
              </View>
            );
          case 'text':
            return (
              <View key={i} className="gap-2">
                {widget.title ? <Text variant="body-semibold">{widget.title}</Text> : null}
                <MarkdownRenderer data={{ content: widget.content }} />
              </View>
            );
          default:
            return null;
        }
      })}
    </View>
  );
}
