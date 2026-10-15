import {
  type AliaChatChrome,
  type AliaChatState,
  AliaChatContent,
  type AliaSuggestion,
} from '@alia.onl/sdk';
import { useConversation } from '@alia.onl/sdk/runtime';
import { AiChatMobileHeader } from '@oxy.so/bloom/ai-chat';
import { ComposerPanelStatusTab } from '@oxy.so/bloom/composer-panel';
import { useAuth } from '@oxy.so/services';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { UsageLimitDialog } from '@/features/billing/ui/usage-limit-dialog';
import { useStore } from '@/features/chat/runtime/global-store';
import { useModelStore } from '@/features/chat/runtime/model-store';
import { useAppVoiceOptions } from '@/features/chat/runtime/use-app-voice-options';
import { useCreditWarnings } from '@/features/chat/runtime/use-credit-warnings';
import { useLocalModelsInvite } from '@/features/chat/runtime/use-local-models-invite';
import {
  type Suggestion,
  useRecordSuggestionUsage,
  useSearchSuggestions,
  useWelcomeSuggestions,
} from '@/features/chat/runtime/use-suggestions';
import { KeyboardFrame } from '@/features/chat/ui/chat-workspace';
import { useComposerMenu } from '@/features/chat/ui/composer/use-alia-composer';
import { useModeSelection } from '@/features/chat/ui/composer/power-level-options';
import { ConversationActions } from '@/features/chat/ui/conversation-actions';
import { useLocalModelOptions } from '@/features/local-models/runtime/use-local-runtimes';
import { useFoldersStore } from '@/features/projects/runtime/folders-store';
import { useProjectsStore } from '@/features/projects/runtime/projects-store';
import { useTranslation } from '@/shared/i18n/use-translation';
import { useColorScheme } from '@/shared/platform/useColorScheme';
import { useScreenOnShow } from '@/shared/platform/use-screen-on-show';

interface ConversationScreenProps {
  /** The conversation open, or omitted on the new-chat screen: the first turn creates it. */
  conversationId?: string;
  /** The agent answering, when this thread belongs to one. */
  agentId?: string;
  /** The agent's name, for the title when the chat has none. */
  agentName?: string;
  /**
   * The handle whose thread this is, when it is one.
   *
   * It is what the history behind the conversation is paged from, and what is re-read when a new
   * stretch is started: the route shows the ACTIVE stretch, and starting one makes a different
   * conversation active. Absent on `/c/:id`, which is a single conversation with no thread behind
   * it, and on the new-chat screen.
   */
  threadHandle?: string;
}

/** The SDK keys a suggestion by `id` and calls a fill-in-the-blanks one a `template`. */
const asSuggestions = (
  suggestions: readonly Suggestion[] | undefined,
): AliaSuggestion[] | undefined =>
  suggestions?.map((suggestion) => ({
    id: suggestion.suggestionId,
    text: suggestion.text,
    template: suggestion.isTemplate,
  }));

/**
 * One open conversation — the whole of it, wherever it was reached from.
 *
 * There are three doors: `/` (the new-chat screen: no conversation yet), `/c/:id`, a chat in the
 * sidebar, and `/a/:username`, the permanent thread with one agent. They are the SAME screen
 * behind different doors, so it lives here rather than in any route: a chat that gains voice or
 * loses a dialog has to gain or lose it in all of them.
 *
 * The conversation is the SDK's (`AliaChatContent`, the same one the bottom sheet mounts). What
 * is here is the app around it: which power level and which of the person's own devices, the add
 * menu with its skills and connected apps, the plan and credits behind a call, the breadcrumb and
 * its actions, the project the chat is filed under, and the dialogs and toasts that belong to the
 * account rather than to the conversation.
 */
