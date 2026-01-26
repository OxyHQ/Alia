import { View, ScrollView, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { useRouter } from "expo-router";
import { ArrowLeft } from "lucide-react-native";

export default function ExamplesScreen() {
  const router = useRouter();

  return (
    <ScrollView className="flex-1 bg-background">
      {/* Header */}
      <View className="px-6 py-6 border-b border-border">
        <Pressable onPress={() => router.back()} className="flex-row items-center mb-4">
          <ArrowLeft size={16} className="text-muted-foreground mr-2" />
          <Text className="text-sm text-muted-foreground">Back</Text>
        </Pressable>
        <Text className="text-2xl font-semibold text-foreground">Code examples</Text>
        <Text className="text-sm text-muted-foreground mt-1">
          Integration samples for various platforms
        </Text>
      </View>

      {/* JavaScript Example */}
      <View className="px-6 py-6 border-b border-border">
        <Text className="text-sm font-semibold text-foreground mb-4">JavaScript / Node.js</Text>
        <Text className="text-sm text-muted-foreground mb-3">Using fetch API:</Text>
        <View className="p-3 bg-muted rounded-md">
          <Text className="text-sm font-mono text-foreground">
            {`const response = await fetch(
  'https://api.alia.onl/v1/chat/completions',
  {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer alia_sk_your_key',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messages: [
        {role: 'user', content: 'Hello!'}
      ],
      model: 'alia-v1'
    })
  }
);

// Process SSE stream
const reader = response.body.getReader();
// ...read chunks`}
          </Text>
        </View>
      </View>

      {/* Python Example */}
      <View className="px-6 py-6 border-b border-border">
        <Text className="text-sm font-semibold text-foreground mb-4">Python</Text>
        <Text className="text-sm text-muted-foreground mb-3">Using OpenAI SDK:</Text>
        <View className="p-3 bg-muted rounded-md">
          <Text className="text-sm font-mono text-foreground">
            {`from openai import OpenAI

client = OpenAI(
    api_key="alia_sk_your_key",
    base_url="https://api.alia.onl/v1"
)

stream = client.chat.completions.create(
    model="alia-v1",
    messages=[
        {"role": "user", "content": "Hello!"}
    ],
    stream=True
)

for chunk in stream:
    print(chunk.choices[0].delta.content)`}
          </Text>
        </View>
      </View>

      {/* cURL Example */}
      <View className="px-6 py-6 border-b border-border">
        <Text className="text-sm font-semibold text-foreground mb-4">cURL</Text>
        <Text className="text-sm text-muted-foreground mb-3">Command line example:</Text>
        <View className="p-3 bg-muted rounded-md">
          <Text className="text-sm font-mono text-foreground">
            {`curl https://api.alia.onl/v1/chat/completions \\
  -H "Authorization: Bearer alia_sk_your_key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "messages": [
      {"role": "user", "content": "Hello!"}
    ],
    "model": "alia-v1"
  }'`}
          </Text>
        </View>
      </View>

      {/* Streaming Example */}
      <View className="px-6 py-6 border-b border-border">
        <Text className="text-sm font-semibold text-foreground mb-4">Streaming responses</Text>
        <Text className="text-sm text-muted-foreground mb-3">All responses are streamed by default (SSE format):</Text>
        <View className="p-3 bg-muted rounded-md">
          <Text className="text-sm font-mono text-foreground">
            {`const response = await fetch(
  'https://api.alia.onl/v1/chat/completions',
  {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer alia_sk_your_key',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messages: [
        {role: 'user', content: 'Story?'}
      ],
      model: 'alia-v1'
    })
  }
);

const reader = response.body.getReader();
const decoder = new TextDecoder();

while (true) {
  const {done, value} = await reader.read();
  if (done) break;

  const chunk = decoder.decode(value);
  // Parse SSE format: "data: {...}"
  console.log(chunk);
}`}
          </Text>
        </View>
      </View>

      {/* Code Editor Example */}
      <View className="px-6 py-6">
        <Text className="text-sm font-semibold text-foreground mb-4">Code editor integration</Text>
        <Text className="text-sm text-muted-foreground mb-3">Use the unified endpoint for Cursor, VS Code, etc:</Text>
        <View className="p-3 bg-muted rounded-md">
          <Text className="text-sm font-mono text-foreground">
            {`// Cursor/VS Code configuration
{
  "api_key": "alia_sk_your_key",
  "base_url": "https://api.alia.onl/v1",
  "model": "alia-v1-codea"
}

// The endpoint:
// POST /v1/chat/completions
//
// Features:
// • Use alia-v1-codea for code tasks
// • Supports editor tools (auto-converted)
// • Multi-provider fallback (Google→OpenAI→Anthropic)
// • Includes user memory
// • Can send Telegram notifications`}
          </Text>
        </View>
      </View>
    </ScrollView>
  );
}
