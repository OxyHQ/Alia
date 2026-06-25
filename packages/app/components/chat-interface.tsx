import { View, Pressable, StyleSheet, Platform, type LayoutChangeEvent } from "react-native";
import { toast } from "@/components/sonner";
import { BlurView } from "expo-blur";
import { KeyboardAwareScrollView } from "@/lib/keyboard";
import { Image } from "expo-image";
import { CustomMarkdown } from "@/components/ui/markdown";
import { Text } from "@/components/ui/text";
import { WelcomeMessage } from "@/components/welcome-message";
import React, { useEffect, useState, useCallback, useRef, useMemo } from "react";
import type { ScrollView as GHScrollView } from "react-native-gesture-handler";
import { processMessage } from "@/lib/message-processor";
import { cn } from "@/lib/utils";
import { ThinkingIndicator } from '@alia.onl/sdk';
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { AliaFace, type AliaExpression } from "@/components/ui/alia-face";
import { Copy, ThumbsUp, ThumbsDown, Pencil, Check, Volume2, Square, Music } from "lucide-react-native";
import * as DropdownMenu from "@/components/ui/dropdown-menu";
import { useTTS } from "@/lib/hooks/use-tts";
import { useAudioGen } from "@/lib/hooks/use-audio-gen";
import Animated, {
  FadeInUp,
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  cancelAnimation,
  Easing,
} from "react-native-reanimated";
import * as Clipboard from "expo-clipboard";
import { Reasoning, ReasoningTrigger } from "@/components/ui/reasoning";
import { getToolLabel, getToolActiveLabel, getResearchActiveLabel, getTextFromContent, getImagesFromContent } from '@alia.onl/sdk';
import { useUIStore } from "@/lib/stores/ui-store";
import { useStore, type ChatIdState } from "@/lib/globalStore";
import type { ToolInvocation } from "@/lib/types/messages";
import type { Message as ConversationMessage } from "@/lib/hooks/use-conversations";
import { useScrollToBottom } from "@/hooks/use-scroll-to-bottom";
import { AgentTaskCard } from "@/components/agent-task-card";
import { AgentResultCard } from "@/components/agent-result-card";
import { ResearchProgressCard, PlanPreviewCard } from '@alia.onl/sdk';
import type { ResearchProgress as ResearchProgressData } from '@alia.onl/sdk';
import type { AgentActivityState } from "@/lib/hooks/use-agent-activity";
import { Skeleton } from "@/components/ui/skeleton";
import apiClient from "@/lib/api/client";
import { useTranslation } from "@/hooks/useTranslation";

const isWeb = Platform.OS === "web";

type MessagePart = {
  type: string;
  text?: string;
  [key: string]: unknown;
};

type PendingPlan = {
  planId: string;
  steps: React.ComponentProps<typeof PlanPreviewCard>['steps'];
  approved?: boolean;
  rejected?: boolean;
};

type Message = {
  id: string;
  role: "user" | "assistant" | "system" | "function" | "data" | "tool";
  content?: string | Array<{ type: string; [key: string]: unknown }>;
  thinking?: string; // Extended thinking content
  parts?: MessagePart[];
  toolInvocations?: ToolInvocation[];
  // Voice fields
  source?: 'text' | 'voice';
  speaker?: 'primary' | 'cohost';
  isStreaming?: boolean;
  // Plan preview + research progress
  pendingPlan?: PendingPlan;
  researchProgress?: ResearchProgressData;
  // Agent delegation metadata
  agentInfo?: {
    id: string;
    name: string;
    avatar: string | null;
    handle: string;
    accessories?: Array<{ accessoryId: string; position: { x: number; y: number; scale: number; rotation: number } }>;
  };
  audioUrl?: string;
};

type ChatInterfaceProps = {
  messages: Message[];
  scrollViewRef: React.RefObject<GHScrollView>;
  isLoading?: boolean;
  conversationLoading?: boolean;
  onSuggestionPress?: (message: string) => void;
  onStartEdit?: (messageId: string, content: string) => void;
  onCopyMessage?: (content: string) => void;
  bottomPadding?: number;
  isVoiceActive?: boolean;
  voiceAgentState?: 'idle' | 'listening' | 'thinking' | 'speaking';
  onAtBottomChange?: (isAtBottom: boolean) => void;
  agentActivity?: AgentActivityState | null;
  agentSessionId?: string | null;
  onApprovePlan?: (planId: string) => void;
  onRejectPlan?: (planId: string) => void;
};

