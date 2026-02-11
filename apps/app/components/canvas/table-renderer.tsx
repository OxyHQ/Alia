import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';

interface TableData {
  headers: string[];
  rows: string[][];
}

interface TableRendererProps {
  data: TableData;
}

export function TableRenderer({ data }: TableRendererProps) {
  const { headers, rows } = data;

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={true}>
      <View className="border border-border rounded-lg overflow-hidden">
        <View className="flex-row bg-muted">
          {headers.map((header, i) => (
            <View key={i} className="px-3 py-2 border-r border-border last:border-r-0" style={{ minWidth: 100 }}>
              <Text className="text-xs font-semibold text-foreground">{header}</Text>
            </View>
          ))}
        </View>

        {rows.map((row, rowIdx) => (
          <View key={rowIdx} className={`flex-row ${rowIdx % 2 === 1 ? 'bg-muted/50' : ''} border-t border-border`}>
            {row.map((cell, cellIdx) => (
              <View key={cellIdx} className="px-3 py-2 border-r border-border last:border-r-0" style={{ minWidth: 100 }}>
                <Text className="text-xs text-foreground">{cell}</Text>
              </View>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}
