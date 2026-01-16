import { View, Pressable, ScrollView, ActivityIndicator } from "react-native";
import { Image } from "expo-image";
import { X, FileText } from "lucide-react-native";
import { Text } from "@/components/ui/text";

interface AttachmentPreviewProps {
  attachments: Array<{
    uri: string;
    type: 'image' | 'document';
    name?: string;
    isLoading?: boolean;
  }>;
  onRemove: (uri: string) => void;
}

export function AttachmentPreview({ attachments, onRemove }: AttachmentPreviewProps) {
  if (attachments.length === 0) {
    return null;
  }

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      className="mb-3"
      contentContainerClassName="gap-2"
    >
      {attachments.map((attachment) => (
        <View
          key={attachment.uri}
          className="relative"
        >
          {attachment.type === 'image' ? (
            <View className="relative w-20 h-20 rounded-xl overflow-hidden bg-muted border border-border">
              {!attachment.isLoading && (
                <Image
                  source={{ uri: attachment.uri }}
                  className="w-full h-full"
                  contentFit="cover"
                />
              )}
              {attachment.isLoading && (
                <View className="absolute inset-0 items-center justify-center bg-muted">
                  <ActivityIndicator size="small" />
                </View>
              )}
              <Pressable
                onPress={() => onRemove(attachment.uri)}
                className="absolute top-1 right-1 w-6 h-6 rounded-full bg-background/90 backdrop-blur-sm items-center justify-center active:opacity-70 border border-border"
                accessibilityRole="button"
                accessibilityLabel="Remove image"
              >
                <X size={14} className="text-foreground" />
              </Pressable>
            </View>
          ) : (
            <View className="relative w-24 h-20 rounded-xl bg-muted border border-border items-center justify-center px-2">
              <FileText size={24} className="text-muted-foreground mb-1" />
              {attachment.name && (
                <Text className="text-[10px] text-muted-foreground text-center" numberOfLines={2}>
                  {attachment.name}
                </Text>
              )}
              <Pressable
                onPress={() => onRemove(attachment.uri)}
                className="absolute top-1 right-1 w-6 h-6 rounded-full bg-background items-center justify-center active:opacity-70 border border-border"
                accessibilityRole="button"
                accessibilityLabel={`Remove document ${attachment.name || ''}`}
              >
                <X size={14} className="text-foreground" />
              </Pressable>
            </View>
          )}
        </View>
      ))}
    </ScrollView>
  );
}
