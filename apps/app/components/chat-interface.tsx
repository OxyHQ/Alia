import { View, Pressable, TextInput } from "react-native";
import { KeyboardAwareScrollView } from "@/lib/keyboard";
import { Image } from "expo-image";
import { CustomMarkdown } from "@/components/ui/markdown";
import { Text } from "@/components/ui/text";
import { WelcomeMessage } from "@/components/welcome-message";
import React, { useEffect, useState, useCallback } from "react";
import type { ScrollView as GHScrollView } from "react-native-gesture-handler";
import { processMessage } from "@/lib/message-processor";
import { cn } from "@/lib/utils";
import { ThinkingIndicator } from "@/components/thinking-indicator";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Copy, ThumbsUp, ThumbsDown, Pencil, Check } from "lucide-react-native";
import Animated, {
  FadeInUp,
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import * as Clipboard from "expo-clipboard";
import { Reasoning, ReasoningTrigger } from "@/components/ui/reasoning";
import { getToolLabel } from "@/lib/tool-registry";
import { getTextFromContent, getImagesFromContent } from "@/lib/attachment-utils";
import { useUIStore } from "@/lib/stores/ui-store";
import type { ToolInvocation } from "@/lib/types/messages";
import { useScrollToBottom } from "@/hooks/use-scroll-to-bottom";

type MessagePart = {
  type: string;
  text?: string;
  [key: string]: any;
};

type Message = {
  id: string;
  role: "user" | "assistant" | "system" | "function" | "data" | "tool";
  content?: string | Array<{ type: string; [key: string]: any }>;
  thinking?: string; // Extended thinking content
  parts?: MessagePart[];
  toolInvocations?: ToolInvocation[];
  // Voice fields
  source?: 'text' | 'voice';
  speaker?: 'primary' | 'cohost';
  isStreaming?: boolean;
  // Agent delegation metadata
  agentInfo?: {
    id: string;
    name: string;
    avatar: string | null;
    handle: string;
  };
};

type ChatInterfaceProps = {
  messages: Message[];
  scrollViewRef: React.RefObject<GHScrollView>;
  isLoading?: boolean;
  onSuggestionPress?: (message: string) => void;
  onEditMessage?: (messageId: string, newContent: string) => void;
  onCopyMessage?: (content: string) => void;
  bottomPadding?: number;
  isVoiceActive?: boolean;
  voiceAgentState?: 'idle' | 'listening' | 'thinking' | 'speaking';
  onAtBottomChange?: (isAtBottom: boolean) => void;
};

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
function ToolBullet({ isRunning }: { isRunning: boolean }) {
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
      opacity.value = 1;
    }
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
}

