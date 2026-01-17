import { View, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { ScrollAdapt } from "@/components/scroll-adapt";
import { useWindowDimensions } from "react-native";
import { useState, useEffect } from "react";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useStore } from "@/lib/globalStore";
import { generateUUID } from "@/lib/utils";
import type { Message, CreateMessage } from "@ai-sdk/react";

interface SuggestedActionsProps {
  hasInput?: boolean;
  append: (
    message: Message | CreateMessage,
    chatRequestOptions?: { body?: object },
  ) => Promise<string | null | undefined>;
}

export function SuggestedActions({
  hasInput = false,
  append,
}: SuggestedActionsProps) {
  const { width } = useWindowDimensions();
  const [cardWidth, setCardWidth] = useState(0);
  const [hasImages, setHasImages] = useState(false);

  const opacity = useSharedValue(1);

  // Subscribe to selectedImageUris length changes without extracting the array
  useEffect(() => {
    const unsubscribe = useStore.subscribe((state) => {
      const hasImagesNow = state.selectedImageUris.length > 0;
      if (hasImagesNow !== hasImages) {
        setHasImages(hasImagesNow);
      }
    });
    return unsubscribe;
  }, [hasImages]);

  useEffect(() => {
    opacity.value = withTiming(
      hasInput || hasImages ? 0 : 1,
      {
        duration: 200,
      },
    );
  }, [hasInput, hasImages]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  const handlePress = async (action: string) => {
    const newChatId = generateUUID();
    useStore.getState().setChatId({ id: newChatId, from: "newChat" });

    // Send the initial message using append
    await append(
      {
        role: "user",
        content: action,
      },
      {
        body: { id: newChatId },
      },
    );
  };

  const actions = [
    {
      title: "What's the weather forecast",
      label:
        "Get detailed weather information for San Francisco, including temperature and wind speed.",
      action: "What is the weather in San Francisco today?",
    },
    {
      title: "Help me write an essay",
      label:
        "Create a well-researched essay exploring Silicon Valley's history, tech culture, innovation ecosystem and global impact",
      action: "Help me draft a short essay about Silicon Valley",
    },
    {
      title: "Get stock market analysis",
      label:
        "Check current stock prices, market trends, trading volume and key financial metrics for any publicly traded company",
      action: "What is the current stock price of Apple (AAPL)?",
    },
  ];

  return (
    <Animated.View style={animatedStyle}>
      <ScrollAdapt withSnap itemWidth={cardWidth}>
        {actions.map((item, i) => (
          <Pressable key={item.action} onPress={() => handlePress(item.action)}>
            <View
              onLayout={(e) => setCardWidth(e.nativeEvent.layout.width)}
              className={cn(
                "mb-3 mr-3 h-36 w-[300px] rounded-2xl border border-border bg-surface p-5 shadow-sm",
              )}
              style={{
                ...(i === actions.length - 1 && {
                  marginRight: width - cardWidth,
                }),
              }}
            >
              <Text className="text-lg font-bold text-surface-foreground leading-6">
                {item.title}
              </Text>
              <Text className="mt-3 text-sm text-muted-foreground leading-5">
                {item.label}
              </Text>
            </View>
          </Pressable>
        ))}
      </ScrollAdapt>
    </Animated.View>
  );
}
