import { View, Pressable, StyleSheet, Platform, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { toast } from "@oxyhq/bloom/toast";
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
import { ThinkingIndicator, AliaMark, type AliaMarkState } from '@alia.onl/sdk';
import { useColorScheme } from "@/lib/useColorScheme";
import { AgentGlyph } from "@/components/ui/agent-glyph";
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
import { useTheme } from "@oxyhq/bloom/theme";
import { getToolLabel, getToolActiveLabel, getResearchActiveLabel, getTextFromContent, getImagesFromContent } from '@alia.onl/sdk';
import { useUIStore } from "@/lib/stores/ui-store";
import { useStore, type ChatIdState } from "@/lib/stores/global-store";
import type { ToolInvocation } from "@/lib/types/messages";
import type { Message as ConversationMessage } from "@/lib/hooks/use-conversations";
import { AgentTaskCard } from "@/components/agent-task-card";
import { AgentResultCard } from "@/components/agent-result-card";
import { ResearchProgressCard, PlanPreviewCard } from '@alia.onl/sdk';
import type { ResearchProgress as ResearchProgressData } from '@alia.onl/sdk';
import type { AgentActivityState } from "@/lib/hooks/use-agent-activity";
import { Skeleton } from "@/components/ui/skeleton";
import apiClient from "@/lib/api/client";
import { useTranslation } from "@/lib/hooks/use-translation";
import { NewConversationOffer } from "@/components/new-conversation-offer";
import { daySeparators } from "@/lib/message-days";
import { threadSeamIds, type ThreadMessage } from "@/lib/thread-history";

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
    color?: string | null;
    handle: string;
  };
  audioUrl?: string;
  /** When the message was written, ISO. Absent on a turn that has not been persisted yet. */
  createdAt?: string;
};

type ChatInterfaceProps = {
  messages: Message[];
  scrollViewRef: React.RefObject<GHScrollView | null>;
  isLoading?: boolean;
  conversationLoading?: boolean;
  onStartEdit?: (messageId: string, content: string) => void;
  onCopyMessage?: (content: string) => void;
  bottomPadding?: number;
  isVoiceActive?: boolean;
  voiceAgentState?: 'idle' | 'listening' | 'thinking' | 'speaking';
  onScroll?: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onContentSizeChange?: () => void;
  agentActivity?: AgentActivityState | null;
  agentSessionId?: string | null;
  onApprovePlan?: (planId: string) => void;
  onRejectPlan?: (planId: string) => void;
  /** The agent's reason for offering a fresh stretch, or `null` for no offer. */
  suggestedNewConversation?: string | null;
  onAcceptNewConversation?: () => void;
  onDismissNewConversation?: () => void;
  /**
   * Everything said in this thread before the conversation on screen, oldest
   * first. Empty on `/c/:id`, which is one conversation with nothing behind it.
   */
  historyMessages?: ThreadMessage[];
  /** A page of history is on its way; the reader is at the top waiting for it. */
  isLoadingHistory?: boolean;
  /**
   * How tall the history is, whenever that changes — the anchor that keeps the
   * reader on the message they were reading while a page lands above them.
   */
  onHistoryHeight?: (height: number) => void;
  /** The conversation being streamed into, which is what a seam is drawn against. */
  activeConversationId?: string;
  /**
   * The message a jump was aimed at, by cursor, or `null` at the present.
   *
   * A window is half before the hit and half after, so landing at its end —
   * which is what the follow-the-newest half does with any list — leaves the
   * reader twenty messages past the thing they searched for.
   */
  focusCursor?: string | null;
};

/**
 * The history of a conversation that has none, as ONE array.
 *
 * A fresh `[]` per render would be a new dependency every time, which is what
 * turns a memo on the message list into a memo that never holds — and this list
 * re-renders per streamed token.
 */
const NO_HISTORY: ThreadMessage[] = [];

/** True for Alia's own assistant messages (excludes delegated agents and voice cohosts). */
function isAliaOwnedMessage(m: Message): boolean {
  return (
    m.role === 'assistant' &&
    !m.agentInfo &&
    !(m.source === 'voice' && m.speaker === 'cohost')
  );
}