export const ChatInterface = React.memo(function ChatInterface({ messages, scrollViewRef, isLoading, onSuggestionPress, onEditMessage, onCopyMessage, bottomPadding = 160, isVoiceActive = false, voiceAgentState, onAtBottomChange }: ChatInterfaceProps) {
    const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
    const [editedContent, setEditedContent] = useState("");
    const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
    const openThoughtPanel = useUIStore((s) => s.openThoughtPanel);
    const setThoughtMessages = useUIStore((s) => s.setThoughtMessages);

    const { isAtBottom, onScroll, onContentSizeChange } = useScrollToBottom(scrollViewRef);

    useEffect(() => {
      onAtBottomChange?.(isAtBottom);
    }, [isAtBottom, onAtBottomChange]);

    // Sync messages to the UI store so ThoughtPanel (a sibling in the layout tree) can access them
    useEffect(() => {
      setThoughtMessages(messages as any);
    }, [messages, setThoughtMessages]);

    const handleCopyMessage = async (messageId: string, content: string) => {
      await Clipboard.setStringAsync(content);
      setCopiedMessageId(messageId);
      setTimeout(() => setCopiedMessageId(null), 2000);
      if (onCopyMessage) {
        onCopyMessage(content);
      }
    };

    const handleStartEdit = (messageId: string, content: string) => {
      setEditingMessageId(messageId);
      setEditedContent(content);
    };

    const handleSaveEdit = (messageId: string) => {
      if (onEditMessage && editedContent.trim()) {
        onEditMessage(messageId, editedContent);
      }
      setEditingMessageId(null);
      setEditedContent("");
    };

    const handleCancelEdit = () => {
      setEditingMessageId(null);
      setEditedContent("");
    };
    // Auto-scroll to bottom when messages change or during streaming
    useEffect(() => {
      // Scroll whenever messages change or loading state changes
      const timer = setTimeout(() => {
        if (scrollViewRef && scrollViewRef.current) {
          scrollViewRef.current.scrollToEnd({ animated: true });
        }
      }, 100);
      return () => clearTimeout(timer);
    }, [messages, isLoading, scrollViewRef, bottomPadding]);

    const containerClassName = cn(
      "max-w-3xl mx-auto w-full",
      messages.length === 0 && "flex-1 justify-center"
    );

    return (
      <KeyboardAwareScrollView
        ref={scrollViewRef}
        bottomOffset={60}
        className="flex-1 bg-background px-4 py-4"
        contentContainerStyle={{ flexGrow: 1, paddingTop: 60, paddingBottom: bottomPadding }}
        showsVerticalScrollIndicator={false}
        onScroll={onScroll}
        scrollEventThrottle={16}
        onContentSizeChange={onContentSizeChange}
      >
        <View className={containerClassName}>
          {!messages.length && <WelcomeMessage onSuggestionPress={onSuggestionPress} />}

          <View className="gap-2">
            {messages.filter(m => m != null && m.role).map((m, index) => {
              const messageText = getMessageText(m);
              const messageImages = getMessageImages(m);

              return (
                <Animated.View
                  key={m.id || `msg-${index}`}
                  entering={FadeInUp.delay(index * 50).springify()}
                >
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

                  {/* Thinking Content (Extended Thinking Mode) */}
                  {m.role === "assistant" && (m as any).thinking && (
                    <View key="thinking-content" className="mb-3 w-full">
                      <Reasoning
                        isStreaming={
                          isLoading &&
                          m.id === messages[messages.length - 1]?.id &&
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
                  {(messageText.length > 0 || messageImages.length > 0 || (m as any).isStreaming) && (
                    <View key="message-content" className="w-full">
                      {m.role === "assistant" ? (
                        // Assistant message: logo on top, text below
                        <View className="flex-col items-start gap-0.5">
                          {/* Agent identity, cohost label, or Alia logo */}
                          {m.agentInfo ? (
                            <View className="flex-row items-center gap-2 mb-0.5">
                              {m.agentInfo.avatar ? (
                                <Image
                                  source={{ uri: m.agentInfo.avatar }}
                                  style={{ width: 20, height: 20, borderRadius: 10 }}
                                />
                              ) : (
                                <Avatar className="h-5 w-5">
                                  <AvatarFallback className="text-[10px]">
                                    {m.agentInfo.name.charAt(0).toUpperCase()}
                                  </AvatarFallback>
                                </Avatar>
                              )}
                              <Text className="text-xs font-semibold" style={{ color: '#f97316' }}>
                                {m.agentInfo.name}
                              </Text>
                            </View>
                          ) : (m as any).source === 'voice' && (m as any).speaker === 'cohost' ? (
                            <Text className="text-xs text-indigo-400 mb-0.5">Cohost</Text>
                          ) : (
                            <Image
                              source={require("@/assets/images/logo.png")}
                              style={{ width: 48, height: 20 }}
                              contentFit="contain"
                            />
                          )}
                          <View className="w-full">
                            {(m as any).source === 'voice' ? (
                              <Text className="text-base text-foreground leading-7">
                                {messageText}
                                {(m as any).isStreaming ? '\u258C' : ''}
                              </Text>
                            ) : (
                              <CustomMarkdown content={messageText} />
                            )}
                          </View>
                          {/* Action Buttons for Assistant Messages */}
                          <View className="flex-row gap-1">
                            <Pressable
                              key="copy"
                              className="p-1.5 rounded-lg hover:bg-muted active:bg-muted"
                              onPress={() => handleCopyMessage(m.id, messageText)}
                            >
                              {copiedMessageId === m.id ? (
                                <Check size={14} className="text-green-500" />
                              ) : (
                                <Copy size={14} className="text-muted-foreground" />
                              )}
                            </Pressable>
                            <Pressable key="thumbs-up" className="p-1.5 rounded-lg hover:bg-muted active:bg-muted">
                              <ThumbsUp size={14} className="text-muted-foreground" />
                            </Pressable>
                            <Pressable key="thumbs-down" className="p-1.5 rounded-lg hover:bg-muted active:bg-muted">
                              <ThumbsDown size={14} className="text-muted-foreground" />
                            </Pressable>
                          </View>
                        </View>
                      ) : (
                        // User message: bubble only
                        <View className="flex-col items-end gap-0.5">
                          {editingMessageId === m.id ? (
                            <View className="max-w-[85%] sm:max-w-[75%] rounded-[24px] px-5 py-2.5 bg-muted">
                              <TextInput
                                value={editedContent}
                                onChangeText={setEditedContent}
                                multiline
                                className="text-base text-foreground leading-7"
                                autoFocus
                              />
                              <View className="flex-row gap-2 mt-2">
                                <Pressable
                                  className="px-3 py-1.5 rounded-lg bg-primary"
                                  onPress={() => handleSaveEdit(m.id)}
                                >
                                  <Text className="text-xs text-primary-foreground">Save</Text>
                                </Pressable>
                                <Pressable
                                  className="px-3 py-1.5 rounded-lg bg-muted-foreground"
                                  onPress={handleCancelEdit}
                                >
                                  <Text className="text-xs text-background">Cancel</Text>
                                </Pressable>
                              </View>
                            </View>
                          ) : (
                            <View className="max-w-[85%] sm:max-w-[75%] rounded-[24px] px-5 py-2.5 bg-muted">
                              {/* Inline images from multi-part content */}
                              {messageImages.length > 0 && (
                                <View className="flex-row flex-wrap gap-2 mb-2">
                                  {messageImages.map((imgUrl, imgIdx) => (
                                    <View key={`img-${imgIdx}`} className="rounded-xl overflow-hidden" style={{ width: 120, height: 120 }}>
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
                          )}
                          {/* Action Buttons for User Messages */}
                          {editingMessageId !== m.id && (
                            <View className="flex-row gap-1">
                              <Pressable
                                key="copy"
                                className="p-1.5 rounded-lg hover:bg-muted active:bg-muted"
                                onPress={() => handleCopyMessage(m.id, messageText)}
                              >
                                {copiedMessageId === m.id ? (
                                  <Check size={14} className="text-green-500" />
                                ) : (
                                  <Copy size={14} className="text-muted-foreground" />
                                )}
                              </Pressable>
                              <Pressable
                                key="edit"
                                className="p-1.5 rounded-lg hover:bg-muted active:bg-muted"
                                onPress={() => handleStartEdit(m.id, messageText)}
                              >
                                <Pencil size={14} className="text-muted-foreground" />
                              </Pressable>
                            </View>
                          )}
                        </View>
                      )}
                    </View>
                  )}

                  {/* ThinkingIndicator — shows when the last assistant message has no text yet */}
                  {(isLoading || voiceAgentState === 'thinking') &&
                    m.role === "assistant" &&
                    m === messages[messages.length - 1] &&
                    !getMessageText(m) && (
                      <ThinkingIndicator
                        isWorking={
                          (m.toolInvocations?.length ?? 0) > 0
                        }
                      />
                    )}
                </Animated.View>
              );
            })}
          </View>

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
