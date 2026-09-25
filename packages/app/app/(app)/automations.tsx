import { Composer } from '@/components/chat/composer/composer';
import { useAliaComposer } from '@/components/chat/composer/use-alia-composer';
import { buildMessageContent } from '@/lib/attachment-utils';
import { reportDroppedAttachments } from '@/lib/hooks/use-chat-conversation';
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
  const composer = useAliaComposer({ draft: 'surface:automations', locked: createConversation.isPending });

  /**
   * Starts the conversation that turns the description into a task. From the
   * composer it carries the draft whole — its files and its connector and
   * skills go to the chat like any first message; a suggestion is its text.
   */
  const startConversation = async (message: string, fromDraft: boolean) => {
    const text = message.trim();
    const attachments = fromDraft ? composer.attachments : [];
    const turn = fromDraft ? composer.turnOptions : {};
    if ((!text && attachments.length === 0) || createConversation.isPending) return;
    const built = attachments.length > 0 ? await buildMessageContent(text, attachments) : null;
    reportDroppedAttachments(built?.dropped);
    useStore.getState().setPendingInitialMessage({
      content: built ? built.content : text,
      text,
      attachments,
      mcpServerId: turn.mcpServerId ?? null,
      skillNames: turn.skillNames ?? [],
    });
    try {
      const conversation = await createConversation.mutateAsync({});
      if (fromDraft) composer.clearDraft();
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
        value={composer.text}
        onValueChange={composer.setText}
        onSubmit={() => void startConversation(composer.text, true)}
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
              onPress={() => void startConversation(suggestion, false)}
            />
          );
        })}
      </SettingsListGroup>
    </ScrollView>
  );
}
