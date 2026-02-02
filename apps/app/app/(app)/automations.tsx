import { View, ScrollView, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { CloudCog, Plus } from 'lucide-react-native';
import { useRouter } from 'expo-router';

const AUTOMATION_SUGGESTIONS = [
  {
    emoji: '🔍',
    description: 'Find and fix a bug every morning with a short summary',
  },
  {
    emoji: '🌈',
    description: 'Every evening, look through my recent threads and create new skills',
  },
  {
    emoji: '🧪',
    description: 'Add tests every evening for today\'s code changes',
  },
  {
    emoji: '💬',
    description: 'Review PR comments every hour and share next steps',
  },
  {
    emoji: '✏️',
    description: 'Draft release notes every week from recent changes in this repo',
  },
  {
    emoji: '📋',
    description: 'Summarize my team\'s PRs from last week every Monday morning',
  },
  {
    emoji: '📱',
    description: 'Update AGENTS.md every week with new project details',
  },
  {
    emoji: '🚀',
    description: 'Look through recent Linear tickets and start a few PRs for simple tasks',
  },
  {
    emoji: '📊',
    description: 'Write release notes every week for the latest build',
  },
];

export default function AutomationsScreen() {
  const router = useRouter();

  return (
    <View className="flex-1 bg-background">
      <ScrollView className="flex-1">
        {/* Hero Section */}
        <View className="items-center px-6 py-16">
          <CloudCog size={48} className="text-foreground mb-4" />
          <Text className="text-3xl font-bold text-foreground mb-2 text-center">
            Let's automate
          </Text>
          <Text className="text-base text-muted-foreground text-center max-w-md">
            Automate work by setting up scheduled tasks
          </Text>
        </View>

        {/* Automation Cards Grid */}
        <View className="px-6 pb-6">
          <View className="flex-row flex-wrap gap-3 max-w-3xl mx-auto">
            {AUTOMATION_SUGGESTIONS.map((item, index) => (
              <Pressable
                key={index}
                className="w-[48%] md:w-[31%] rounded-2xl bg-surface border border-border p-4 active:bg-muted/50"
              >
                <Text className="text-2xl mb-3">{item.emoji}</Text>
                <Text className="text-sm text-foreground leading-5">
                  {item.description}
                </Text>
              </Pressable>
            ))}
          </View>

          {/* Explore More */}
          <View className="items-center mt-6">
            <Pressable className="active:opacity-70">
              <Text className="text-sm text-muted-foreground">
                Explore more
              </Text>
            </Pressable>
          </View>
        </View>
      </ScrollView>

      {/* Floating Add Button */}
      <View className="absolute top-4 right-4">
        <Button
          variant="default"
          size="icon"
          className="rounded-full h-10 w-10"
        >
          <Plus size={20} className="text-primary-foreground" />
        </Button>
      </View>
    </View>
  );
}
