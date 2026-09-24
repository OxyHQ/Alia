import { Composer } from '@/components/chat/composer/composer';
import { useAliaComposer } from '@/components/chat/composer/use-alia-composer';
import { useCreateConversation } from '@/lib/hooks/use-conversations';
import { useTranslation } from '@/lib/hooks/use-translation';
import { useStore } from '@/lib/stores/global-store';
import {
  SettingsListGroup,
  SettingsListItem,
} from '@oxy.so/bloom/settings-list';
import { toast } from '@oxy.so/bloom/toast';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';

/**
 * Scheduling a task, in words.
 *
 * The page is content on the layout's surface: the layout draws the frame, the
 * menu button and the crumb. The prompt is the chat's own `Composer`, so
 * describing a task here is the same gesture as asking Alia anything; sending
 * starts a conversation that turns the description into a saved task.
 */


const SUGGESTIONS = ['brief', 'remind', 'topic', 'review'] as const;

export default function AutomationsScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const createConversation = useCreateConversation();
  const composer = useAliaComposer({ locked: createConversation.isPending });
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
      toast.error(t('pages.automations.startFailed'));
    }
  };

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      contentContainerClassName="w-full max-w-[640px] self-center gap-6 px-4 pb-12 pt-8"
    >
      {/* A `className` on Bloom's Text REPLACES its variant, so the one-line
          heading is centred by its wrapper and keeps title-2-semibold. The
          description wraps, so it needs `text-center` itself; Muted's own scale
          (14/20, muted foreground) is spelled out beside it for the same reason. */}
      <View className="items-center">
        <Text variant="title-2-semibold">{t('pages.automations.heading')}</Text>
      </View>
      <Muted className="text-center text-sm leading-5 text-muted-foreground">
        {t('pages.automations.description')}
      </Muted>

      <Composer
        {...composer.props}
        value={prompt}
        onValueChange={setPrompt}
        onSubmit={() => void startConversation(prompt)}
        busy={createConversation.isPending}
        disabled={createConversation.isPending}
        placeholder={t('pages.automations.placeholder')}
      />

      <SettingsListGroup title={t('pages.automations.suggestionsTitle')}>
        {SUGGESTIONS.map((key) => {
          const title = t(`pages.automations.suggestions.${key}.title`);
          const suggestion = t(`pages.automations.suggestions.${key}.prompt`);
          return (
            <SettingsListItem
              key={key}
              title={title}
              description={suggestion}
              accessibilityLabel={title}
              disabled={createConversation.isPending}
              onPress={() => void startConversation(suggestion)}
            />
          );
        })}
      </SettingsListGroup>
    </ScrollView>
  );
}
