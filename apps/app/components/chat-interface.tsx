import { View, ScrollView, Pressable, TextInput } from "react-native";
import { Image } from "expo-image";
import { CustomMarkdown } from "@/components/ui/markdown";
import { Text } from "@/components/ui/text";
import { WelcomeMessage } from "@/components/welcome-message";
import React, { useEffect, useState } from "react";
import type { ScrollView as GHScrollView } from "react-native-gesture-handler";
import { processMessage } from "@/lib/message-processor";
import { cn } from "@/lib/utils";
import { LottieLoader } from "@/components/lottie-loader";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Bot, Copy, ThumbsUp, ThumbsDown, Pencil, Check } from "lucide-react-native";
import Animated, { FadeInUp } from "react-native-reanimated";
import * as Clipboard from "expo-clipboard";
import { Reasoning, ReasoningTrigger, ReasoningContent } from "@/components/ui/reasoning";
import { getToolIcon, getToolLabel } from "@/lib/tool-registry";

type ToolInvocation = {
  toolName: string;
  toolCallId: string;
  state: 'partial-call' | 'call' | 'result';
  args?: any;
  result?: any;
};

type MessagePart = {
  type: string;
  text?: string;
  [key: string]: any;
};

type Message = {
  id: string;
  role: "user" | "assistant" | "system" | "function" | "data" | "tool";
  content?: string;
  thinking?: string; // Extended thinking content
  parts?: MessagePart[];
  toolInvocations?: ToolInvocation[];
};

type ChatInterfaceProps = {
  messages: Message[];
  scrollViewRef: React.RefObject<GHScrollView>;
  isLoading?: boolean;
  onSuggestionPress?: (message: string) => void;
  onEditMessage?: (messageId: string, newContent: string) => void;
  onCopyMessage?: (content: string) => void;
};

// Helper function to extract and process text content for the app
function getMessageText(message: Message): string {
  let rawText = '';

  // Extract raw text from message
  if (message.content) {
    rawText = message.content;
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

export const ChatInterface = React.memo(function ChatInterface({ messages, scrollViewRef, isLoading, onSuggestionPress, onEditMessage, onCopyMessage }: ChatInterfaceProps) {
    const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
    const [editedContent, setEditedContent] = useState("");
    const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);

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
    }, [messages, isLoading, scrollViewRef]);

    const containerClassName = cn(
      "max-w-3xl mx-auto w-full",
      messages.length === 0 && "flex-1 justify-center"
    );

    return (
      <ScrollView
        ref={scrollViewRef}
        className="flex-1 bg-background px-4 py-4"
        contentContainerStyle={{ flexGrow: 1 }}
        showsVerticalScrollIndicator={false}
      >
        <View className={containerClassName}>
          {!messages.length && <WelcomeMessage onSuggestionPress={onSuggestionPress} />}

          <View className="gap-2">
            {messages.filter(m => m != null && m.role).map((m, index) => {
              const messageText = getMessageText(m);

              return (
                <Animated.View
                  key={m.id || `msg-${index}`}
                  entering={FadeInUp.delay(index * 50).springify()}
                >
                  {/* Tool Invocations */}
                  {m.toolInvocations?.map((t, ti) => {
                    const key = t.toolCallId || `tool-${m.id}-${ti}`;
                    const ToolIcon = getToolIcon(t.toolName);
                    const toolLabel = getToolLabel(t.toolName);

                    // Show loading state for calls
                    if (t.state === 'call' || t.state === 'partial-call') {
                      return (
                        <View
                          key={key}
                          className="mb-2 flex-row items-center justify-start"
                        >
                          <View className="rounded-full bg-muted/50 px-3 py-1.5 flex-row items-center gap-1.5">
                            <LottieLoader width={14} height={14} />
                            <ToolIcon size={12} className="text-muted-foreground" />
                            <Text className="text-xs text-muted-foreground">
                              {toolLabel}
                              {t.args?.query ? `: ${t.args.query.substring(0, 30)}${t.args.query.length > 30 ? '...' : ''}` : ''}
                              {t.args?.url ? `: ${t.args.url.substring(0, 30)}${t.args.url.length > 30 ? '...' : ''}` : ''}
                            </Text>
                          </View>
                        </View>
                      );
                    }

                    // Show completed state (result is embedded in text)
                    if (t.state === 'result') {
                      return (
                        <View
                          key={key}
                          className="mb-2 flex-row items-center justify-start"
                        >
                          <View className="rounded-full bg-primary/10 border border-primary/20 px-3 py-1.5 flex-row items-center gap-1.5">
                            <ToolIcon size={12} className="text-primary" />
                            <Text className="text-xs font-medium text-primary">
                              {toolLabel}
                            </Text>
                          </View>
                        </View>
                      );
                    }

                    return null;
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
                        <ReasoningTrigger />
                        <ReasoningContent>{(m as any).thinking}</ReasoningContent>
                      </Reasoning>
                    </View>
                  )}

                  {/* Message Content */}
                  {messageText.length > 0 && (
                    <View key="message-content" className="w-full">
                      {m.role === "assistant" ? (
                        // Assistant message: logo on top, text below
                        <View className="flex-col items-start gap-0.5">
                          <Image
                            source={require("@/assets/images/logo.png")}
                            style={{ width: 48, height: 20 }}
                            contentFit="contain"
                          />
                          <View className="w-full">
                            <CustomMarkdown content={messageText} />
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

                  {/* Loading Indicator */}
                  {isLoading &&
                    messages[messages.length - 1]?.role === "user" &&
                    m === messages[messages.length - 1] && (
                      <View key="loading-indicator" className="mt-4 flex-row items-start gap-2">
                        <Avatar className="h-8 w-8">
                          <AvatarFallback className="bg-primary/10">
                            <Bot size={16} className="text-primary" />
                          </AvatarFallback>
                        </Avatar>
                        <View className="rounded-2xl bg-muted px-4 py-3">
                          <LottieLoader width={40} height={40} />
                        </View>
                      </View>
                    )}
                </Animated.View>
              );
            })}
          </View>
        </View>
      </ScrollView>
    );
});
