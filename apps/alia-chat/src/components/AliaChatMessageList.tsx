import React, { useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
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

interface AliaChatMessageListProps {
  messages: ChatMessage[];
  isStreaming: boolean;
  scrollOffsetY: SharedValue<number>;
}

// ── Tool Bullet ──

function ToolBullet({ invocation }: { invocation: ToolInvocation }) {
  const colors = useAliaColors();

  // Clean up tool name for display: "oxy_inbox__searchEmails" → "Searching emails"
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

// ── Assistant Message ──

function AssistantMessage({
  message,
  isStreamingThis,
}: {
  message: ChatMessage;
  isStreamingThis: boolean;
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
    </Animated.View>
  );
}

// ── List ──

export function AliaChatMessageList({
  messages,
  isStreaming,
  scrollOffsetY,
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
});
