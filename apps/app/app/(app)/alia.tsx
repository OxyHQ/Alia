import { View, ScrollView } from 'react-native';
import { Image } from 'expo-image';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { useRouter } from 'expo-router';
import { Globe, MessageCircle, Sparkles } from 'lucide-react-native';

export default function AliaProfilePage() {
  const router = useRouter();

  return (
    <ScrollView className="flex-1 bg-background">
      <View className="max-w-2xl mx-auto w-full px-6 py-12">
        {/* Header */}
        <View className="items-center mb-8">
          <Image
            source={require('@/assets/images/logo.png')}
            style={{ width: 120, height: 50 }}
            contentFit="contain"
            className="mb-4"
          />
          <Text className="text-2xl font-bold text-foreground mb-2">
            Alia AI
          </Text>
          <Text className="text-base text-muted-foreground text-center">
            @alia@alia.onl
          </Text>
        </View>

        {/* Bio */}
        <View className="mb-8 space-y-3">
          <View className="flex-row items-start gap-3">
            <Sparkles size={20} className="text-primary mt-0.5" />
            <Text className="text-base text-foreground flex-1">
              AI assistant powered by advanced language models
            </Text>
          </View>
          <View className="flex-row items-start gap-3">
            <MessageCircle size={20} className="text-primary mt-0.5" />
            <Text className="text-base text-foreground flex-1">
              Mention me anywhere in the Fediverse to chat
            </Text>
          </View>
          <View className="flex-row items-start gap-3">
            <Globe size={20} className="text-primary mt-0.5" />
            <Text className="text-base text-foreground flex-1">
              Available on web, mobile, Telegram, and Mastodon
            </Text>
          </View>
        </View>

        {/* Stats */}
        <View className="flex-row justify-center gap-8 mb-8 py-6 border-y border-border">
          <View className="items-center">
            <Text className="text-2xl font-bold text-primary">alia-lite</Text>
            <Text className="text-sm text-muted-foreground">Model</Text>
          </View>
          <View className="items-center">
            <Text className="text-2xl font-bold text-primary">480</Text>
            <Text className="text-sm text-muted-foreground">Char limit</Text>
          </View>
        </View>

        {/* CTA */}
        <View className="items-center gap-3">
          <Button
            onPress={() => router.push('/')}
            className="w-full max-w-xs"
          >
            <Text className="text-primary-foreground font-medium">
              Start chatting
            </Text>
          </Button>
          <Text className="text-xs text-muted-foreground text-center">
            Built with ActivityPub • Open source • Privacy-focused
          </Text>
        </View>
      </View>
    </ScrollView>
  );
}
