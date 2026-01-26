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
          Send messages to Alia AI using OpenAI-compatible format:
        </Text>
        <View className="p-3 bg-muted rounded-md mb-3">
          <Text className="text-sm font-mono text-foreground">POST /v1/chat/completions</Text>
        </View>
        <Text className="text-sm text-muted-foreground mb-3">Request body:</Text>
        <View className="p-3 bg-muted rounded-md">
          <Text className="text-sm font-mono text-foreground">
            {`{
  "messages": [
    {"role": "user", "content": "Hello!"}
  ],
  "model": "alia-v1",
  "temperature": 0.7,
  "max_tokens": 4096
}`}
          </Text>
        </View>
        <Text className="text-sm text-muted-foreground mt-3">
          The response is streamed in OpenAI-compatible SSE format.
        </Text>
      </View>

      {/* Function Calling */}
      <View className="px-6 py-6 border-b border-border">
        <Text className="text-sm font-semibold text-foreground mb-4">Function calling (Tools)</Text>
        <Text className="text-sm text-muted-foreground mb-3">
          Add tools to your chat completions:
        </Text>
        <View className="p-3 bg-muted rounded-md">
          <Text className="text-sm font-mono text-foreground">
            {`{
  "messages": [...],
  "model": "alia-v1",
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get weather",
        "parameters": {...}
      }
    }
  ]
}`}
          </Text>
        </View>
      </View>

      {/* Get Conversations */}
      <View className="px-6 py-6 border-b border-border">
        <Text className="text-sm font-semibold text-foreground mb-4">Conversations</Text>
        <Text className="text-sm text-muted-foreground mb-3">
          Retrieve conversations (internal Alia chat only):
        </Text>
        <View className="p-3 bg-muted rounded-md">
          <Text className="text-sm font-mono text-foreground">GET /conversations</Text>
        </View>
      </View>

      {/* Available Models */}
      <View className="px-6 py-6 border-b border-border">
        <Text className="text-sm font-semibold text-foreground mb-4">Available models</Text>
        <Text className="text-sm text-muted-foreground mb-3">
          Get a list of available AI models:
        </Text>
        <View className="p-3 bg-muted rounded-md mb-4">
          <Text className="text-sm font-mono text-foreground">GET /v1/models</Text>
        </View>
        <Text className="text-sm text-muted-foreground mb-3">Alia models:</Text>
        <View className="p-3 bg-muted rounded-md">
          <Text className="text-sm font-mono text-foreground">
            {`• alia-lite - Fast (0.5x credits)
• alia-v1 - Balanced (1x credits)
• alia-v1-codea - Code optimized (1.5x)
• alia-v1-pro - High quality (3x)
• alia-v1-pro-max - Best (5x)`}
          </Text>
        </View>
      </View>

      {/* Code Editor Endpoint */}
      <View className="px-6 py-6 border-b border-border">
        <Text className="text-sm font-semibold text-foreground mb-4">Code editor integration</Text>
        <Text className="text-sm text-muted-foreground mb-3">
          OpenAI-compatible endpoint for code editors (Cursor, VS Code):
        </Text>
        <View className="p-3 bg-muted rounded-md mb-3">
          <Text className="text-sm font-mono text-foreground">Base URL: https://api.alia.onl/v1</Text>
        </View>
        <View className="p-3 bg-muted rounded-md mb-3">
          <Text className="text-sm font-mono text-foreground">Model: alia-v1-codea</Text>
        </View>
        <Text className="text-sm text-muted-foreground mb-3">
          • Use alia-v1-codea model for code tasks
        </Text>
        <Text className="text-sm text-muted-foreground mb-3">
          • Supports function calling (tools)
        </Text>
        <Text className="text-sm text-muted-foreground mb-3">
          • Auto-converts tools for multi-provider compatibility
        </Text>
        <Text className="text-sm text-muted-foreground mb-3">
          • Automatic fallback between providers
        </Text>
        <Text className="text-sm text-muted-foreground mb-3">
          • Includes user memory and preferences
        </Text>
        <Text className="text-sm text-muted-foreground">
          • Can send Telegram notifications
        </Text>
      </View>

      {/* Credits & Pricing */}
      <View className="px-6 py-6 border-b border-border">
        <Text className="text-sm font-semibold text-foreground mb-4">Credits & pricing</Text>
        <Text className="text-sm text-muted-foreground mb-3">
          Credits are charged based on tokens used:
        </Text>
        <View className="p-3 bg-muted rounded-md mb-3">
          <Text className="text-sm font-mono text-foreground">
            {`Formula:
Math.ceil((tokens / 1000) × multiplier)

Example:
1,500 tokens × 1.5 (codea) = 3 credits`}
          </Text>
        </View>
        <Text className="text-sm text-muted-foreground">
          Minimum: 1 credit per request
        </Text>
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
