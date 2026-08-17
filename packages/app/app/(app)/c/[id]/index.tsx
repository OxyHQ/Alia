import { useState, useCallback, useEffect, useRef } from "react";
import { useLocalSearchParams } from "expo-router";
import { useRolesStore } from "@/lib/stores/roles-store";
import { useStore } from "@/lib/stores/global-store";
import { useChatConversation } from "@/lib/hooks/use-chat-conversation";
import { useSaveConversation } from "@/lib/hooks/use-conversations";
import { ChatPageContent } from "@/components/chat-page-content";
import { UsageLimitDialog } from "@/components/usage-limit-dialog";
import { UsageLimitError } from "@/lib/errors/usage-limit-error";
import { useModelStore } from "@/lib/stores/model-store";
import { resolveSelection, useCatalogue } from "@/lib/hooks/use-catalogue";
import { useVoiceMode } from "@/lib/hooks/use-voice-mode";
import { useVoiceSoundEffects } from "@/lib/hooks/use-sound-effects";
import { ContentPanel } from "@oxyhq/bloom/content-panel";

const ChatConversationPage = () => {
  const { id, roleId, agentId, startVoice } = useLocalSearchParams<{ id: string; roleId?: string; agentId?: string; startVoice?: string }>();
  const roles = useRolesStore((state) => state.roles);
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
  const [activeRoleId, setActiveRoleId] = useState<string | undefined>(roleId);
  /**
   * A request flag, read from the store rather than inferred from the model.
   *
   * It used to be `selection.effectiveId === THINKING_MODEL_ID`, which made
   * extended reasoning a property of WHICH model was chosen. The routing table
   * shows that was never true: `alia-v1-thinking` and `alia-v1-pro-max` are two
   * aliases of one profile, so the "thinking model" and the "maximum quality
   * model" routed identically and differed only by the prompt this flag selects.
   */
  const thinkingMode = useModelStore((s) => s.thinkingMode);
  const activeRole = activeRoleId ? roles.find(r => r.id === activeRoleId) : undefined;

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
  } = useChatConversation({ conversationId: id, activeRole, thinkingMode, selectedModel: selection.effectiveId, skillId: activeSkillId, agentId });

  const saveConversation = useSaveConversation();

  // Save voice transcripts when voice mode ends
  const handleVoiceDeactivate = useCallback(() => {
    if (id && messages.length > 0) {
      saveConversation.mutate({ id, messages });
    }
  }, [id, messages, saveConversation]);

  const voice = useVoiceMode({ chatMessages: messages, setMessages, conversationId: id, onDeactivate: handleVoiceDeactivate });

  // Auto-activate voice when navigated with startVoice=true (once only)
  const voiceAutoStartedRef = useRef(false);
  useEffect(() => {
    if (startVoice === 'true' && !voiceAutoStartedRef.current && voice.roomState === 'disconnected') {
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
          scrollViewRef={scrollViewRef}
          isLoading={isLoading}
          conversationLoading={conversationLoading}
          onSubmit={sendMessage}
          onEditMessage={editMessage}
          onStop={stopGeneration}
          onClear={clearConversation}
          selectedModel={selectedModel}
          onModelChange={setConversationModel}
          activeRole={activeRole}
          onRemoveRole={() => setActiveRoleId(undefined)}
          disabled={!!usageLimitError}
          voice={voice}
          agentId={agentId}
          onApprovePlan={approvePlan}
          onRejectPlan={rejectPlan}
        />
        <UsageLimitDialog error={usageLimitError} onDismiss={clearError} />
      </>
    </ContentPanel>
  );
};

export default ChatConversationPage;
