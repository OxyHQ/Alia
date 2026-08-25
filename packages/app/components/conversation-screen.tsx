import { useState, useCallback, useEffect, useRef } from "react";
import { useStore } from "@/lib/stores/global-store";
import { useChatConversation } from "@/lib/hooks/use-chat-conversation";
import { useMarkConversationBreak, useSaveConversation } from "@/lib/hooks/use-conversations";
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
   * Whether this thread never ends — `/a/:username` rather than `/c/:id`.
   *
   * It is what puts "start a new conversation" in the menu: a thread with no
   * "new chat" of its own needs a way to say the subject changed, and an
   * ordinary chat already has one in the sidebar.
   */
  isPermanentThread?: boolean;
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
  isPermanentThread = false,
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
    breaks,
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
  } = useChatConversation({ conversationId, reasoningEffort, selectedModel: selection.effectiveId ?? undefined, skillId: activeSkillId, agentId });

  const saveConversation = useSaveConversation();
  const markBreak = useMarkConversationBreak();

  /**
   * Stable, and deliberately so: it reaches the memoized `ChatHeader`, which is
   * re-rendered ~20x/s worth of chances to break that memo while an answer
   * streams. Undefined where the thread is not permanent, which is also what
   * keeps the menu item out of an ordinary chat.
   */
  const handleNewConversation = useCallback(() => {
    markBreak.mutate(conversationId);
  }, [markBreak, conversationId]);

  // Save voice transcripts when voice mode ends
  const handleVoiceDeactivate = useCallback(() => {
    if (conversationId && messages.length > 0) {
      saveConversation.mutate({ id: conversationId, messages });
    }
  }, [conversationId, messages, saveConversation]);

  const voice = useVoiceMode({ chatMessages: messages, setMessages, conversationId, onDeactivate: handleVoiceDeactivate });

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
          breaks={breaks}
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
          onNewConversation={isPermanentThread ? handleNewConversation : undefined}
          onApprovePlan={approvePlan}
          onRejectPlan={rejectPlan}
        />
        <UsageLimitDialog error={usageLimitError} onDismiss={clearError} />
      </>
    </ContentPanel>
  );
};
