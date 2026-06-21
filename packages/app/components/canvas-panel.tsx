import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Layers } from 'lucide-react-native';
import { CanvasComponent } from './canvas/canvas-component';
import { useUIStore } from '@/lib/stores/ui-store';

export function CanvasPanel() {
  const artifacts = useUIStore((s) => s.canvasArtifacts);

  if (artifacts.length === 0) {
    return (
      <View className="flex-1 items-center justify-center px-6 gap-3">
        <Layers size={32} className="text-muted-foreground/30" />
        <Text className="text-sm font-medium text-foreground">No artifacts yet</Text>
        <Text className="text-xs text-muted-foreground text-center">
          Generated files and content will appear here during your conversation.
        </Text>
      </View>
    );
  }

  return (
    <View className="flex-1">
      <View className="px-4 py-3 border-b border-border">
        <Text className="text-sm font-semibold text-foreground">Canvas</Text>
        <Text className="text-[11px] text-muted-foreground">
          {artifacts.length} {artifacts.length === 1 ? 'artifact' : 'artifacts'}
        </Text>
      </View>
      <ScrollView className="flex-1 p-4" contentContainerStyle={{ gap: 16, paddingBottom: 24 }}>
        {artifacts.map((artifact) => (
          <CanvasComponent
            key={artifact.id}
            component={{
              id: artifact.id,
              type: artifact.type,
              title: artifact.title || artifact.type,
              data: artifact.content,
            }}
          />
        ))}
      </ScrollView>
    </View>
  );
}
