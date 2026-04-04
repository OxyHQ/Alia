import { View, Pressable, StyleSheet, Platform } from "react-native";
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
import { ThinkingIndicator } from '@/lib/sdk';
import { Copy, ThumbsUp, ThumbsDown, Pencil, Check } from "lucide-react-native";
import * as DropdownMenu from "@/components/ui/dropdown-menu";
import Animated, {
  FadeInUp,
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  cancelAnimation,
} from "react-native-reanimated";
import * as Clipboard from "expo-clipboard";
import { Reasoning, ReasoningTrigger } from "@/components/ui/reasoning";
import { getToolLabel, getToolActiveLabel, getResearchActiveLabel, getTextFromContent, getImagesFromContent } from '@/lib/sdk';
import { useUIStore } from "@/lib/stores/ui-store";
import { useStore } from "@/lib/globalStore";
import type { ToolInvocation } from "@/lib/types/messages";
import { useScrollToBottom } from "@/hooks/use-scroll-to-bottom";
import { ResearchProgressCard } from '@/lib/sdk';
import type { ResearchProgress as ResearchProgressData } from '@/lib/sdk';
import { Skeleton } from "@/components/ui/skeleton";
import apiClient from "@/lib/api/client";
import { useTranslation } from "@/hooks/useTranslation";

const isWeb = Platform.OS === "web";

type MessagePart = {
  type: string;
  text?: string;
  [key: string]: any;
};

type Message = {
  id: string;
  role: "user" | "assistant" | "system" | "function" | "data" | "tool";
  content?: string | Array<{ type: string; [key: string]: any }>;
  thinking?: string;
  parts?: MessagePart[];
  toolInvocations?: ToolInvocation[];
  source?: 'text' | 'voice';
  speaker?: 'primary' | 'cohost';
  isStreaming?: boolean;
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
  onAtBottomChange?: (isAtBottom: boolean) => void;
};

function isClarityMessage(m: Message): boolean {
  return m.role === "assistant";
}

function getMessageText(message: Message): string {
  let rawText = '';
  if (message.content) {
    rawText = getTextFromContent(message.content);
  } else if (message.parts && Array.isArray(message.parts)) {
    rawText = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text || "")
      .join("");
  }
  const processed = processMessage(rawText, 'app');
  return processed.text;
}

function getMessageImages(message: Message): string[] {
  if (message.content) {
    return getImagesFromContent(message.content);
  }
  return [];
}

/** Pulsing bullet for tool execution status. */
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
      <Text style={{ color: isRunning ? '#eab308' : '#22c55e', fontSize: 10 }}>{'●'}</Text>
    </Animated.View>
  );
});

type MessageRowProps = {
  m: Message;
  index: number;
  isNewMessage: boolean;
  isAssistant: boolean;
  isLoading?: boolean;
  isLastMessage: boolean;
  isCopied: boolean;
  myVote: 'up' | 'down' | null;
  chatId: any;
  handleCopyMessage: (messageId: string, content: string) => void;
  handleVote: (messageId: string, vote: 'up' | 'down') => void;
  openThoughtPanel: (messageId: string) => void;
  onStartEdit?: (messageId: string, content: string) => void;
};