/** True for Alia's own assistant messages (excludes delegated agents and voice cohosts). */
function isAliaOwnedMessage(m: Message): boolean {
  return (
    m.role === 'assistant' &&
    !m.agentInfo &&
    !(m.source === 'voice' && m.speaker === 'cohost')
  );
}

// Helper function to extract and process text content for the app
function getMessageText(message: Message): string {
  let rawText = '';

  // Extract raw text from message
  if (message.content) {
    rawText = getTextFromContent(message.content);
  } else if (message.parts && Array.isArray(message.parts)) {
    rawText = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text || "")
      .join("");
  }

  // Process message for app platform (removes Telegram tags, keeps app components)
  const processed = processMessage(rawText, 'app');
  return processed.text;
}

// Extract image URLs from multi-part message content
function getMessageImages(message: Message): string[] {
  if (message.content) {
    return getImagesFromContent(message.content);
  }
  return [];
}

/** Pulsing colored bullet for tool execution status (alia-codea style). */
const ToolBullet = React.memo(function ToolBullet({ isRunning }: { isRunning: boolean }) {
  const opacity = useSharedValue(1);
  React.useEffect(() => {
    if (isRunning) {
      opacity.value = withRepeat(
        withSequence(
          withTiming(0.3, { duration: 500 }),
          withTiming(1, { duration: 500 })
        ),
        -1
      );
    } else {
      opacity.value = withTiming(1, { duration: 150 });
    }
    return () => cancelAnimation(opacity);
  }, [isRunning, opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View style={style}>
      <Text
        style={{ color: isRunning ? '#eab308' : '#22c55e', fontSize: 10 }}
      >
        ●
      </Text>
    </Animated.View>
  );
});

type MessageRowProps = {
  m: Message;
  index: number;
  isNewMessage: boolean;
  isAliaMessage: boolean;
  isLastAlia: boolean;
  isLoading?: boolean;
  isLastMessage: boolean;
  isCopied: boolean;
  myVote: 'up' | 'down' | null;
  ttsActiveMessageId: string | null | undefined;
  ttsPlaybackState: string;
  chatId: ChatIdState;
  voiceAgentState?: 'idle' | 'listening' | 'thinking' | 'speaking';
  handleFaceLayout: (e: LayoutChangeEvent) => void;
  handleCopyMessage: (messageId: string, content: string) => void;
  handleVote: (messageId: string, vote: 'up' | 'down') => void;
  readAloud: (id: string, text: string, chatId?: string, audioUrl?: string) => void;
  generateAudio: (messageId: string, prompt: string, conversationId?: string) => void;
  audioGenActiveMessageId: string | null;
  audioGenState: string;
  openThoughtPanel: (messageId: string) => void;
  onStartEdit?: (messageId: string, content: string) => void;
  onApprovePlan?: (planId: string) => void;
  onRejectPlan?: (planId: string) => void;
};

const MessageRow = React.memo(function MessageRow({
  m, index, isNewMessage, isAliaMessage, isLastAlia,
  isLoading, isLastMessage, isCopied, myVote,
  ttsActiveMessageId, ttsPlaybackState, chatId, voiceAgentState,
  handleFaceLayout, handleCopyMessage, handleVote, readAloud,
  generateAudio, audioGenActiveMessageId, audioGenState,
  openThoughtPanel, onStartEdit, onApprovePlan, onRejectPlan,
}: MessageRowProps) {
  const messageText = getMessageText(m);
  const messageImages = getMessageImages(m);

  return (
    <Animated.View
      key={m.id || `msg-${index}`}
      entering={isNewMessage ? FadeInUp.springify() : undefined}
      style={isAliaMessage && isLastAlia ? { paddingTop: 36 } : undefined}
      onLayout={isAliaMessage && isLastAlia ? handleFaceLayout : undefined}
    >
      {/* Plan Preview — shown before tool execution */}
      {m.pendingPlan && (() => {
        const plan = m.pendingPlan;
        return (
          <PlanPreviewCard
            steps={plan.steps}
            approved={plan.approved}
            rejected={plan.rejected}
            onApprove={() => onApprovePlan?.(plan.planId)}
            onReject={() => onRejectPlan?.(plan.planId)}
          />
        );
      })()}

      {/* Tool Invocations — alia-codea bullet style */}
      {m.toolInvocations?.map((t, ti) => {
        const key = t.toolCallId || `tool-${m.id}-${ti}`;
        const toolLabel = getToolLabel(t.toolName);
        const isRunning = t.state === 'call' || t.state === 'partial-call';

        // Build description from tool args
        let description = '';
        if (t.args?.url) {
          const url = String(t.args.url);
          description = url.length > 40 ? url.substring(0, 40) + '...' : url;
        } else if (t.args?.query) {
          const q = String(t.args.query);
          description = `"${q.length > 30 ? q.substring(0, 30) + '...' : q}"`;
        }

        const isDone = t.state === 'result';

        return (
          <Pressable
            key={key}
            className="flex-row items-center gap-2 py-1 active:opacity-70"
            onPress={isDone ? () => openThoughtPanel(m.id) : undefined}
            disabled={!isDone}
          >
            <ToolBullet isRunning={isRunning} />
            <Text className="text-sm text-foreground flex-1 flex-shrink">
              <Text className="font-bold">{toolLabel}</Text>
              {description ? (
                <Text className="text-muted-foreground"> {description}</Text>
              ) : null}
            </Text>
          </Pressable>
        );
      })}

      {/* Deep Research Progress */}
      {m.role === "assistant" && m.researchProgress && (
        <ResearchProgressCard progress={m.researchProgress as ResearchProgressData} />
      )}

      {/* Thinking Content (Extended Thinking Mode) */}
      {m.role === "assistant" && m.thinking && (
        <View key="thinking-content" className="mb-3 w-full">
          <Reasoning
            isStreaming={
              isLoading &&
              isLastMessage &&
              !messageText
            }
          >
            <ReasoningTrigger
              onPress={() => openThoughtPanel(m.id)}
            />
          </Reasoning>
        </View>
      )}


      {/* Message Content */}
      {(messageText.length > 0 || messageImages.length > 0 || m.isStreaming) && (
        <View key="message-content" className={cn("w-full", m.role === "user" && "mt-2")}>
          {m.role === "assistant" ? (
            // Assistant message: text below (flying face handles avatar)
            <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
            <Pressable className="group">
            <View className="flex-col items-start">
              {/* Agent identity or cohost label (Alia face is floating) */}
              {m.agentInfo ? (
                <View className="flex-row items-center gap-2 mb-0.5">
                  <AliaFace
                    size={20}
                    accessories={m.agentInfo.accessories}
                  />
                  <Text className="text-xs font-semibold" style={{ color: '#f97316' }}>
                    {m.agentInfo.name}
                  </Text>
                </View>
              ) : m.source === 'voice' && m.speaker === 'cohost' ? (
                <Text className="text-xs text-indigo-400 mb-0.5">Cohost</Text>
              ) : null}
              <View className="w-full">
                {m.source === 'voice' ? (
                  <Text className="text-base text-foreground leading-7">
                    {messageText}
                    {m.isStreaming ? '\u258C' : ''}
                  </Text>
                ) : (
                  <CustomMarkdown content={messageText} />
                )}
              </View>
              {/* Action Buttons for Assistant Messages — web hover only */}
              {isWeb && (
              <View className="flex-row gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                <Pressable
                  key="read-aloud"
                  className="p-1.5 rounded-lg hover:bg-muted active:bg-muted"
                  onPress={() => readAloud(m.id, messageText, chatId?.id, m.audioUrl)}
                >
                  {ttsActiveMessageId === m.id && (ttsPlaybackState === 'playing' || ttsPlaybackState === 'paused') ? (
                    <Square size={14} className={ttsPlaybackState === 'playing' ? "text-primary" : "text-muted-foreground"} />
                  ) : (
                    <Volume2 size={14} className={ttsActiveMessageId === m.id && ttsPlaybackState === 'loading' ? "text-primary opacity-50" : "text-muted-foreground"} />
                  )}
                </Pressable>
                <Pressable
                  key="generate-audio"
                  className="p-1.5 rounded-lg hover:bg-muted active:bg-muted"
                  onPress={() => generateAudio(m.id, messageText, chatId?.id)}
                >
                  {audioGenActiveMessageId === m.id && audioGenState === 'playing' ? (
                    <Square size={14} className="text-primary" />
                  ) : (
                    <Music size={14} className={audioGenActiveMessageId === m.id && audioGenState === 'generating' ? "text-primary opacity-50" : "text-muted-foreground"} />
                  )}
                </Pressable>
                <Pressable
                  key="copy"
                  className="p-1.5 rounded-lg hover:bg-muted active:bg-muted"
                  onPress={() => handleCopyMessage(m.id, messageText)}
                >
                  {isCopied ? (
                    <Check size={14} className="text-green-500" />
                  ) : (
                    <Copy size={14} className="text-muted-foreground" />
                  )}
                </Pressable>
                <Pressable key="thumbs-up" className="p-1.5 rounded-lg hover:bg-muted active:bg-muted" onPress={() => handleVote(m.id, 'up')}>
                  <ThumbsUp size={14} className={myVote === 'up' ? "text-primary" : "text-muted-foreground"} />
                </Pressable>
                <Pressable key="thumbs-down" className="p-1.5 rounded-lg hover:bg-muted active:bg-muted" onPress={() => handleVote(m.id, 'down')}>
                  <ThumbsDown size={14} className={myVote === 'down' ? "text-primary" : "text-muted-foreground"} />
                </Pressable>
              </View>
              )}
            </View>
            </Pressable>
            </DropdownMenu.Trigger>
            {!isWeb && (
            <DropdownMenu.Content>
              <DropdownMenu.Item key="read-aloud" onSelect={() => readAloud(m.id, messageText, chatId?.id, m.audioUrl)}>
                <DropdownMenu.ItemIcon ios={{ name: "speaker.wave.2" }} />
                <DropdownMenu.ItemTitle>Read Aloud</DropdownMenu.ItemTitle>
              </DropdownMenu.Item>
              <DropdownMenu.Item key="generate-audio" onSelect={() => generateAudio(m.id, messageText, chatId?.id)}>
                <DropdownMenu.ItemIcon ios={{ name: "music.note" }} />
                <DropdownMenu.ItemTitle>Generate Audio</DropdownMenu.ItemTitle>
              </DropdownMenu.Item>
              <DropdownMenu.Item key="copy" onSelect={() => handleCopyMessage(m.id, messageText)}>
                <DropdownMenu.ItemIcon ios={{ name: "doc.on.doc" }} />
                <DropdownMenu.ItemTitle>Copy</DropdownMenu.ItemTitle>
              </DropdownMenu.Item>
              <DropdownMenu.Item key="thumbs-up" onSelect={() => handleVote(m.id, 'up')}>
                <DropdownMenu.ItemIcon ios={{ name: "hand.thumbsup" }} />
                <DropdownMenu.ItemTitle>Like</DropdownMenu.ItemTitle>
              </DropdownMenu.Item>
              <DropdownMenu.Item key="thumbs-down" onSelect={() => handleVote(m.id, 'down')}>
                <DropdownMenu.ItemIcon ios={{ name: "hand.thumbsdown" }} />
                <DropdownMenu.ItemTitle>Dislike</DropdownMenu.ItemTitle>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
            )}
            </DropdownMenu.Root>
          ) : (
            // User message: bubble only
            <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
            <Pressable className="group">
            <View className="flex-col items-end gap-0.5">
                <View className="max-w-[85%] sm:max-w-[75%] rounded-[24px] overflow-hidden border border-border">
                  <BlurView intensity={60} tint="default" style={StyleSheet.absoluteFill} />
                  <View className="px-4 py-2">
                    {/* Inline images from multi-part content */}
                    {messageImages.length > 0 && (
                      <View className="flex-row flex-wrap gap-2 mb-2">
                        {messageImages.map((imgUrl, imgIdx) => (
                          <View key={`img-${imgIdx}`} className="rounded-xl overflow-hidden" style={imageThumbStyle}>
                            <Image
                              source={{ uri: imgUrl }}
                              className="w-full h-full"
                              contentFit="cover"
                            />
                          </View>
                        ))}
                      </View>
                    )}
                    <Text className="text-base text-foreground leading-7">
                      {messageText}
                    </Text>
                  </View>
                </View>
              {/* Action Buttons for User Messages — web hover only */}
              {isWeb && (
                <View className="flex-row gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                  <Pressable
                    key="copy"
                    className="p-1.5 rounded-lg hover:bg-muted active:bg-muted"
                    onPress={() => handleCopyMessage(m.id, messageText)}
                  >
                    {isCopied ? (
                      <Check size={14} className="text-green-500" />
                    ) : (
                      <Copy size={14} className="text-muted-foreground" />
                    )}
                  </Pressable>
                  <Pressable
                    key="edit"
                    className="p-1.5 rounded-lg hover:bg-muted active:bg-muted"
                    onPress={() => onStartEdit?.(m.id, messageText)}
                  >
                    <Pencil size={14} className="text-muted-foreground" />
                  </Pressable>
                </View>
              )}
            </View>
            </Pressable>
            </DropdownMenu.Trigger>
            {!isWeb && (
            <DropdownMenu.Content>
              <DropdownMenu.Item key="copy" onSelect={() => handleCopyMessage(m.id, messageText)}>
                <DropdownMenu.ItemIcon ios={{ name: "doc.on.doc" }} />
                <DropdownMenu.ItemTitle>Copy</DropdownMenu.ItemTitle>
              </DropdownMenu.Item>
              <DropdownMenu.Item key="edit" onSelect={() => onStartEdit?.(m.id, messageText)}>
                <DropdownMenu.ItemIcon ios={{ name: "pencil" }} />
                <DropdownMenu.ItemTitle>Edit</DropdownMenu.ItemTitle>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
            )}
            </DropdownMenu.Root>
          )}
        </View>
      )}

      {/* ThinkingIndicator — shows when the last assistant message has no text yet */}
      {(isLoading || voiceAgentState === 'thinking') &&
        m.role === "assistant" &&
        isLastMessage &&
        !messageText && (() => {
          // Derive context-aware status from active state
          const activeTool = m.toolInvocations?.find(t => t.state === 'call' || t.state === 'partial-call');
          const rp = m.researchProgress;
          let activeStatus: string | undefined;
          if (activeTool) {
            activeStatus = getToolActiveLabel(activeTool.toolName);
          } else if (rp?.phase && rp.phase !== 'complete') {
            activeStatus = getResearchActiveLabel(rp.phase);
          } else if (m.thinking) {
            activeStatus = "Reasoning...";
          }
          return (
            <ThinkingIndicator
              isWorking={(m.toolInvocations?.length ?? 0) > 0}
              statusText={activeStatus}
            />
          );
        })()}
    </Animated.View>
  );
});

const imageThumbStyle = { width: 120, height: 120 };

export const ChatInterface = React.memo(function ChatInterface({ messages, scrollViewRef, isLoading, conversationLoading, onSuggestionPress, onStartEdit, onCopyMessage, bottomPadding = 160, isVoiceActive = false, voiceAgentState, onAtBottomChange, agentActivity, agentSessionId, onApprovePlan, onRejectPlan }: ChatInterfaceProps) {
    const { t } = useTranslation();
    const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
    const [votedMessages, setVotedMessages] = useState<Record<string, 'up' | 'down'>>({});
    const voteInFlightRef = useRef<Set<string>>(new Set());
    const openThoughtPanel = useUIStore((s) => s.openThoughtPanel);
    const setThoughtMessages = useUIStore((s) => s.setThoughtMessages);
    const { readAloud, activeMessageId: ttsActiveMessageId, playbackState: ttsPlaybackState } = useTTS();
    const { generateAudio, activeMessageId: audioGenActiveMessageId, state: audioGenState } = useAudioGen();
    const chatId = useStore(s => s.chatId);

    const { isAtBottom, onScroll, onContentSizeChange } = useScrollToBottom(scrollViewRef);

    useEffect(() => {
      onAtBottomChange?.(isAtBottom);
    }, [isAtBottom, onAtBottomChange]);

    // Track previous message count — only animate newly added messages
    const prevMessageCountRef = useRef(messages.length);
    useEffect(() => {
      prevMessageCountRef.current = messages.length;
    }, [messages.length]);

    // ── Flying AliaFace ──
    const faceY = useSharedValue(0);
    const [faceExpression, setFaceExpression] = useState<AliaExpression>("Idle A");

    const filteredMessages = useMemo(() => messages.filter(m => m != null && m.role), [messages]);
    const lastAliaIndex = useMemo(() => filteredMessages.reduce((acc, m, i) =>
      isAliaOwnedMessage(m) ? i : acc, -1), [filteredMessages]);

    // Update expression based on voice state or text chat state
    useEffect(() => {
      if (isVoiceActive && voiceAgentState) {
        switch (voiceAgentState) {
          case 'thinking': setFaceExpression("Thinking"); return;
          case 'speaking': setFaceExpression("Writing E"); return;
          case 'listening': setFaceExpression("Interesting"); return;
          default: setFaceExpression("Idle A"); return;
        }
      }

      if (lastAliaIndex < 0) return;
      const m = filteredMessages[lastAliaIndex];
      const text = getMessageText(m);
      const hasActiveTools = m.toolInvocations?.some(
        (t: ToolInvocation) => t.state === 'call' || t.state === 'partial-call'
      );
      if (hasActiveTools) setFaceExpression("Searching A");
      else if (isLoading && !text) setFaceExpression("Thinking");
      else if (isLoading && text.length > 0) setFaceExpression("Writing E");
      else setFaceExpression("Idle A");
    }, [messages, isLoading, voiceAgentState, isVoiceActive]);

    const faceAnimatedStyle = useAnimatedStyle(() => ({
      position: 'absolute' as const,
      left: 0,
      top: faceY.value,
      zIndex: 10,
    }));

    const handleFaceLayout = useCallback((e: LayoutChangeEvent) => {
      faceY.value = withTiming(e.nativeEvent.layout.y, {
        duration: 500,
        easing: Easing.bezier(0.4, 0, 0.2, 1),
      });
    }, [faceY]);

    // Sync messages to the UI store so ThoughtPanel can access them — only when panel is open
    const rightPanel = useUIStore((s) => s.rightPanel);
    useEffect(() => {
      if (rightPanel === 'thought') {
        // The local Message shape is a structural superset of the conversation Message
        // used by the thought panel store.
        setThoughtMessages(messages as unknown as ConversationMessage[]);
      }
    }, [messages, setThoughtMessages, rightPanel]);

    const handleCopyMessage = useCallback(async (messageId: string, content: string) => {
      await Clipboard.setStringAsync(content);
      setCopiedMessageId(messageId);
      setTimeout(() => setCopiedMessageId(null), 2000);
      toast.success(t('chat.copiedToClipboard'));
      onCopyMessage?.(content);
    }, [onCopyMessage, t]);

    const handleVote = useCallback((messageId: string, vote: 'up' | 'down') => {
      if (voteInFlightRef.current.has(messageId)) return;
      let newVote: 'up' | 'down' | null = null;
      setVotedMessages(prev => {
        newVote = prev[messageId] === vote ? null : vote;
        if (newVote) return { ...prev, [messageId]: newVote };
        const { [messageId]: _, ...rest } = prev;
        return rest;
      });
      if (!chatId?.id) return;
      voteInFlightRef.current.add(messageId);
      apiClient.patch(`/conversations/${chatId.id}/messages/${messageId}/vote`, { vote: newVote })
        .then(() => toast.success(t('chat.thanksFeedback')))
        .catch(() => {
          setVotedMessages(prev => {
            const { [messageId]: _, ...rest } = prev;
            return rest;
          });
        })
        .finally(() => voteInFlightRef.current.delete(messageId));
    }, [chatId, t]);

    // Auto-scroll to bottom when new messages arrive or loading starts
    useEffect(() => {
      const timer = setTimeout(() => {
        scrollViewRef.current?.scrollToEnd({ animated: true });
      }, 100);
      return () => clearTimeout(timer);
    }, [messages.length, isLoading, scrollViewRef]);

    const containerClassName = cn(
      "max-w-3xl mx-auto w-full",
      messages.length === 0 && "flex-1 justify-center"
    );

    const scrollContentStyle = useMemo(
      () => ({ flexGrow: 1, paddingTop: 60, paddingBottom: bottomPadding }),
      [bottomPadding]
    );

    return (
      <KeyboardAwareScrollView
        ref={scrollViewRef}
        bottomOffset={60}
        className="flex-1 bg-background px-4 py-4"
        contentContainerStyle={scrollContentStyle}
        showsVerticalScrollIndicator={false}
        onScroll={onScroll}
        scrollEventThrottle={16}
        onContentSizeChange={onContentSizeChange}
      >
        <View className={containerClassName}>
          {!messages.length && (
            conversationLoading ? (
              <View className="gap-5 py-4">
                <View className="items-end">
                  <Skeleton style={{ width: '65%', height: 48, borderRadius: 24 }} />
                </View>
                <View className="items-start gap-2.5">
                  <Skeleton style={{ width: '80%', height: 14, borderRadius: 8 }} />
                  <Skeleton style={{ width: '70%', height: 14, borderRadius: 8 }} />
                  <Skeleton style={{ width: '45%', height: 14, borderRadius: 8 }} />
                </View>
                <View className="items-end">
                  <Skeleton style={{ width: '50%', height: 40, borderRadius: 24 }} />
                </View>
                <View className="items-start gap-2.5">
                  <Skeleton style={{ width: '85%', height: 14, borderRadius: 8 }} />
                  <Skeleton style={{ width: '60%', height: 14, borderRadius: 8 }} />
                </View>
              </View>
            ) : (
              <WelcomeMessage onSuggestionPress={onSuggestionPress} />
            )
          )}

          <View style={{ position: 'relative' }}>
            {/* Single flying AliaFace */}
            {lastAliaIndex >= 0 && (
              <Animated.View style={faceAnimatedStyle}>
                <AliaFace size={28} expression={faceExpression} />
              </Animated.View>
            )}

            {filteredMessages.map((m, index) => {
              const isAliaMessage = isAliaOwnedMessage(m);
              const isNewMessage = index >= prevMessageCountRef.current;

              return (
                <MessageRow
                  key={m.id || `msg-${index}`}
                  m={m}
                  index={index}
                  isNewMessage={isNewMessage}
                  isAliaMessage={isAliaMessage}
                  isLastAlia={index === lastAliaIndex}
                  isLoading={isLoading}
                  isLastMessage={index === filteredMessages.length - 1}
                  isCopied={copiedMessageId === m.id}
                  myVote={votedMessages[m.id] ?? null}
                  ttsActiveMessageId={ttsActiveMessageId}
                  ttsPlaybackState={ttsPlaybackState}
                  chatId={chatId}
                  voiceAgentState={voiceAgentState}
                  handleFaceLayout={handleFaceLayout}
                  handleCopyMessage={handleCopyMessage}
                  handleVote={handleVote}
                  readAloud={readAloud}
                  generateAudio={generateAudio}
                  audioGenActiveMessageId={audioGenActiveMessageId}
                  audioGenState={audioGenState}
                  openThoughtPanel={openThoughtPanel}
                  onStartEdit={onStartEdit}
                  onApprovePlan={onApprovePlan}
                  onRejectPlan={onRejectPlan}
                />
              );
            })}
          </View>

          {/* Agent execution — in-progress card or completed result card */}
          {agentActivity && agentActivity.eventCount > 0 && (
            agentActivity.isComplete && agentSessionId ? (
              <AgentResultCard
                activity={agentActivity}
                sessionId={agentSessionId}
              />
            ) : (
              <AgentTaskCard activity={agentActivity} />
            )
          )}

          {/* Standalone ThinkingIndicator for voice mode — shows when AI is thinking
              but there's no pending assistant message yet (e.g. right after user speaks) */}
          {voiceAgentState === 'thinking' &&
            !isLoading &&
            (messages.length === 0 || messages[messages.length - 1]?.role !== 'assistant') && (
              <ThinkingIndicator isWorking={false} />
            )}
        </View>
      </KeyboardAwareScrollView>
    );
});
