import { View, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { useAuthStore } from "@/lib/stores/auth-store";
import { useMemo } from "react";

const GREETINGS = [
  "Hello {name}",
  "Hey {name}",
  "Hi there, {name}",
  "Welcome back, {name}",
  "Good to see you, {name}",
  "Hey there, {name}",
  "Greetings, {name}",
  "Hello again, {name}",
  "Hi {name}",
  "Welcome, {name}",
];

const SUBTITLE_VARIATIONS = [
  "How can I help you today?",
  "What can I do for you?",
  "What would you like to know?",
  "How may I assist you?",
  "What brings you here today?",
  "Ready to help with anything you need",
  "What can I help you with?",
  "How can I assist you today?",
];

type WelcomeMessageProps = {
  onSuggestionPress?: (message: string) => void;
};

export const WelcomeMessage = ({ onSuggestionPress }: WelcomeMessageProps) => {
  // Use selectors to avoid worklet serialization issues
  const user = useAuthStore((state) => state.user);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);

  const greeting = useMemo(() => {
    const randomGreeting = GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
    const userName = user?.name || user?.email?.split('@')[0] || "there";
    return randomGreeting.replace("{name}", userName);
  }, [user]);

  const subtitle = useMemo(() => {
    return SUBTITLE_VARIATIONS[Math.floor(Math.random() * SUBTITLE_VARIATIONS.length)];
  }, []);

  const suggestions = [
    {
      title: "Summarize text",
      description: "Summarize this article in 3 key points:",
    },
    {
      title: "Draft email",
      description: "Write a formal email requesting a meeting for...",
    },
    {
      title: "Explore ideas",
      description: "Give me 5 creative ideas for a marketing campaign about...",
    },
    {
      title: "Python code",
      description: "Write a Python script to analyze a CSV file.",
    },
  ];

  return (
    <View className="flex-1 items-center justify-center px-4">
      <View className="w-full max-w-2xl">
        {/* Title */}
        <View className="items-start space-y-2 mb-8">
          <Text className="text-3xl font-bold tracking-tight text-foreground">
            {isAuthenticated ? greeting : "Alia"}
          </Text>
          <Text className="text-xl font-medium text-muted-foreground">
            {isAuthenticated ? subtitle : "How can I help you today?"}
          </Text>
        </View>

        {/* Suggestion Grid */}
        <View className="flex-row flex-wrap gap-2">
          {suggestions.map((item, index) => (
            <Pressable
              key={index}
              className="flex-1 min-w-[35%] flex-col items-start rounded-3xl border border-border bg-card p-4 active:bg-muted/50"
              onPress={() => onSuggestionPress?.(item.description)}
            >
              <Text className="text-sm font-medium text-card-foreground mb-1">
                {item.title}
              </Text>
              <Text
                className="text-xs text-muted-foreground line-clamp-1"
                numberOfLines={1}
              >
                {item.description}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
    </View>
  );
};
