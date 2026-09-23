import { useTranslation } from '@/lib/hooks/use-translation';
import { BarListCard, LineChartCard } from '@oxy.so/bloom/chart-cards';

interface ChartData {
  chartType: 'bar' | 'line' | 'pie';
  labels: string[];
  datasets: { label: string; values: number[] }[];
}

interface ChartRendererProps {
  data: ChartData;
  /** The canvas component's title, used as the chart's name. */
  title?: string;
}

const NUMBER = new Intl.NumberFormat();
const format = (value: number) => NUMBER.format(value);

/**
 * A generated chart on Bloom's chart cards, painted from Bloom's chart palette.
 *
 *  - one `line` series → `LineChartCard`;
 *  - a `pie` → `BarListCard` in shares of the whole, which is what a pie says;
 *  - bars, or several series → `BarListCard` in raw values, one tab per series.
 */
export function ChartRenderer({ data, title }: ChartRendererProps) {
  const { t } = useTranslation();
  const { chartType, labels, datasets } = data;
  const itemsOf = (values: number[]) => labels.map((label, i) => ({ label, value: values[i] || 0 }));

  if (chartType === 'line' && datasets.length === 1) {
    const series = datasets[0];
    return (
      <LineChartCard
        title={series.label || title}
        data={itemsOf(series.values)}
        format={format}
        formatAxisValue={format}
        getPointTitle={(point) => point.label}
        accessibilityLabel={title ?? series.label}
      />
    );
  }

  if (chartType === 'pie' || datasets.length <= 1) {
    const series = datasets[0];
    return (
      <BarListCard
        title={series?.label || title}
        metricLabel={chartType === 'pie' ? t('panels.chart.share') : t('panels.chart.value')}
        metric={chartType === 'pie' ? 'share' : 'value'}
        format={format}
        items={itemsOf(series?.values ?? [])}
        limit={labels.length}
      />
    );
  }

  return (
    <BarListCard
      metricLabel={t('panels.chart.value')}
      metric="value"
      format={format}
      tabs={datasets.map((series, i) => ({
        id: `series-${i}`,
        label: series.label,
        items: itemsOf(series.values),
      }))}
      limit={labels.length}
    />
  );
}
