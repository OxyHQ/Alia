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
  'https://api.alia.onl/v1/chat',
  {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer alia_sk_your_key',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message: 'Hello, Alia!',
      model: 'gemini-1.5-flash'
    })
  }
);

const data = await response.json();
console.log(data);`}
          </Text>
        </View>
      </View>

      {/* Python Example */}
      <View className="px-6 py-6 border-b border-border">
        <Text className="text-sm font-semibold text-foreground mb-4">Python</Text>
        <Text className="text-sm text-muted-foreground mb-3">Using requests library:</Text>
        <View className="p-3 bg-muted rounded-md">
          <Text className="text-sm font-mono text-foreground">
            {`import requests

response = requests.post(
    'https://api.alia.onl/v1/chat',
    headers={
        'Authorization': 'Bearer alia_sk_your_key',
        'Content-Type': 'application/json'
    },
    json={
        'message': 'Hello, Alia!',
        'model': 'gemini-1.5-flash'
    }
)

data = response.json()
print(data)`}
          </Text>
        </View>
      </View>

      {/* cURL Example */}
      <View className="px-6 py-6 border-b border-border">
        <Text className="text-sm font-semibold text-foreground mb-4">cURL</Text>
        <Text className="text-sm text-muted-foreground mb-3">Command line example:</Text>
        <View className="p-3 bg-muted rounded-md">
          <Text className="text-sm font-mono text-foreground">
            {`curl -X POST https://api.alia.onl/v1/chat \\
  -H "Authorization: Bearer alia_sk_your_key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "message": "Hello, Alia!",
    "model": "gemini-1.5-flash"
  }'`}
          </Text>
        </View>
      </View>

      {/* Streaming Example */}
      <View className="px-6 py-6">
        <Text className="text-sm font-semibold text-foreground mb-4">Streaming responses</Text>
        <Text className="text-sm text-muted-foreground mb-3">Enable streaming for real-time responses:</Text>
        <View className="p-3 bg-muted rounded-md">
          <Text className="text-sm font-mono text-foreground">
            {`const response = await fetch(
  'https://api.alia.onl/v1/chat',
  {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer alia_sk_your_key',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message: 'Tell me a story',
      stream: true
    })
  }
);

const reader = response.body.getReader();
// Process stream...`}
          </Text>
        </View>
      </View>
    </ScrollView>
  );
}