const MessageRow = React.memo(function MessageRow({
  m, index, isNewMessage, isAssistant,
  isLoading, isLastMessage, isCopied, myVote, chatId,
  handleCopyMessage, handleVote, openThoughtPanel, onStartEdit,
}: MessageRowProps) {
  const messageText = getMessageText(m);
  const messageImages = getMessageImages(m);

  return (
    <Animated.View
      key={m.id || `msg-${index}`}
      entering={isNewMessage ? FadeInUp.springify() : undefined}
    >
      {/* Tool Invocations -- search source indicators */}
      {m.toolInvocations?.map((t, ti) => {
        const key = t.toolCallId || `tool-${m.id}-${ti}`;
        const toolLabel = getToolLabel(t.toolName);
        const isRunning = t.state === 'call' || t.state === 'partial-call';

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
              {description ? <Text className="text-muted-foreground"> {description}</Text> : null}
            </Text>
          </Pressable>
        );
      })}

      {/* Deep Research Progress */}
      {m.role === "assistant" && (m as any).researchProgress && (
        <ResearchProgressCard progress={(m as any).researchProgress as ResearchProgressData} />
      )}

      {/* Thinking / Reasoning */}
      {m.role === "assistant" && (m as any).thinking && (
        <View key="thinking-content" className="mb-3 w-full">
          <Reasoning isStreaming={isLoading && isLastMessage && !messageText}>
            <ReasoningTrigger onPress={() => openThoughtPanel(m.id)} />
          </Reasoning>
        </View>
      )}

      {/* Message Content */}
      {(messageText.length > 0 || messageImages.length > 0 || (m as any).isStreaming) && (
        <View key="message-content" className={cn("w-full", m.role === "user" && "mt-2")}>
          {m.role === "assistant" ? (
            <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
            <Pressable className="group">
            <View className="flex-col items-start">
              <View className="w-full">
                <CustomMarkdown content={messageText} />
              </View>
              {/* Action buttons -- web hover */}
              {isWeb && (
              <View className="flex-row gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                <Pressable key="copy" className="p-1.5 rounded-lg hover:bg-muted active:bg-muted"
                  onPress={() => handleCopyMessage(m.id, messageText)}>
                  {isCopied ? <Check size={14} className="text-green-500" /> : <Copy size={14} className="text-muted-foreground" />}
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
            // User message bubble
            <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
            <Pressable className="group">
            <View className="flex-col items-end gap-0.5">
                <View className="max-w-[85%] sm:max-w-[75%] rounded-[24px] overflow-hidden border border-border">
                  <BlurView intensity={60} tint="default" style={StyleSheet.absoluteFill} />
                  <View className="px-4 py-2">
                    {messageImages.length > 0 && (
                      <View className="flex-row flex-wrap gap-2 mb-2">
                        {messageImages.map((imgUrl, imgIdx) => (
                          <View key={`img-${imgIdx}`} className="rounded-xl overflow-hidden" style={imageThumbStyle}>
                            <Image source={{ uri: imgUrl }} className="w-full h-full" contentFit="cover" />
                          </View>
                        ))}
                      </View>
                    )}
                    <Text className="text-base text-foreground leading-7">{messageText}</Text>
                  </View>
                </View>
              {isWeb && (
                <View className="flex-row gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                  <Pressable key="copy" className="p-1.5 rounded-lg hover:bg-muted active:bg-muted"
                    onPress={() => handleCopyMessage(m.id, messageText)}>
                    {isCopied ? <Check size={14} className="text-green-500" /> : <Copy size={14} className="text-muted-foreground" />}
                  </Pressable>
                  <Pressable key="edit" className="p-1.5 rounded-lg hover:bg-muted active:bg-muted"
                    onPress={() => onStartEdit?.(m.id, messageText)}>
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

      {/* ThinkingIndicator -- shows when the last assistant message has no text yet */}
      {isLoading && m.role === "assistant" && isLastMessage && !messageText && (() => {
        const activeTool = m.toolInvocations?.find(t => t.state === 'call' || t.state === 'partial-call');
        const rp = (m as any).researchProgress;
        let activeStatus: string | undefined;
        if (activeTool) {
          activeStatus = getToolActiveLabel(activeTool.toolName);
        } else if (rp?.phase && rp.phase !== 'complete') {
          activeStatus = getResearchActiveLabel(rp.phase);
        } else if ((m as any).thinking) {
          activeStatus = "Reasoning...";
        }
        return <ThinkingIndicator isWorking={(m.toolInvocations?.length ?? 0) > 0} statusText={activeStatus} />;
      })()}
    </Animated.View>
  );
});

const imageThumbStyle = { width: 120, height: 120 };

export const ChatInterface = React.memo(function ChatInterface({
  messages, scrollViewRef, isLoading, conversationLoading,
  onSuggestionPress, onStartEdit, onCopyMessage,
  bottomPadding = 160, onAtBottomChange,
}: ChatInterfaceProps) {
  const { t } = useTranslation();
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [votedMessages, setVotedMessages] = useState<Record<string, 'up' | 'down'>>({});
  const voteInFlightRef = useRef<Set<string>>(new Set());
  const openThoughtPanel = useUIStore((s) => s.openThoughtPanel);
  const setThoughtMessages = useUIStore((s) => s.setThoughtMessages);
  const chatId = useStore(s => s.chatId);

  const { isAtBottom, onScroll, onContentSizeChange } = useScrollToBottom(scrollViewRef);

  useEffect(() => {
    onAtBottomChange?.(isAtBottom);
  }, [isAtBottom, onAtBottomChange]);

  const prevMessageCountRef = useRef(messages.length);
  useEffect(() => {
    prevMessageCountRef.current = messages.length;
  }, [messages.length]);

  const filteredMessages = useMemo(() => messages.filter(m => m != null && m.role), [messages]);

  // Sync messages to the UI store so ThoughtPanel can access them
  const rightPanel = useUIStore((s) => s.rightPanel);
  useEffect(() => {
    if (rightPanel === 'thought') {
      setThoughtMessages(messages as any);
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

  // Auto-scroll on new messages
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

        <View>
          {filteredMessages.map((m, index) => {
            const isAssistant = isClarityMessage(m);
            const isNewMessage = index >= prevMessageCountRef.current;

            return (
              <MessageRow
                key={m.id || `msg-${index}`}
                m={m}
                index={index}
                isNewMessage={isNewMessage}
                isAssistant={isAssistant}
                isLoading={isLoading}
                isLastMessage={index === filteredMessages.length - 1}
                isCopied={copiedMessageId === m.id}
                myVote={votedMessages[m.id] ?? null}
                chatId={chatId}
                handleCopyMessage={handleCopyMessage}
                handleVote={handleVote}
                openThoughtPanel={openThoughtPanel}
                onStartEdit={onStartEdit}
              />
            );
          })}
        </View>
      </View>
    </KeyboardAwareScrollView>
  );
});
