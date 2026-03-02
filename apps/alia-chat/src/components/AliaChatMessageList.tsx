import React, { useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Platform,
} from 'react-native';
import { BlurView } from 'expo-blur';
import Animated, { useAnimatedScrollHandler, useSharedValue } from 'react-native-reanimated';
import { useAliaColors } from '../theme';
import type { ChatMessage, ToolInvocation } from '../types';

interface AliaChatMessageListProps {
  messages: ChatMessage[];
  isStreaming: boolean;
  scrollOffsetY: Animated.SharedValue<number>;
}

function ToolStatus({ invocation }: { invocation: ToolInvocation }) {
  const colors = useAliaColors();

  // Clean up tool name for display: "oxy_inbox__searchEmails" → "Searching emails"
  const displayName = invocation.toolName
    .replace(/^oxy_\w+__/, '')
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (s) => s.toUpperCase())
    .trim();

  const label =
    invocation.state === 'call'
      ? `${displayName}...`
      : displayName;

  return (
    <View style={styles.toolStatus}>
      {invocation.state === 'call' && (
        <View style={[styles.toolDot, { backgroundColor: colors.tint }]} />
      )}
      {invocation.state === 'result' && (
        <Text style={[styles.toolCheckmark, { color: colors.tint }]}>{'✓'}</Text>
      )}
      <Text style={[styles.toolLabel, { color: colors.secondaryText }]}>{label}</Text>
    </View>
  );
}

function UserBubble({ content }: { content: string }) {
  const colors = useAliaColors();
  const isDark = colors.background === '#000000';

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

function AssistantMessage({
  message,
  isFirst,
  isStreamingThis,
}: {
  message: ChatMessage;
  isFirst: boolean;
  isStreamingThis: boolean;
}) {
  const colors = useAliaColors();

  return (
    <View style={styles.assistantMessage}>
      {/* Tool invocations */}
      {message.toolInvocations?.map((tool, i) => (
        <ToolStatus key={`${tool.toolName}-${i}`} invocation={tool} />
      ))}

      {/* Text content */}
      {(message.content || isStreamingThis) && (
        <Text style={[styles.assistantText, { color: colors.text }]}>
          {message.content || (isStreamingThis ? '\u2758' : '')}
        </Text>
      )}
    </View>
  );
}

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

          const isFirstInGroup = i === 0 || arr[i - 1]?.role === 'user';
          const isStreamingThis = isStreaming && i === arr.length - 1;

          return (
            <AssistantMessage
              key={msg.id}
              message={msg}
              isFirst={isFirstInGroup}
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
  assistantText: {
    fontSize: 15,
    lineHeight: 24,
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
    ...Platform.select({
      web: {} as any,
      default: {},
    }),
  },
  toolCheckmark: {
    fontSize: 14,
    fontWeight: '600',
  },
  toolLabel: {
    fontSize: 13,
  },
});
