import React, { useRef, useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Platform,
} from 'react-native';
import { BlurView } from 'expo-blur';
import Animated, {
  useAnimatedScrollHandler,
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  withSequence,
  cancelAnimation,
  Easing,
  FadeInUp,
  type SharedValue,
} from 'react-native-reanimated';
import { useAliaColors } from '../theme';
import { AliaMarkdown } from './Markdown';
import { ThinkingIndicator } from './ThinkingIndicator';
import { Reasoning, ReasoningTrigger, ReasoningContent } from './Reasoning';
import type { ChatMessage, ToolInvocation } from '../types';

const ENTER_ANIMATION = FadeInUp.duration(200);

type PlaybackState = 'idle' | 'loading' | 'playing' | 'paused' | 'error';

export interface AliaChatMessageListProps {
  messages: ChatMessage[];
  isStreaming: boolean;
  scrollOffsetY: SharedValue<number>;
  onReadAloud?: (messageId: string, text: string) => void;
  ttsActiveMessageId?: string | null;
  ttsPlaybackState?: PlaybackState;
}

// ── Tool Bullet ──

function ToolBullet({ invocation }: { invocation: ToolInvocation }) {
  const colors = useAliaColors();

  const displayName = invocation.toolName
    .replace(/^oxy_\w+__/, '')
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (s) => s.toUpperCase())
    .trim();

  const isActive = invocation.state === 'call' || invocation.state === 'partial-call';
  const label = isActive ? `${displayName}...` : displayName;

  return (
    <View style={styles.toolStatus}>
      {isActive ? (
        <PulsingDot color={colors.tint} />
      ) : (
        <Text style={[styles.toolCheckmark, { color: colors.tint }]}>{'\u2713'}</Text>
      )}
      <Text style={[styles.toolLabel, { color: colors.secondaryText }]}>{label}</Text>
    </View>
  );
}

function PulsingDot({ color }: { color: string }) {
  const opacity = useSharedValue(1);

  useEffect(() => {
    opacity.value = withRepeat(
      withSequence(
        withTiming(0.3, { duration: 600, easing: Easing.inOut(Easing.sin) }),
        withTiming(1, { duration: 600, easing: Easing.inOut(Easing.sin) }),
      ),
      -1,
    );
    return () => cancelAnimation(opacity);
  }, []);

  const animStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.View style={[styles.toolDot, { backgroundColor: color }, animStyle]} />
  );
}

// ── User Bubble ──

function UserBubble({ content }: { content: string }) {
  const colors = useAliaColors();
  const isDark = colors.isDark;

  return (
    <View style={styles.userMessage}>
      <View style={[styles.userBubble, { borderColor: colors.border }]}>
        <BlurView
          intensity={60}
          tint={isDark ? 'dark' : 'light'}
          style={StyleSheet.absoluteFill}
        />
        <Text style={[styles.userText, { color: colors.text }]}>{content}</Text>
      </View>
    </View>
  );
}

// ── Message Actions ──

function MessageActions({
  message,
  onReadAloud,
  ttsActiveMessageId,
  ttsPlaybackState,
}: {
  message: ChatMessage;
  onReadAloud?: (messageId: string, text: string) => void;
  ttsActiveMessageId?: string | null;
  ttsPlaybackState?: PlaybackState;
}) {
  const colors = useAliaColors();
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      if (Platform.OS === 'web') {
        await navigator.clipboard.writeText(message.content);
      } else {
        const Clipboard = await import('expo-clipboard');
        await Clipboard.setStringAsync(message.content);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  }, [message.content]);

  const isThisPlaying = ttsActiveMessageId === message.id && ttsPlaybackState === 'playing';
  const isThisLoading = ttsActiveMessageId === message.id && ttsPlaybackState === 'loading';

  if (!message.content) return null;

  return (
    <View style={styles.actionsRow}>
      {/* Copy */}
      <Pressable onPress={handleCopy} style={styles.actionBtn} hitSlop={8}>
        {copied ? (
          <Text style={[styles.actionIcon, { color: colors.tint }]}>{'\u2713'}</Text>
        ) : (
          <CopyIcon color={colors.secondaryText} />
        )}
      </Pressable>

      {/* Read aloud */}
      {onReadAloud && (
        <Pressable
          onPress={() => onReadAloud(message.id, message.content)}
          style={styles.actionBtn}
          hitSlop={8}
        >
          {isThisLoading ? (
            <Text style={[styles.actionIcon, { color: colors.secondaryText }]}>{'\u2026'}</Text>
          ) : (
            <VolumeIcon color={isThisPlaying ? colors.tint : colors.secondaryText} />
          )}
        </Pressable>
      )}
    </View>
  );
}

