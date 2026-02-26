import { useState, useCallback, useEffect, useRef } from "react";
import { useLocalSearchParams } from "expo-router";
import { useRolesStore } from "@/lib/stores/roles-store";
import { useStore } from "@/lib/globalStore";
import { useChatConversation } from "@/hooks/useChatConversation";
import { useSaveConversation } from "@/lib/hooks/use-conversations";
import { ChatPageContent } from "@/components/chat-page-content";
import { UsageLimitDialog } from "@/components/usage-limit-dialog";
import { UsageLimitError } from "@/lib/errors/usage-limit-error";
import { isThinkingModel } from "@/components/model-selector";
import { useVoiceMode } from "@/lib/hooks/use-voice-mode";
import { useVoiceSoundEffects } from "@/lib/hooks/use-sound-effects";

const ChatConversationPage = () => {
  const { id, roleId, agentId, startVoice } = useLocalSearchParams<{ id: string; roleId?: string; agentId?: string; startVoice?: string }>();
  const roles = useRolesStore((state) => state.roles);
  const activeSkillId = useStore((state) => state.activeSkillId);

  const [selectedModel, setSelectedModel] = useState("alia-v1");
  const [activeRoleId, setActiveRoleId] = useState<string | undefined>(roleId);
  const thinkingMode = isThinkingModel(selectedModel);
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
  } = useChatConversation({ conversationId: id, activeRole, thinkingMode, selectedModel, skillId: activeSkillId, agentId });

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
  const usageLimitError = (error instanceof UsageLimitError || (error as any)?.name === 'UsageLimitError')
    ? (error as UsageLimitError)
    : null;

  return (
    <>
      <ChatPageContent
        messages={messages}
        scrollViewRef={scrollViewRef}
        isLoading={isLoading}
        conversationLoading={conversationLoading}
        onSubmit={sendMessage}
        onSuggestionPress={sendMessage}
        onEditMessage={editMessage}
        onStop={stopGeneration}
        onClear={clearConversation}
        selectedModel={selectedModel}
        onModelChange={setSelectedModel}
        activeRole={activeRole}
        onRemoveRole={() => setActiveRoleId(undefined)}
        disabled={!!usageLimitError}
        voice={voice}
        agentId={agentId}
      />
      <UsageLimitDialog error={usageLimitError} onDismiss={clearError} />
    </>
  );
};

export default ChatConversationPage;