// Raw text extraction without the tag-stripping regex passes — cheap enough
// for per-flush presence/length checks during streaming.
function getRawMessageText(message: Message): string {
  if (message.content) {
    return getTextFromContent(message.content);
  }
  if (message.parts && Array.isArray(message.parts)) {
    return message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text || "")
      .join("");
  }
  return '';
}

// Helper function to extract and process text content for the app
function getMessageText(message: Message): string {
  // Process message for app platform (removes Telegram tags, keeps app components)
  const processed = processMessage(getRawMessageText(message), 'app');
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
  const { colors } = useTheme();
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
        style={{ color: isRunning ? colors.warning : colors.success, fontSize: 10 }}
      >
        ●
      </Text>
    </Animated.View>
  );
});

/**
 * The line between two days, Messenger-style.
 *
 * It takes the finished string, not a label to resolve: `t` is rebuilt on every
 * render of the hook that returns it, so a component taking it as a prop is a
 * memo that never holds — and this one is rendered inside a list that re-renders
 * per streamed token.
 */
/**
 * Where one conversation ended and the next began.
 *
 * A different line from the day one on purpose: a date is derived from when a
 * message was written, while this is a fact about the thread — the model was
 * given a fresh context here, and everything above is out of its sight. Drawing
 * them the same way would suggest a break happened every midnight.
 */
const ConversationSeam = React.memo(function ConversationSeam({ text }: { text: string }) {
  return (
    <View className="flex-row items-center gap-3 py-6">
      <View className="h-px flex-1 bg-border" />
      <Text className="text-xs font-medium text-muted-foreground">{text}</Text>
      <View className="h-px flex-1 bg-border" />
    </View>
  );
});