function CopyIcon({ color }: { color: string }) {
  if (Platform.OS === 'web') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </svg>
    );
  }
  return <Text style={[styles.actionIcon, { color }]}>{'\u2398'}</Text>;
}

function VolumeIcon({ color }: { color: string }) {
  if (Platform.OS === 'web') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M11 5L6 9H2v6h4l5 4V5z" />
        <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      </svg>
    );
  }
  return <Text style={[styles.actionIcon, { color }]}>{'\u{1F50A}'}</Text>;
}

// ── Assistant Message ──

function AssistantMessage({
  message,
  isStreamingThis,
  onReadAloud,
  ttsActiveMessageId,
  ttsPlaybackState,
}: {
  message: ChatMessage;
  isStreamingThis: boolean;
  onReadAloud?: (messageId: string, text: string) => void;
  ttsActiveMessageId?: string | null;
  ttsPlaybackState?: PlaybackState;
}) {
  const colors = useAliaColors();
  const hasContent = !!message.content;
  const hasThinking = !!message.thinking;
  const showThinkingIndicator = isStreamingThis && !hasContent && !message.toolInvocations?.length && !hasThinking;

  return (
    <Animated.View
      entering={ENTER_ANIMATION}
      style={styles.assistantMessage}
    >
      {/* Extended thinking / reasoning */}
      {hasThinking && (
        <Reasoning isStreaming={isStreamingThis && !hasContent}>
          <ReasoningTrigger />
          <ReasoningContent>{message.thinking!}</ReasoningContent>
        </Reasoning>
      )}

      {/* Tool invocations */}
      {message.toolInvocations?.map((tool, i) => (
        <ToolBullet key={`${tool.toolCallId || tool.toolName}-${i}`} invocation={tool} />
      ))}

      {/* Thinking indicator (no content yet) */}
      {showThinkingIndicator && <ThinkingIndicator />}

      {/* Text content — rendered as markdown */}
      {hasContent && (
        <AliaMarkdown content={message.content} />
      )}

      {/* Streaming cursor */}
      {isStreamingThis && hasContent && (
        <Text style={[styles.cursor, { color: colors.secondaryText }]}>{'\u2758'}</Text>
      )}

      {/* Message actions (copy, read aloud) — shown when not streaming */}
      {!isStreamingThis && hasContent && (
        <MessageActions
          message={message}
          onReadAloud={onReadAloud}
          ttsActiveMessageId={ttsActiveMessageId}
          ttsPlaybackState={ttsPlaybackState}
        />
      )}
    </Animated.View>
  );
}

// ── List ──

export function AliaChatMessageList({
  messages,
  isStreaming,
  scrollOffsetY,
  onReadAloud,
  ttsActiveMessageId,
  ttsPlaybackState,
}: AliaChatMessageListProps) {
  const scrollRef = useRef<Animated.ScrollView>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (messages.length > 0) {
      const timer = setTimeout(() => {
        (scrollRef.current as any)?.scrollToEnd?.({ animated: true });
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [messages]);

  const scrollHandler = useAnimatedScrollHandler({
    onScroll: (event) => {
      scrollOffsetY.value = event.contentOffset.y;
    },
  });

  return (
    <Animated.ScrollView
      ref={scrollRef}
      style={styles.scrollView}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      onScroll={scrollHandler}
      scrollEventThrottle={16}
    >
      {messages
        .filter((m) => m.role !== 'system')
        .map((msg, i, arr) => {
          if (msg.role === 'user') {
            return <UserBubble key={msg.id} content={msg.content} />;
          }

          const isStreamingThis = isStreaming && i === arr.length - 1;

          return (
            <AssistantMessage
              key={msg.id}
              message={msg}
              isStreamingThis={isStreamingThis}
              onReadAloud={onReadAloud}
              ttsActiveMessageId={ttsActiveMessageId}
              ttsPlaybackState={ttsPlaybackState}
            />
          );
        })}
    </Animated.ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollView: {
    flex: 1,
  },
  content: {
    padding: 16,
    paddingTop: 4,
    flexGrow: 1,
  },

  // User bubble — frosted glass
  userMessage: {
    alignItems: 'flex-end',
    marginBottom: 12,
  },
  userBubble: {
    maxWidth: '85%',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  userText: {
    fontSize: 15,
    lineHeight: 22,
  },

  // Assistant message — no bubble
  assistantMessage: {
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  cursor: {
    fontSize: 15,
    marginTop: -4,
  },

  // Tool status
  toolStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
    paddingVertical: 2,
  },
  toolDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  toolCheckmark: {
    fontSize: 14,
    fontWeight: '600',
  },
  toolLabel: {
    fontSize: 13,
  },

  // Message actions
  actionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 6,
    opacity: 0.7,
  },
  actionBtn: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionIcon: {
    fontSize: 14,
  },
});
