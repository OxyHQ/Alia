import { useState, useCallback, useEffect, useRef } from "react";
import { useStore } from "@/lib/stores/global-store";
import { useChatConversation } from "@/lib/hooks/use-chat-conversation";
import { useCreateConversation, useSaveConversation } from "@/lib/hooks/use-conversations";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/hooks/query-keys";
import { ChatPageContent } from "@/components/chat-page-content";
import { UsageLimitDialog } from "@/components/usage-limit-dialog";
import { UsageLimitError } from "@/lib/errors/usage-limit-error";
import { useModelStore } from "@/lib/stores/model-store";
import { resolveSelection, useCatalogue } from "@/lib/hooks/use-catalogue";
import { useVoiceMode } from "@/lib/hooks/use-voice-mode";
import { useVoiceSoundEffects } from "@/lib/hooks/use-sound-effects";
import { ContentPanel } from "@oxyhq/bloom/content-panel";

interface ConversationScreenProps {
  conversationId: string;
  /** The agent answering, when this thread belongs to one. */
  agentId?: string;
  /**
   * The agent's name and color, for the header.
   *
   * Passed as two primitives all the way down, never repackaged: `ChatHeader`
   * is memoized against a screen that re-renders ~20×/s while streaming, and an
   * object would be a new reference on every one of those renders.
   */
  agentName?: string;
  agentColor?: string | null;
  /**
   * The handle whose thread this is, when it is one.
   *
   * Only used to re-read the thread after a new stretch is started: the route
   * shows the ACTIVE stretch, and starting one makes a different conversation
   * active. Absent on `/c/:id`, which is a single conversation with no thread
   * behind it and therefore nothing to re-read.
   */
  threadHandle?: string;
  /** Open straight into voice, once. */
  startVoice?: boolean;
}

/**
 * One open conversation — the whole of it, wherever it was reached from.
 *
 * There are two doors: `/c/:id`, a chat in the sidebar, and `/a/:username`, the
 * permanent thread with one agent. They are the SAME screen behind different
 * doors, so it lives here rather than in either route: a chat that gains voice
 * or loses a dialog has to gain or lose it in both, and two copies of this
 * wiring would drift the first time only one of them was edited.
 */
export const ConversationScreen = ({
  conversationId,
  agentId,
  agentName,
  agentColor,
  threadHandle,
  startVoice = false,
}: ConversationScreenProps) => {
  const activeSkillId = useStore((state) => state.activeSkillId);

  // A conversation keeps its own choice once one is made here, and follows the
  // user's standing choice until then. It used to open on a hard-coded
  // identifier instead, which silently discarded the model the user had picked
  // on the screen that started the conversation.
  const globalModel = useModelStore((s) => s.selectedModel);
  const [conversationModel, setConversationModel] = useState<string | null>(null);
  const selectedModel = conversationModel ?? globalModel;
  const { data: catalogue } = useCatalogue();
  const selection = resolveSelection(selectedModel, catalogue);
  /**
   * A request flag, read from the store rather than inferred from the model.
   *
   * It used to be `selection.effectiveId === THINKING_MODEL_ID`, which made
   * extended reasoning a property of WHICH model was chosen. The routing table
   * shows that was never true: `alia-v1-thinking` and `alia-v1-pro-max` are two
   * aliases of one profile, so the "thinking model" and the "maximum quality
   * model" routed identically and differed only by the prompt this flag selects.
   */
  const reasoningEffort = useModelStore((s) => s.reasoningEffort);

  const {
    messages,
    isLoading,
    conversationLoading,
    error,
    scrollViewRef,
    sendMessage,
    editMessage,
    stopGeneration,
    clearConversation,
    clearError,
    setMessages,
    approvePlan,
    rejectPlan,
    suggestedNewConversation,
    dismissSuggestedNewConversation,
  } = useChatConversation({ conversationId, reasoningEffort, selectedModel: selection.effectiveId ?? undefined, skillId: activeSkillId, agentId });

  const saveConversation = useSaveConversation();
  const createConversation = useCreateConversation();
  const queryClient = useQueryClient();

  /**
   * Take the agent up on its offer: start the next stretch of this thread.
   *
   * The agent cannot do this — its tool emits one frame and writes nothing — so
   * the act is the person's, here. A new conversation with the same agent
   * becomes the most recent, which is the one `GET /agents/thread/:username`
   * calls active, so re-reading the thread is what moves the screen onto it.
   *
   * Dismissed either way: whether the creation succeeds or fails, the offer has
   * been answered, and a failure is already reported by the mutation.
   */
  const handleAcceptNewConversation = useCallback(() => {
    dismissSuggestedNewConversation();
    if (agentId === undefined) return;
    createConversation.mutate({ agentId }, {
      onSuccess: () => {
        if (threadHandle !== undefined) {
          queryClient.invalidateQueries({ queryKey: queryKeys.agents.thread(threadHandle) });
        }
      },
    });
  }, [agentId, threadHandle, createConversation, queryClient, dismissSuggestedNewConversation]);

  // Save voice transcripts when voice mode ends
  const handleVoiceDeactivate = useCallback(() => {
    if (conversationId && messages.length > 0) {
      saveConversation.mutate({ id: conversationId, messages });
    }
  }, [conversationId, messages, saveConversation]);

  const voice = useVoiceMode({ chatMessages: messages, setMessages, conversationId, agentId, onDeactivate: handleVoiceDeactivate });

  // Auto-activate voice when navigated with startVoice (once only)
  const voiceAutoStartedRef = useRef(false);
  useEffect(() => {
    if (startVoice && !voiceAutoStartedRef.current && voice.roomState === 'disconnected') {
      voiceAutoStartedRef.current = true;
      voice.activateVoice();
    }
  }, [startVoice, voice.roomState]);

  // Sound effects for voice mode (thinking, tool calls, connect/disconnect)
  useVoiceSoundEffects({
    isVoiceActive: voice.isVoiceActive,
    agentState: voice.agentState,
    isConnected: voice.isConnected,
  });

  // Check both instanceof AND name — Hermes can break instanceof for Error subclasses
  const usageLimitError = (error instanceof UsageLimitError || error?.name === 'UsageLimitError')
    ? (error as UsageLimitError)
    : null;

  return (
    <ContentPanel surfaceClassName="bg-background">
      <>
        <ChatPageContent
          messages={messages}
          conversationId={conversationId}
          scrollViewRef={scrollViewRef}
          isLoading={isLoading}
          conversationLoading={conversationLoading}
          onSubmit={sendMessage}
          onEditMessage={editMessage}
          onStop={stopGeneration}
          onClear={clearConversation}
          selectedModel={selectedModel}
          onModelChange={setConversationModel}
          disabled={!!usageLimitError}
          voice={voice}
          agentId={agentId}
          agentName={agentName}
          agentColor={agentColor}
          onApprovePlan={approvePlan}
          onRejectPlan={rejectPlan}
          suggestedNewConversation={suggestedNewConversation}
          onAcceptNewConversation={handleAcceptNewConversation}
          onDismissNewConversation={dismissSuggestedNewConversation}
        />
        <UsageLimitDialog error={usageLimitError} onDismiss={clearError} />
      </>
    </ContentPanel>
  );
};