export const ConversationScreen = ({
  conversationId,
  agentId,
  agentName,
  threadHandle,
}: ConversationScreenProps) => {
  const { t } = useTranslation();
  const { isAuthenticated, signIn } = useAuth();
  const { isDarkColorScheme } = useColorScheme();
  const insets = useSafeAreaInsets();
  const isFocused = useScreenOnShow();
  const { data: conversationDetails } = useConversation(conversationId);

  // The sidebar highlights the open conversation, and none on the new-chat screen.
  useEffect(() => {
    useStore
      .getState()
      .setChatId(conversationId === undefined ? null : { id: conversationId, from: 'url' });
  }, [conversationId]);
  // A fresh chat starts saved: ghost mode is a choice made for the conversation about to begin.
  useEffect(() => {
    useStore.getState().setGhostMode(false);
  }, []);
  const ephemeral = useStore((s) => s.ghostMode);

  // Toasts that belong to the chat.
  useLocalModelsInvite(true);
  useCreditWarnings(true);

  // ── The power level ──
  // A conversation keeps its own level once one is chosen here, and follows the person's standing
  // choice until then. The new-chat screen has no conversation to keep it in: its choice IS the
  // standing one. The stored choice is resolved against the connected devices, since sending a
  // device that is not connected would be a 400 — on the FIRST turn too.
  const globalLevel = useModelStore((s) => s.selectedLevel);
  const setGlobalLevel = useModelStore((s) => s.setSelectedLevel);
  const [conversationLevel, setConversationLevel] = useState<string | null>(null);
  const { send: model } = useModeSelection(
    conversationId === undefined ? globalLevel : (conversationLevel ?? globalLevel),
  );
  const { options: deviceModels } = useLocalModelOptions();

  const addMenu = useComposerMenu({
    target: conversationId ?? null,
    offerGhost: true,
  });

  // ── Suggestions over the composer ──
  const [suggestionQuery, setSuggestionQuery] = useState('');
  const { data: welcome } = useWelcomeSuggestions();
  const { data: matches } = useSearchSuggestions(suggestionQuery);
  const welcomeSuggestions = useMemo(() => asSuggestions(welcome), [welcome]);
  const suggestionMatches = useMemo(() => asSuggestions(matches), [matches]);
  const { mutate: recordSuggestionUsage } = useRecordSuggestionUsage();
  const handleSuggestionPicked = useCallback(
    (suggestion: AliaSuggestion) => recordSuggestionUsage(suggestion.id),
    [recordSuggestionUsage],
  );

  const voice = useAppVoiceOptions();
  const handleSignIn = useCallback(() => {
    signIn().catch(() => {});
  }, [signIn]);

  // ── The breadcrumb: where the sidebar's tree files the chat, and its actions ──
  const projects = useProjectsStore((state) => state.projects);
  const folders = useFoldersStore((state) => state.folders);
  const projectName = conversationId
    ? (projects.find((p) => p.conversationIds.includes(conversationId))?.name ??
      folders.find((f) => f.conversationIds.includes(conversationId))?.name ??
      t('sidebar.chats'))
    : undefined;
  const title = conversationDetails?.title || agentName;
  const chrome = useCallback(
    (chat: AliaChatState): AliaChatChrome => ({
      header: <AiChatMobileHeader title={title || 'Alia'} />,
      title: title || t('chat.newChat'),
      project: projectName,
      // Nothing is persisted on the new-chat screen to act on yet.
      actions:
        conversationId === undefined ? undefined : (
          <ConversationActions
            chat={chat}
            agentName={agentName}
            agentId={agentId}
            threadHandle={threadHandle}
          />
        ),
    }),
    [title, t, projectName, conversationId, agentName, agentId, threadHandle],
  );

  return (
    <KeyboardFrame>
      <AliaChatContent
        surface
        conversationId={conversationId}
        agentId={agentId}
        threadHandle={threadHandle}
        ephemeral={ephemeral}
        model={model}
        onModelChange={conversationId === undefined ? setGlobalLevel : setConversationLevel}
        deviceModels={deviceModels}
        addMenu={addMenu}
        composerStatus={projectName ? <ComposerPanelStatusTab project={projectName} /> : undefined}
        welcomeSuggestions={welcomeSuggestions}
        suggestionMatches={suggestionMatches}
        onSuggestionQuery={setSuggestionQuery}
        onSuggestionPicked={handleSuggestionPicked}
        chrome={chrome}
        isDarkMode={isDarkColorScheme}
        isFocused={isFocused}
        bottomInset={insets.bottom}
        voice={voice}
        onSignInRequired={isAuthenticated ? undefined : handleSignIn}
        renderUsageLimit={({ error, dismiss }) => (
          <UsageLimitDialog error={error} onDismiss={dismiss} />
        )}
      />
    </KeyboardFrame>
  );
};
