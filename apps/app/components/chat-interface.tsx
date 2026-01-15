import { View, ScrollView, Pressable, Image } from "react-native";
import { CustomMarkdown } from "@/components/ui/markdown";
import { Text } from "@/components/ui/text";
import WeatherCard from "@/components/weather";
import { WelcomeMessage } from "@/components/welcome-message";
import React, { forwardRef, useEffect } from "react";
import { cn } from "@/lib/utils";
import { LottieLoader } from "@/components/lottie-loader";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Bot, Search, Link, Calendar, Database, Globe, Copy, ThumbsUp, ThumbsDown, Pencil } from "lucide-react-native";
import Animated, { FadeInUp } from "react-native-reanimated";

type ToolInvocation = {
  toolName: string;
  toolCallId: string;
  state: 'partial-call' | 'call' | 'result';
  args?: any;
  result?: any;
};

// Tool icon mapping
const TOOL_ICONS: Record<string, any> = {
  googleSearch: Search,
  scrapeURL: Link,
  getTimeline: Calendar,
  searchKnowledgeBase: Database,
  getCurrentDate: Calendar,
};

// Tool name labels
const TOOL_LABELS: Record<string, string> = {
  googleSearch: 'Searching the web',
  scrapeURL: 'Reading URL',
  getTimeline: 'Getting timeline',
  searchKnowledgeBase: 'Searching knowledge base',
  getCurrentDate: 'Getting current date',
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
  parts?: MessagePart[];
  toolInvocations?: ToolInvocation[];
};

type ChatInterfaceProps = {
  messages: Message[];
  scrollViewRef: React.RefObject<ScrollView>;
  isLoading?: boolean;
  onSuggestionPress?: (message: string) => void;
};

// Helper function to extract text content from a message
function getMessageText(message: Message): string {
  // If message has content string, use it
  if (message.content) return message.content;

  // If message has parts array, extract text from parts
  if (message.parts && Array.isArray(message.parts)) {
    return message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text || "")
      .join("");
  }

  return "";
}

export const ChatInterface = forwardRef<ScrollView, ChatInterfaceProps>(
  ({ messages, scrollViewRef, isLoading, onSuggestionPress }, ref) => {
    // Auto-scroll to bottom when messages change or during streaming
    useEffect(() => {
      // Scroll whenever messages change or loading state changes
      const timer = setTimeout(() => {
        if (ref && 'current' in ref && ref.current) {
          ref.current.scrollToEnd({ animated: true });
        }
      }, 150);
      return () => clearTimeout(timer);
    }, [messages, isLoading, ref]);

    // Also scroll when messages length changes (user sends message)
    useEffect(() => {
      if (messages.length > 0) {
        const timer = setTimeout(() => {
          if (ref && 'current' in ref && ref.current) {
            ref.current.scrollToEnd({ animated: true });
          }
        }, 200);
        return () => clearTimeout(timer);
      }
    }, [messages.length, ref]);

    const containerClassName = cn(
      "max-w-3xl mx-auto w-full",
      messages.length === 0 && "flex-1 justify-center"
    );

    return (
      <ScrollView
        ref={ref}
        className="flex-1 bg-background px-4 py-6"
        contentContainerStyle={{ flexGrow: 1 }}
        showsVerticalScrollIndicator={false}
      >
        <View className={containerClassName}>
          {!messages.length && <WelcomeMessage onSuggestionPress={onSuggestionPress} />}

          <View className="gap-3">
            {messages.map((m, index) => {
              const messageText = getMessageText(m);

              return (
                <Animated.View
                  key={m.id}
                  entering={FadeInUp.delay(index * 50).springify()}
                >
                  {/* Tool Invocations */}
                  {m.toolInvocations?.map((t) => {
                    const ToolIcon = TOOL_ICONS[t.toolName] || Globe;
                    const toolLabel = TOOL_LABELS[t.toolName] || t.toolName;

                    // Show loading state for calls
                    if (t.state === 'call' || t.state === 'partial-call') {
                      return (
                        <View
                          key={t.toolCallId}
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
                          key={t.toolCallId}
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

                  {/* Message Content */}
                  {messageText.length > 0 && (
                    <View className="w-full">
                      {m.role === "assistant" ? (
                        // Assistant message: logo on top, text below
                        <View className="flex-col items-start gap-0.5">
                          <Image
                            source={require("@/assets/images/logo.png")}
                            style={{ width: 48, height: 20 }}
                            resizeMode="contain"
                          />
                          <View className="w-full">
                            <CustomMarkdown content={messageText} />
                          </View>
                          {/* Action Buttons for Assistant Messages */}
                          <View className="flex-row gap-1">
                            <Pressable className="p-1.5 rounded-lg hover:bg-muted active:bg-muted">
                              <Copy size={14} className="text-muted-foreground" />
                            </Pressable>
                            <Pressable className="p-1.5 rounded-lg hover:bg-muted active:bg-muted">
                              <ThumbsUp size={14} className="text-muted-foreground" />
                            </Pressable>
                            <Pressable className="p-1.5 rounded-lg hover:bg-muted active:bg-muted">
                              <ThumbsDown size={14} className="text-muted-foreground" />
                            </Pressable>
                          </View>
                        </View>
                      ) : (
                        // User message: bubble only
                        <View className="flex-col items-end gap-0.5">
                          <View className="max-w-[85%] sm:max-w-[75%] rounded-[24px] px-5 py-2.5 bg-muted">
                            <Text className="text-base text-foreground leading-7">
                              {messageText}
                            </Text>
                          </View>
                          {/* Action Buttons for User Messages */}
                          <View className="flex-row gap-1">
                            <Pressable className="p-1.5 rounded-lg hover:bg-muted active:bg-muted">
                              <Copy size={14} className="text-muted-foreground" />
                            </Pressable>
                            <Pressable className="p-1.5 rounded-lg hover:bg-muted active:bg-muted">
                              <Pencil size={14} className="text-muted-foreground" />
                            </Pressable>
                          </View>
                        </View>
                      )}
                    </View>
                  )}

                  {/* Loading Indicator */}
                  {isLoading &&
                    messages[messages.length - 1]?.role === "user" &&
                    m === messages[messages.length - 1] && (
                      <View className="mt-4 flex-row items-start gap-2">
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
  }
);

ChatInterface.displayName = "ChatInterface";