const DaySeparator = React.memo(function DaySeparator({ text }: { text: string }) {
  return (
    <View className="items-center py-4">
      <View className="rounded-full bg-muted px-3 py-1">
        <Text className="text-xs font-medium text-muted-foreground">{text}</Text>
      </View>
    </View>
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
  // Per-row TTS state: 'idle' unless this row is the active one. Passing the
  // raw activeMessageId + playbackState to every row re-renders all rows on a
  // playback transition; deriving per row keeps the memo for inactive rows.
  ttsState: string;
  chatId: ChatIdState;
  voiceAgentState?: 'idle' | 'listening' | 'thinking' | 'speaking';
  handleMarkLayout: (e: LayoutChangeEvent) => void;
  /** Where this row ended up, for the one row a jump is aimed at. */
  onRowLayout?: (e: LayoutChangeEvent) => void;
  handleCopyMessage: (messageId: string, content: string) => void;
  handleVote: (messageId: string, vote: 'up' | 'down', conversationId?: string) => void;
  readAloud: (id: string, text: string, chatId?: string, audioUrl?: string) => void;
  generateAudio: (messageId: string, prompt: string, conversationId?: string) => void;
  // Per-row audio-gen state: 'idle' unless this row is the active one (same
  // rationale as ttsState above).
  audioGenRowState: string;
  openThoughtPanel: (messageId: string) => void;
  onStartEdit?: (messageId: string, content: string) => void;
  onApprovePlan?: (planId: string) => void;
  onRejectPlan?: (planId: string) => void;
};

const MessageRow = React.memo(function MessageRow({
  m, index, isNewMessage, isAliaMessage, isLastAlia,
  isLoading, isLastMessage, isCopied, myVote,
  ttsState, chatId, voiceAgentState,
  handleMarkLayout, onRowLayout, handleCopyMessage, handleVote, readAloud,
  generateAudio, audioGenRowState,
  openThoughtPanel, onStartEdit, onApprovePlan, onRejectPlan,
}: MessageRowProps) {
  const { colors } = useColorScheme();
  const messageText = getMessageText(m);
  const messageImages = getMessageImages(m);

  return (
    <Animated.View
      key={m.id || `msg-${index}`}
      entering={isNewMessage ? FadeInUp.springify() : undefined}
      style={isAliaMessage && isLastAlia ? { paddingTop: 36 } : undefined}
      /**
       * Two things want this row's position and one element can report it: the
       * flying mark follows the last Alia message, and a jump aims at whichever
       * message was searched for. They coincide often enough to matter.
       */
      onLayout={
        isAliaMessage && isLastAlia
          ? (onRowLayout === undefined
              ? handleMarkLayout
              : (e: LayoutChangeEvent) => { handleMarkLayout(e); onRowLayout(e); })
          : onRowLayout
      }
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
                  <AgentGlyph size={20} color={m.agentInfo.color} label={m.agentInfo.name} />
                  <Text className="text-xs font-semibold text-foreground">
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
                  {ttsState === 'playing' || ttsState === 'paused' ? (
                    <Square size={14} className={ttsState === 'playing' ? "text-primary" : "text-muted-foreground"} />
                  ) : (
                    <Volume2 size={14} className={ttsState === 'loading' ? "text-primary opacity-50" : "text-muted-foreground"} />
                  )}
                </Pressable>
                <Pressable
                  key="generate-audio"
                  className="p-1.5 rounded-lg hover:bg-muted active:bg-muted"
                  onPress={() => generateAudio(m.id, messageText, chatId?.id)}
                >
                  {audioGenRowState === 'playing' ? (
                    <Square size={14} className="text-primary" />
                  ) : (
                    <Music size={14} className={audioGenRowState === 'generating' ? "text-primary opacity-50" : "text-muted-foreground"} />
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
                <Pressable key="thumbs-up" className="p-1.5 rounded-lg hover:bg-muted active:bg-muted" onPress={() => handleVote(m.id, 'up', chatId?.id)}>
                  <ThumbsUp size={14} className={myVote === 'up' ? "text-primary" : "text-muted-foreground"} />
                </Pressable>
                <Pressable key="thumbs-down" className="p-1.5 rounded-lg hover:bg-muted active:bg-muted" onPress={() => handleVote(m.id, 'down', chatId?.id)}>
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
              <DropdownMenu.Item key="thumbs-up" onSelect={() => handleVote(m.id, 'up', chatId?.id)}>
                <DropdownMenu.ItemIcon ios={{ name: "hand.thumbsup" }} />
                <DropdownMenu.ItemTitle>Like</DropdownMenu.ItemTitle>
              </DropdownMenu.Item>
              <DropdownMenu.Item key="thumbs-down" onSelect={() => handleVote(m.id, 'down', chatId?.id)}>
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
                <View className="max-w-[70%] rounded-[22px] overflow-hidden border border-border">
                  <BlurView intensity={60} tint="default" style={StyleSheet.absoluteFill} />
                  <View className="px-4 py-2.5">
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
                    <Text className="text-base text-foreground leading-6">
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
                  {/* Absent on a message from an earlier conversation. Editing
                      truncates the live thread at that message and re-sends —
                      and a message this screen is not streaming is not in that
                      list, so the truncation finds nothing and the "edit"
                      silently becomes a brand-new turn. */}
                  {onStartEdit === undefined ? null : (
                    <Pressable
                      key="edit"
                      className="p-1.5 rounded-lg hover:bg-muted active:bg-muted"
                      onPress={() => onStartEdit(m.id, messageText)}
                    >
                      <Pencil size={14} className="text-muted-foreground" />
                    </Pressable>
                  )}
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
              {onStartEdit === undefined ? null : (
                <DropdownMenu.Item key="edit" onSelect={() => onStartEdit(m.id, messageText)}>
                  <DropdownMenu.ItemIcon ios={{ name: "pencil" }} />
                  <DropdownMenu.ItemTitle>Edit</DropdownMenu.ItemTitle>
                </DropdownMenu.Item>
              )}
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
              color={colors.primary}
            />
          );
        })()}
    </Animated.View>
  );
});

const imageThumbStyle = { width: 120, height: 120 };

