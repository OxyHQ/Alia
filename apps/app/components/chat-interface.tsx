import { View, ScrollView } from "react-native";
import { CustomMarkdown } from "@/components/ui/markdown";
import { Text } from "@/components/ui/text";
import WeatherCard from "@/components/weather";
import { WelcomeMessage } from "@/components/welcome-message";
import React, { forwardRef } from "react";
import { cn } from "@/lib/utils";
import { LottieLoader } from "@/components/lottie-loader";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Bot, User, Search, Link, Calendar, Database, Globe } from "lucide-react-native";
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
    return (
      <ScrollView
        ref={ref}
        className="flex-1 bg-background px-4 py-6"
        contentContainerStyle={{ flexGrow: 1 }}
        showsVerticalScrollIndicator={false}
      >
        <View className="max-w-3xl mx-auto w-full">
          {!messages.length && <WelcomeMessage onSuggestionPress={onSuggestionPress} />}

          <View className="gap-6">
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
                          className="mb-4 flex-row items-start gap-2"
                        >
                          <Avatar className="h-8 w-8">
                            <AvatarFallback className="bg-primary/10">
                              <Bot size={16} className="text-primary" />
                            </AvatarFallback>
                          </Avatar>
                          <View className="flex-1 rounded-2xl bg-muted/50 p-4">
                            <View className="flex-row items-center gap-2">
                              <LottieLoader width={20} height={20} />
                              <ToolIcon size={16} className="text-muted-foreground" />
                              <Text className="text-sm text-muted-foreground">
                                {toolLabel}
                                {t.args?.query ? `: ${t.args.query}` : ''}
                                {t.args?.url ? `: ${t.args.url}` : ''}
                              </Text>
                            </View>
                          </View>
                        </View>
                      );
                    }

                    // Show completed state (result is embedded in text)
                    if (t.state === 'result') {
                      return (
                        <View
                          key={t.toolCallId}
                          className="mb-4 flex-row items-start gap-2"
                        >
                          <Avatar className="h-8 w-8">
                            <AvatarFallback className="bg-primary/10">
                              <Bot size={16} className="text-primary" />
                            </AvatarFallback>
                          </Avatar>
                          <View className="flex-1 rounded-2xl bg-primary/5 border border-primary/20 p-4">
                            <View className="flex-row items-center gap-2">
                              <ToolIcon size={16} className="text-primary" />
                              <Text className="text-sm font-medium text-foreground">
                                {toolLabel} completed
                              </Text>
                            </View>
                          </View>
                        </View>
                      );
                    }

                    return null;
                  })}

                  {/* Message Content */}
                  {messageText.length > 0 && (
                    <View
                      className={cn(
                        "flex-row gap-2",
                        m.role === "user" ? "justify-end" : "justify-start"
                      )}
                    >
                      {m.role === "assistant" && (
                        <Avatar className="h-8 w-8 mt-1">
                          <AvatarFallback className="bg-primary/10">
                            <Bot size={16} className="text-primary" />
                          </AvatarFallback>
                        </Avatar>
                      )}

                      <View
                        className={cn(
                          "max-w-[85%] sm:max-w-[75%] rounded-[24px] px-5 py-2.5",
                          m.role === "user"
                            ? "bg-muted"
                            : "bg-background border border-border"
                        )}
                      >
                        {m.role === "user" ? (
                          <Text className="text-base text-primary leading-6">
                            {messageText}
                          </Text>
                        ) : (
                          <CustomMarkdown content={messageText} />
                        )}
                      </View>

                      {m.role === "user" && (
                        <Avatar className="h-8 w-8 mt-1">
                          <AvatarFallback className="bg-primary">
                            <User size={16} className="text-primary-foreground" />
                          </AvatarFallback>
                        </Avatar>
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
