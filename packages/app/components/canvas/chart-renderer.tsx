import { View } from 'react-native';
import { Text } from '@/components/ui/text';

interface ChartData {
  chartType: 'bar' | 'line' | 'pie';
  labels: string[];
  datasets: { label: string; values: number[] }[];
}

interface ChartRendererProps {
  data: ChartData;
}

const COLORS = ['#6366f1', '#f43f5e', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16'];

export function ChartRenderer({ data }: ChartRendererProps) {
  const { chartType, labels, datasets } = data;

  if (chartType === 'pie') {
    const values = datasets[0]?.values || [];
    const total = values.reduce((sum, v) => sum + v, 0);

    return (
      <View className="gap-2">
        {labels.map((label, i) => {
          const value = values[i] || 0;
          const percentage = total > 0 ? ((value / total) * 100).toFixed(1) : '0';
          const color = COLORS[i % COLORS.length];

          return (
            <View key={i} className="flex-row items-center gap-3">
              <View className="w-3 h-3 rounded-full" style={{ backgroundColor: color }} />
              <Text className="text-sm text-foreground flex-1">{label}</Text>
              <Text className="text-sm text-muted-foreground">{percentage}%</Text>
              <View className="flex-1 h-2 bg-muted rounded-full overflow-hidden max-w-[120px]">
                <View
                  className="h-full rounded-full"
                  style={{ backgroundColor: color, width: `${total > 0 ? (value / total) * 100 : 0}%` }}
                />
              </View>
            </View>
          );
        })}
      </View>
    );
  }

  // Bar chart (also used for line as simplification)
  const allValues = datasets.flatMap(d => d.values);
  const maxValue = Math.max(...allValues, 1);

  return (
    <View className="gap-3">
      {datasets.length > 1 && (
        <View className="flex-row flex-wrap gap-3 mb-2">
          {datasets.map((dataset, i) => (
            <View key={i} className="flex-row items-center gap-1.5">
              <View className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: COLORS[i % COLORS.length] }} />
              <Text className="text-xs text-muted-foreground">{dataset.label}</Text>
            </View>
          ))}
        </View>
      )}

      <View className="flex-row items-end gap-1" style={{ height: 140 }}>
        {labels.map((label, labelIdx) => (
          <View key={labelIdx} className="flex-1 items-center gap-0.5" style={{ height: '100%', justifyContent: 'flex-end' }}>
            <View className="flex-row gap-0.5 items-end flex-1 w-full justify-center">
              {datasets.map((dataset, datasetIdx) => {
                const value = dataset.values[labelIdx] || 0;
                const heightPercent = (value / maxValue) * 100;
                return (
                  <View
                    key={datasetIdx}
                    className="rounded-t-sm flex-1 max-w-[24px]"
                    style={{
                      backgroundColor: COLORS[datasetIdx % COLORS.length],
                      height: `${Math.max(heightPercent, 2)}%`,
                    }}
                  />
                );
              })}
            </View>
            <Text className="text-[10px] text-muted-foreground text-center" numberOfLines={1}>
              {label}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}
