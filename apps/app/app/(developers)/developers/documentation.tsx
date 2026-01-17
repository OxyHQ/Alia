import { View, ScrollView, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { useRouter } from "expo-router";
import { ArrowLeft } from "lucide-react-native";

export default function DocumentationScreen() {
  const router = useRouter();

  return (
    <ScrollView className="flex-1 bg-background">
      {/* Header */}
      <View className="px-6 py-6 border-b border-border">
        <Pressable onPress={() => router.back()} className="flex-row items-center mb-4">
          <ArrowLeft size={16} className="text-muted-foreground mr-2" />
          <Text className="text-sm text-muted-foreground">Back</Text>
        </Pressable>
        <Text className="text-2xl font-semibold text-foreground">API documentation</Text>
        <Text className="text-sm text-muted-foreground mt-1">
          Learn how to integrate Alia AI into your applications
        </Text>
      </View>

      {/* Quick Start */}
      <View className="px-6 py-6 border-b border-border">
        <Text className="text-sm font-semibold text-foreground mb-4">Quick start</Text>
        <View className="mb-4">
          <Text className="text-sm font-medium text-foreground mb-1">1. Create an app</Text>
          <Text className="text-sm text-muted-foreground">
            Go to the Developer Portal and create a new app to get started.
          </Text>
        </View>
        <View className="mb-4">
          <Text className="text-sm font-medium text-foreground mb-1">2. Generate API key</Text>
          <Text className="text-sm text-muted-foreground">
            Generate an API key for your app. Keep it secure and never share it publicly.
          </Text>
        </View>
        <View>
          <Text className="text-sm font-medium text-foreground mb-1">3. Make API calls</Text>
          <Text className="text-sm text-muted-foreground">
            Use your API key to authenticate requests to the Alia AI API.
          </Text>
        </View>
      </View>

      {/* Authentication */}
      <View className="px-6 py-6 border-b border-border">
        <Text className="text-sm font-semibold text-foreground mb-4">Authentication</Text>
        <Text className="text-sm text-muted-foreground mb-3">
          Include your API key in the Authorization header:
        </Text>
        <View className="p-3 bg-muted rounded-md">
          <Text className="text-sm font-mono text-foreground">
            Authorization: Bearer alia_sk_your_api_key_here
          </Text>
        </View>
      </View>

      {/* Chat Completions */}
      <View className="px-6 py-6 border-b border-border">
        <Text className="text-sm font-semibold text-foreground mb-4">Chat completions</Text>
        <Text className="text-sm text-muted-foreground mb-3">
          Send a message to Alia AI and receive a response:
        </Text>
        <View className="p-3 bg-muted rounded-md mb-3">
          <Text className="text-sm font-mono text-foreground">POST /v1/chat</Text>
        </View>
        <Text className="text-sm text-muted-foreground mb-3">Request body:</Text>
        <View className="p-3 bg-muted rounded-md">
          <Text className="text-sm font-mono text-foreground">
            {`{
  "message": "Hello, Alia!",
  "conversationId": "optional-id",
  "model": "gemini-1.5-flash",
  "stream": false
}`}
          </Text>
        </View>
      </View>

      {/* Get Conversations */}
      <View className="px-6 py-6 border-b border-border">
        <Text className="text-sm font-semibold text-foreground mb-4">Get conversations</Text>
        <Text className="text-sm text-muted-foreground mb-3">
          Retrieve a list of all conversations:
        </Text>
        <View className="p-3 bg-muted rounded-md">
          <Text className="text-sm font-mono text-foreground">GET /v1/conversations</Text>
        </View>
      </View>

      {/* Get Available Models */}
      <View className="px-6 py-6 border-b border-border">
        <Text className="text-sm font-semibold text-foreground mb-4">Available models</Text>
        <Text className="text-sm text-muted-foreground mb-3">
          Get a list of available AI models:
        </Text>
        <View className="p-3 bg-muted rounded-md">
          <Text className="text-sm font-mono text-foreground">GET /v1/models</Text>
        </View>
      </View>

      {/* Base URL */}
      <View className="px-6 py-6">
        <Text className="text-sm font-semibold text-foreground mb-4">Base URL</Text>
        <Text className="text-sm text-muted-foreground mb-3">
          All API requests should be made to:
        </Text>
        <View className="p-3 bg-muted rounded-md">
          <Text className="text-sm font-mono text-foreground">https://api.alia.onl</Text>
        </View>
      </View>
    </ScrollView>
  );
}
