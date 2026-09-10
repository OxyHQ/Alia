import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { ArrowUp, CalendarClock, Mic, Paperclip } from 'lucide-react-native';
import { useRouter } from 'expo-router';
import { ContentPanel } from '@oxy.so/bloom/content-panel';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@/components/ui/text';
import { Textarea } from '@/components/ui/textarea';
import { useCreateConversation } from '@/lib/hooks/use-conversations';
import { useStore } from '@/lib/stores/global-store';
import { useColorScheme } from '@/lib/useColorScheme';

const SUGGESTIONS = [
  {
    title: 'Start my day informed',
    prompt: 'Every weekday at 8:00 AM, give me a short brief of what matters for my work.',
  },
  {
    title: 'Remember something once',
    prompt: 'Tomorrow at 10:00 AM, remind me to follow up on the project.',
  },
  {
    title: 'Keep up with a topic',
    prompt: 'Every Monday at 9:00 AM, research the latest developments in a topic I choose and summarize them.',
  },
  {
    title: 'Prepare a weekly review',
    prompt: 'Every Friday afternoon, help me review the week and plan the next one.',
  },
] as const;

export default function AutomationsScreen() {
  const router = useRouter();
  const { colors } = useColorScheme();
  const createConversation = useCreateConversation();
  const [prompt, setPrompt] = useState('');

  const startConversation = async (message: string) => {
    const text = message.trim();
    if (!text || createConversation.isPending) return;
    useStore.getState().setPendingInitialMessage({
      content: text,
      text,
      attachments: [],
      mcpServerId: null,
      skillNames: [],
    });
    try {
      const conversation = await createConversation.mutateAsync({});
      setPrompt('');
      router.push({ pathname: '/(app)/c/[id]', params: { id: conversation.id } });
    } catch {
      useStore.getState().clearPendingInitialMessage();
      toast.error('Could not start scheduling. Your description is still here.');
    }
  };

  return (
    <ContentPanel surfaceClassName="bg-background">
      <ScrollView
        className="flex-1 bg-background"
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="mx-auto w-full max-w-3xl flex-grow px-5 pb-12 pt-16"
      >
        <View className="flex-1 items-center">
          <View className="mb-8 h-12 w-12 items-center justify-center rounded-2xl bg-muted">
            <CalendarClock size={24} color={colors.foreground} />
          </View>
          <Text className="text-center text-3xl font-semibold tracking-tight text-foreground">
            What should Alia do later?
          </Text>
          <Text className="mt-3 max-w-xl text-center text-base leading-6 text-muted-foreground">
            Describe the work and when it should happen. Alia will ask only for details that are
            genuinely missing before saving the task.
          </Text>

          <View className="mt-10 w-full rounded-[28px] border border-border bg-surface px-2 py-2 shadow-sm">
            <Textarea
              value={prompt}
              onChangeText={setPrompt}
              placeholder="Schedule a task"
              accessibilityLabel="Schedule a task"
              className="min-h-24 border-0 bg-transparent px-3 py-3 text-base"
              multiline
            />
            <View className="flex-row items-center gap-1 px-1 pb-1">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Add files and more"
                disabled
                className="h-9 w-9 items-center justify-center rounded-full opacity-40"
              >
                <Paperclip size={19} color={colors.foreground} />
              </Pressable>
              <View className="flex-1" />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Start dictation"
                disabled
                className="h-9 w-9 items-center justify-center rounded-full opacity-40"
              >
                <Mic size={20} color={colors.foreground} />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Send prompt"
                disabled={!prompt.trim() || createConversation.isPending}
                onPress={() => void startConversation(prompt)}
                className="h-9 w-9 items-center justify-center rounded-full bg-foreground disabled:opacity-30"
              >
                {createConversation.isPending ? (
                  <ActivityIndicator size="small" color={colors.background} />
                ) : (
                  <ArrowUp size={19} color={colors.background} />
                )}
              </Pressable>
            </View>
          </View>

          <View className="mt-12 w-full">
            <Text className="mb-3 text-sm font-medium text-muted-foreground">Try a task</Text>
            <View className="gap-2">
              {SUGGESTIONS.map((suggestion) => (
                <Pressable
                  key={suggestion.title}
                  accessibilityRole="button"
                  accessibilityLabel={suggestion.title}
                  disabled={createConversation.isPending}
                  onPress={() => void startConversation(suggestion.prompt)}
                  className="rounded-2xl border border-border bg-surface px-4 py-3.5 active:bg-muted disabled:opacity-50"
                >
                  <Text className="text-sm font-medium text-foreground">{suggestion.title}</Text>
                  <Text className="mt-1 text-sm leading-5 text-muted-foreground" numberOfLines={2}>
                    {suggestion.prompt}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        </View>
      </ScrollView>
    </ContentPanel>
  );
}
