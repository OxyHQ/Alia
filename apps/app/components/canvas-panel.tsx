import { View, ScrollView, Pressable, Modal } from 'react-native';
import { Text } from '@/components/ui/text';
import { X } from 'lucide-react-native';
import { CanvasComponent } from './canvas/canvas-component';

interface CanvasPanelProps {
  visible: boolean;
  onClose: () => void;
  components: any[];
  onFormSubmit?: (formData: Record<string, any>) => void;
}

export function CanvasPanel({ visible, onClose, components, onFormSubmit }: CanvasPanelProps) {
  return (
    <Modal visible={visible} transparent animationType="fade">
      <View className="flex-1 bg-black/80">
        <View className="flex-1 mt-12 mx-3 mb-3 bg-background rounded-2xl overflow-hidden">
          <View className="flex-row items-center justify-between px-4 py-3 border-b border-border">
            <Text className="text-lg font-semibold text-foreground">Canvas</Text>
            <Pressable onPress={onClose} className="p-1 active:opacity-70">
              <X size={20} className="text-muted-foreground" />
            </Pressable>
          </View>

          {components.length === 0 ? (
            <View className="flex-1 items-center justify-center px-6">
              <Text className="text-muted-foreground text-center text-sm">
                No canvas components yet. The AI will create visual components here during your conversation.
              </Text>
            </View>
          ) : (
            <ScrollView className="flex-1 p-4" contentContainerStyle={{ gap: 16, paddingBottom: 24 }}>
              {components.map((component) => (
                <CanvasComponent
                  key={component.id}
                  component={component}
                  onFormSubmit={onFormSubmit}
                />
              ))}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}