export const ChatInterface = React.memo(function ChatInterface({ messages, scrollViewRef, isLoading, conversationLoading, onStartEdit, onCopyMessage, bottomPadding = 160, isVoiceActive = false, voiceAgentState, onScroll, onContentSizeChange, agentActivity, agentSessionId, onApprovePlan, onRejectPlan, suggestedNewConversation, onAcceptNewConversation, onDismissNewConversation, historyMessages, isLoadingHistory = false, onHistoryHeight, activeConversationId, focusCursor }: ChatInterfaceProps) {
    const { t, locale } = useTranslation();
    const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
    const [votedMessages, setVotedMessages] = useState<Record<string, 'up' | 'down'>>({});
    const voteInFlightRef = useRef<Set<string>>(new Set());
    const openThoughtPanel = useUIStore((s) => s.openThoughtPanel);
    const setThoughtMessages = useUIStore((s) => s.setThoughtMessages);
    const { readAloud, activeMessageId: ttsActiveMessageId, playbackState: ttsPlaybackState } = useTTS();
    const { generateAudio, activeMessageId: audioGenActiveMessageId, state: audioGenState } = useAudioGen();
    const chatId = useStore(s => s.chatId);
    const { colors } = useColorScheme();

    // Track previous message count — only animate newly added messages
    const prevMessageCountRef = useRef(messages.length);
    useEffect(() => {
      prevMessageCountRef.current = messages.length;
    }, [messages.length]);

    // ── Flying AliaMark ──
    const markY = useSharedValue(0);

    const liveMessages = useMemo(() => messages.filter(m => m != null && m.role), [messages]);
    const history = historyMessages ?? NO_HISTORY;
    /**
     * Everything on screen, in reading order: the thread's history first, the
     * conversation being streamed into after it.
     *
     * Every position below — the separators, the flying mark, which row is
     * last — is an index into THIS, not into the live messages, which is why it
     * is built once here rather than concatenated at each use.
     */
    const filteredMessages = useMemo(
      () => (history.length === 0 ? liveMessages : [...history, ...liveMessages]),
      [history, liveMessages],
    );

    /**
     * The conversation each history message belongs to, as the id a row's own
     * actions address.
     *
     * A vote goes to `/conversations/:id/messages/:id/vote` and audio is cached
     * against a conversation, and both used to take the id of the stretch on
     * screen — right for a live message and wrong for every history one, which
     * belongs to a conversation that ended. It would have written to a
     * conversation that does not contain the message, and failed quietly.
     *
     * One entry per conversation rather than per message: these are props of a
     * memoized row, so a fresh object per row would re-render every one of them
     * on every streamed token.
     */
    const historyChatIds = useMemo(() => {
      const byConversation = new Map<string, ChatIdState>();
      for (const message of history) {
        if (byConversation.has(message.conversationId)) continue;
        byConversation.set(message.conversationId, { id: message.conversationId, from: 'url' });
      }
      return byConversation;
    }, [history]);

    /**
     * Which messages begin a new conversation, deduced from the data rather
     * than from how long the gap was. Empty on `/c/:id`, which is one
     * conversation and therefore has no seams.
     */
    const seamIds = useMemo(
      () => threadSeamIds(history, liveMessages, activeConversationId ?? ''),
      [history, liveMessages, activeConversationId],
    );

    /**
     * Where the thread changes day, as the finished line, keyed by the message
     * each one sits above.
     *
     * `new Date()` is read here rather than passed in because "today" is a fact
     * about when the list is being LOOKED at. It is re-read whenever the list
     * changes, which is what relabels a thread left open across midnight on the
     * next message rather than on a timer nobody needs.
     *
     * Keyed on `locale`, not on `t`: `useTranslation` builds a new `t` on every
     * render, so depending on it would recompute this per streamed token, and
     * `i18n.t` reads the locale this depends on at call time anyway.
     */
    const separatorsByMessage = useMemo(() => {
      const separators = daySeparators(filteredMessages, new Date(), locale);
      return new Map(separators.map(({ messageId, label }) => [
        messageId,
        label.kind === 'date' ? label.text : t(`chat.${label.kind}`),
      ]));
    }, [filteredMessages, locale]);
    const lastAliaIndex = useMemo(() => filteredMessages.reduce((acc, m, i) =>
      isAliaOwnedMessage(m) ? i : acc, -1), [filteredMessages]);

    // Derive mark state from voice state or text chat state
    const markState = useMemo<AliaMarkState>(() => {
      if (isVoiceActive && voiceAgentState) {
        if (voiceAgentState === 'thinking') return 'thinking';
        if (voiceAgentState === 'speaking') return 'writing';
        return 'idle';
      }
      if (lastAliaIndex < 0) return 'idle';
      const m = filteredMessages[lastAliaIndex];
      // Raw text is enough for the presence check — running the full
      // tag-stripping pipeline here doubled the regex work on every
      // streaming flush. Worst case a tag-only chunk briefly reads
      // 'writing' instead of 'thinking'.
      const text = getRawMessageText(m).trim();
      const hasActiveTools = m.toolInvocations?.some(
        (t: ToolInvocation) => t.state === 'call' || t.state === 'partial-call'
      );
      if (hasActiveTools) return 'working';
      if (isLoading && !text) return 'thinking';
      if (isLoading && text.length > 0) return 'writing';
      return 'idle';
    }, [filteredMessages, lastAliaIndex, isLoading, voiceAgentState, isVoiceActive]);

    const markAnimatedStyle = useAnimatedStyle(() => ({
      position: 'absolute' as const,
      left: 0,
      top: markY.value,
      zIndex: 10,
    }));

    const handleMarkLayout = useCallback((e: LayoutChangeEvent) => {
      markY.value = withTiming(e.nativeEvent.layout.y, {
        duration: 500,
        easing: Easing.bezier(0.4, 0, 0.2, 1),
      });
    }, [markY]);

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

    /**
     * `conversationId` comes from the ROW, not from the screen.
     *
     * The vote is addressed to the conversation the message is in, and a thread
     * shows several: taking the id of the stretch on screen would send an old
     * message's vote to a conversation that does not contain it, where it can
     * only fail — and it fails silently, because the only report is a toast on
     * success.
     */
    const handleVote = useCallback((messageId: string, vote: 'up' | 'down', conversationId?: string) => {
      if (voteInFlightRef.current.has(messageId)) return;
      let newVote: 'up' | 'down' | null = null;
      setVotedMessages(prev => {
        newVote = prev[messageId] === vote ? null : vote;
        if (newVote) return { ...prev, [messageId]: newVote };
        const { [messageId]: _, ...rest } = prev;
        return rest;
      });
      if (conversationId === undefined) return;
      voteInFlightRef.current.add(messageId);
      apiClient.patch(`/conversations/${conversationId}/messages/${messageId}/vote`, { vote: newVote })
        .then(() => toast.success(t('chat.thanksFeedback')))
        .catch(() => {
          setVotedMessages(prev => {
            const { [messageId]: _, ...rest } = prev;
            return rest;
          });
        })
        .finally(() => voteInFlightRef.current.delete(messageId));
    }, [t]);

    const containerClassName = cn(
      "max-w-3xl mx-auto w-full",
      filteredMessages.length === 0 && "flex-1 justify-center"
    );

    const scrollContentStyle = useMemo(
      () => ({ flexGrow: 1, paddingTop: 60, paddingBottom: bottomPadding }),
      [bottomPadding]
    );

    /**
     * How tall the history is, reported whenever it changes.
     *
     * The height rather than a position: what the anchor needs is how much
     * content was inserted above the reader, and only the history grows that
     * way — a streamed answer grows the bottom.
     */
    const handleHistoryLayout = useCallback((e: LayoutChangeEvent) => {
      onHistoryHeight?.(e.nativeEvent.layout.height);
    }, [onHistoryHeight]);

    /**
     * Put the message a jump was aimed at under the reader's eyes.
     *
     * Re-applied on every layout of that row rather than once, for the same
     * reason the history anchor is: the rows above it settle in installments,
     * so the first position it reports is not the one it keeps. Each call
     * supersedes the last and the final one is right.
     *
     * The `y` is measured inside the history block, which begins exactly at the
     * list's top padding — so scrolling to it lands the message a padding's
     * width below the top edge rather than flush against it, which is where a
     * message you went looking for wants to be.
     */
    const handleFocusLayout = useCallback((e: LayoutChangeEvent) => {
      scrollViewRef.current?.scrollTo({ y: Math.max(0, e.nativeEvent.layout.y), animated: false });
    }, [scrollViewRef]);

    /**
     * One message, wherever it sits in the whole of what is shown.
     *
     * `index` is a position in `filteredMessages` — history and live together —
     * because that is what the flying mark, the day separators and "is this the
     * last one" are all measured in. The two lists are rendered separately only
     * so the history can be measured as a block.
     */
    const renderMessage = (m: Message, index: number) => {
      const separator = separatorsByMessage.get(m.id);
      const fromHistory = index < history.length;

      return (
        <React.Fragment key={m.id || `msg-${index}`}>
          {separator === undefined ? null : (
            <DaySeparator text={separator} />
          )}
          {!seamIds.has(m.id) ? null : (
            <ConversationSeam text={t('chat.newStretch')} />
          )}
          <MessageRow
            m={m}
            index={index}
            // Only a message that arrived since the last render animates in,
            // and none of the history ever did: it is older than everything on
            // screen by definition, and the offset is what keeps a page landing
            // above from animating the whole conversation.
            isNewMessage={index >= history.length + prevMessageCountRef.current}
            isAliaMessage={isAliaOwnedMessage(m)}
            isLastAlia={index === lastAliaIndex}
            isLoading={isLoading}
            isLastMessage={index === filteredMessages.length - 1}
            isCopied={copiedMessageId === m.id}
            myVote={votedMessages[m.id] ?? null}
            ttsState={ttsActiveMessageId === m.id ? ttsPlaybackState : 'idle'}
            chatId={fromHistory ? historyChatIds.get(history[index].conversationId) ?? chatId : chatId}
            voiceAgentState={voiceAgentState}
            handleMarkLayout={handleMarkLayout}
            onRowLayout={
              fromHistory && focusCursor !== undefined && focusCursor !== null
                && history[index].cursor === focusCursor
                ? handleFocusLayout
                : undefined
            }
            handleCopyMessage={handleCopyMessage}
            handleVote={handleVote}
            readAloud={readAloud}
            generateAudio={generateAudio}
            audioGenRowState={audioGenActiveMessageId === m.id ? audioGenState : 'idle'}
            openThoughtPanel={openThoughtPanel}
            onStartEdit={fromHistory ? undefined : onStartEdit}
            onApprovePlan={onApprovePlan}
            onRejectPlan={onRejectPlan}
          />
        </React.Fragment>
      );
    };

    return (
      <KeyboardAwareScrollView
        ref={scrollViewRef}
        bottomOffset={60}
        // The AmbientField is a sibling behind this list. Keep the scroll
        // surface transparent so its idle and voice animations remain visible.
        className="flex-1 bg-transparent px-4 py-4"
        contentContainerStyle={scrollContentStyle}
        showsVerticalScrollIndicator={false}
        onScroll={onScroll}
        scrollEventThrottle={16}
        onContentSizeChange={onContentSizeChange}
      >
        <View className={containerClassName}>
          {!filteredMessages.length && (
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
              <WelcomeMessage />
            )
          )}

          <View style={{ position: 'relative' }}>
            {/* Single flying AliaMark */}
            {lastAliaIndex >= 0 && (
              <Animated.View style={markAnimatedStyle}>
                <AliaMark size={28} color={colors.primary} state={markState} />
              </Animated.View>
            )}

            {/* The history, MEASURED as one block. Its height is what the scroll
                anchor is restored against, and a block is what react-native-web
                will report a change for — a marker between the two lists never
                changes size, so its move goes unobserved and the reader is left
                looking at the wrong message. */}
            {history.length === 0 && !isLoadingHistory ? null : (
              <View onLayout={handleHistoryLayout}>
                {/* Inside the measured block on purpose: it appears when a page
                    is asked for and vanishes when it lands, and both of those
                    are height changes the anchor has to account for. Left
                    outside, its arrival and departure would displace the reader
                    by its own height, twice, with nothing to correct it. */}
                {!isLoadingHistory ? null : (
                  <View className="items-center py-4">
                    <Text className="text-xs text-muted-foreground">{t('chat.loadingHistory')}</Text>
                  </View>
                )}
                {history.map((m, index) => renderMessage(m, index))}
              </View>
            )}

            {liveMessages.map((m, index) => renderMessage(m, history.length + index))}
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

          {/* The agent's offer to start the next stretch fresh. Last in the
              list on purpose: it must not cover what is being read, and
              ignoring it has to leave the thread exactly as it was. */}
          {suggestedNewConversation === null || suggestedNewConversation === undefined ? null : (
            <NewConversationOffer
              reason={suggestedNewConversation}
              onAccept={onAcceptNewConversation ?? (() => {})}
              onDismiss={onDismissNewConversation ?? (() => {})}
            />
          )}

          {/* Standalone ThinkingIndicator for voice mode — shows when AI is thinking
              but there's no pending assistant message yet (e.g. right after user speaks) */}
          {voiceAgentState === 'thinking' &&
            !isLoading &&
            (messages.length === 0 || messages[messages.length - 1]?.role !== 'assistant') && (
              <ThinkingIndicator isWorking={false} color={colors.primary} />
            )}
        </View>
      </KeyboardAwareScrollView>
    );
});
