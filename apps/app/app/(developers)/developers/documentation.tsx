import { View, ScrollView, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { Card } from "@/components/ui/card";
import { useRouter } from "expo-router";
import { ArrowLeft, Book, Code, Key, MessageSquare } from "lucide-react-native";

export default function DocumentationScreen() {
  const router = useRouter();

  return (
    <ScrollView className="flex-1 bg-background">
      {/* Header */}
      <View className="px-6 py-4 border-b border-border">
        <Pressable onPress={() => router.back()} className="flex-row items-center mb-4">
          <ArrowLeft size={20} className="text-muted-foreground mr-2" />
          <Text className="text-base text-muted-foreground">Back</Text>
        </Pressable>

        <View className="flex-row items-center">
          <View className="w-14 h-14 rounded-2xl bg-primary/10 items-center justify-center mr-4">
            <Book size={28} className="text-primary" />
          </View>
          <View className="flex-1">
            <Text className="text-3xl font-bold text-foreground">API Documentation</Text>
            <Text className="text-base text-muted-foreground mt-1">
              Learn how to integrate Alia AI
            </Text>
          </View>
        </View>
      </View>

      {/* Quick Start */}
      <View className="px-6 py-6">
        <Text className="text-lg font-semibold text-foreground mb-4">Quick Start</Text>
        <Card className="p-6">
          <View className="mb-4">
            <Text className="text-base font-semibold text-foreground mb-2">1. Create an App</Text>
            <Text className="text-sm text-muted-foreground">
              Go to the Developer Portal and create a new app to get started.
            </Text>
          </View>

          <View className="mb-4">
            <Text className="text-base font-semibold text-foreground mb-2">2. Generate API Key</Text>
            <Text className="text-sm text-muted-foreground">
              Generate an API key for your app. Keep it secure and never share it publicly.
            </Text>
          </View>

          <View className="mb-4">
            <Text className="text-base font-semibold text-foreground mb-2">3. Make API Calls</Text>
            <Text className="text-sm text-muted-foreground">
              Use your API key to authenticate requests to the Alia AI API.
            </Text>
          </View>
        </Card>
      </View>

      {/* Authentication */}
      <View className="px-6 py-6 border-t border-border">
        <View className="flex-row items-center mb-4">
          <Key size={20} className="text-primary mr-2" />
          <Text className="text-lg font-semibold text-foreground">Authentication</Text>
        </View>
        <Card className="p-6">
          <Text className="text-sm text-muted-foreground mb-3">
            Include your API key in the Authorization header:
          </Text>
          <View className="p-4 bg-muted rounded-lg">
            <Text className="text-xs font-mono text-foreground">
              Authorization: Bearer alia_sk_your_api_key_here
            </Text>
          </View>
        </Card>
      </View>

      {/* Chat Completions */}
      <View className="px-6 py-6 border-t border-border">
        <View className="flex-row items-center mb-4">
          <MessageSquare size={20} className="text-primary mr-2" />
          <Text className="text-lg font-semibold text-foreground">Chat Completions</Text>
        </View>
        <Card className="p-6">
          <Text className="text-sm text-muted-foreground mb-3">
            Send messages to Alia AI using the OpenAI-compatible endpoint:
          </Text>
          <View className="p-4 bg-muted rounded-lg mb-3">
            <Text className="text-xs font-mono text-foreground">
              POST /v1/chat/completions
            </Text>
          </View>
          <Text className="text-sm font-semibold text-foreground mb-2">Example Request:</Text>
          <View className="p-4 bg-muted rounded-lg">
            <Text className="text-xs font-mono text-foreground">
              {`{
  "messages": [
    {
      "role": "user",
      "content": "Hello, Alia!"
    }
  ],
  "temperature": 0.7,
  "max_tokens": 2048
}`}
            </Text>
          </View>
        </Card>
      </View>

      {/* Base URL */}
      <View className="px-6 py-6 border-t border-border">
        <Text className="text-lg font-semibold text-foreground mb-4">Base URL</Text>
        <Card className="p-6">
          <View className="p-4 bg-muted rounded-lg">
            <Text className="text-xs font-mono text-foreground">
              {process.env.EXPO_PUBLIC_API_URL || 'https://api.alia.onl'}
            </Text>
          </View>
        </Card>
      </View>
    </ScrollView>
  );
}
