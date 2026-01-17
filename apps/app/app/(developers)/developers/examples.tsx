import { View, ScrollView, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { Card } from "@/components/ui/card";
import { useRouter } from "expo-router";
import { ArrowLeft, Code } from "lucide-react-native";

export default function ExamplesScreen() {
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
            <Code size={28} className="text-primary" />
          </View>
          <View className="flex-1">
            <Text className="text-3xl font-bold text-foreground">Code Examples</Text>
            <Text className="text-base text-muted-foreground mt-1">
              Integration samples for various platforms
            </Text>
          </View>
        </View>
      </View>

      {/* JavaScript/Node.js Example */}
      <View className="px-6 py-6">
        <Text className="text-lg font-semibold text-foreground mb-4">JavaScript / Node.js</Text>
        <Card className="p-6">
          <Text className="text-sm text-muted-foreground mb-3">
            Using fetch API:
          </Text>
          <View className="p-4 bg-muted rounded-lg">
            <Text className="text-xs font-mono text-foreground">
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
        { role: 'user', content: 'Hello!' }
      ]
    })
  }
);

const data = await response.json();
console.log(data);`}
            </Text>
          </View>
        </Card>
      </View>

      {/* Python Example */}
      <View className="px-6 py-6 border-t border-border">
        <Text className="text-lg font-semibold text-foreground mb-4">Python</Text>
        <Card className="p-6">
          <Text className="text-sm text-muted-foreground mb-3">
            Using requests library:
          </Text>
          <View className="p-4 bg-muted rounded-lg">
            <Text className="text-xs font-mono text-foreground">
              {`import requests

response = requests.post(
    'https://api.alia.onl/v1/chat/completions',
    headers={
        'Authorization': 'Bearer alia_sk_your_key',
        'Content-Type': 'application/json'
    },
    json={
        'messages': [
            {'role': 'user', 'content': 'Hello!'}
        ]
    }
)

print(response.json())`}
            </Text>
          </View>
        </Card>
      </View>

      {/* cURL Example */}
      <View className="px-6 py-6 border-t border-border">
        <Text className="text-lg font-semibold text-foreground mb-4">cURL</Text>
        <Card className="p-6">
          <Text className="text-sm text-muted-foreground mb-3">
            Command line example:
          </Text>
          <View className="p-4 bg-muted rounded-lg">
            <Text className="text-xs font-mono text-foreground">
              {`curl -X POST https://api.alia.onl/v1/chat/completions \\
  -H "Authorization: Bearer alia_sk_your_key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "messages": [
      {"role": "user", "content": "Hello!"}
    ]
  }'`}
            </Text>
          </View>
        </Card>
      </View>
    </ScrollView>
  );
}
