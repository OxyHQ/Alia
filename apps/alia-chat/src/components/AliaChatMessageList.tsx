import React, { useRef, useEffect, useState, useCallback } from 'react';
import { View, Pressable, TextInput, StyleSheet, Platform } from 'react-native';
import { BlurView } from 'expo-blur';
import Animated, {
  useAnimatedScrollHandler,
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  withSequence,
  cancelAnimation,
  FadeInUp,
  type SharedValue,
} from 'react-native-reanimated';
import {
  Copy,
  Check,
  Volume2,
  Square,
  ThumbsUp,
  ThumbsDown,
  Pencil,
} from 'lucide-react-native';
import { useAliaColors } from '../theme';
import { Text } from './ui/text';
import { AliaMarkdown } from './Markdown';
import { ThinkingIndicator } from './ThinkingIndicator';
import { Reasoning, ReasoningTrigger, ReasoningContent } from './Reasoning';
import { ResearchProgressCard } from './ResearchProgressCard';
import { PlanPreviewCard } from './PlanPreviewCard';
import { getToolLabel, getToolActiveLabel } from '../lib/tool-registry';
import { getTextFromContent, getImagesFromContent } from '../lib/content-utils';
import type { ChatMessage, ToolInvocation } from '../types';

type PlaybackState = 'idle' | 'loading' | 'playing' | 'paused' | 'error';

const RESEARCH_PHASE_LABELS: Record<string, string> = {
  decomposing: 'Decomposing query...',
  searching: 'Searching sources...',
  reading: 'Reading articles...',
  synthesizing: 'Synthesizing findings...',
  follow_up: 'Following up...',
  finalizing: 'Finalizing research...',
};

export interface AliaChatMessageListProps {
  messages: ChatMessage[];
  isStreaming: boolean;
  scrollOffsetY: SharedValue<number>;
  onReadAloud?: (messageId: string, text: string) => void;
  ttsActiveMessageId?: string | null;
  ttsPlaybackState?: PlaybackState;
  // Injectable callbacks
  onEditMessage?: (messageId: string, newContent: string) => void;
  onThumbsUp?: (messageId: string) => void;
  onThumbsDown?: (messageId: string) => void;
  onApprovePlan?: (planId: string) => void;
  onRejectPlan?: (planId: string) => void;
  onToolResultPress?: (messageId: string) => void;
  // Welcome
  welcomeComponent?: React.ReactNode;
  conversationLoading?: boolean;
  // Markdown renderer override (app passes CustomMarkdown, SDK uses AliaMarkdown)
  renderMarkdown?: (content: string) => React.ReactNode;
}

// ── Tool Bullet ──

function ToolBullet({ isRunning }: { isRunning: boolean }) {
  const opacity = useSharedValue(1);
  useEffect(() => {
    if (isRunning) {
      opacity.value = withRepeat(
        withSequence(
          withTiming(0.3, { duration: 500 }),
          withTiming(1, { duration: 500 }),
        ),
        -1,
      );
    } else {
      opacity.value = 1;
    }
    return () => cancelAnimation(opacity);
  }, [isRunning]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View style={style}>
      <Text style={{ color: isRunning ? '#eab308' : '#22c55e', fontSize: 10 }}>
        {'\u25CF'}
      </Text>
    </Animated.View>
  );
}

// ── User Bubble ──

function UserBubble({
  message,
  isEditing,
  editedContent,
  onEditedContentChange,
  onSaveEdit,
  onCancelEdit,
  onStartEdit,
  onCopy,
  copiedMessageId,
  showEditButton,
}: {
  message: ChatMessage;
  isEditing: boolean;
  editedContent: string;
  onEditedContentChange: (text: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onStartEdit: () => void;
  onCopy: () => void;
  copiedMessageId: string | null;
  showEditButton: boolean;
}) {
  const text = getTextFromContent(message.content);
  const images = getImagesFromContent(message.content);

  return (
    <View className="flex-col items-end gap-0.5">
      {isEditing ? (
        <View className="max-w-[85%] sm:max-w-[75%] rounded-[24px] overflow-hidden border border-border">
          <BlurView intensity={60} tint="default" style={StyleSheet.absoluteFill} />
          <View className="px-4 py-2">
            <TextInput
              value={editedContent}
              onChangeText={onEditedContentChange}
              multiline
              className="text-base text-foreground leading-7"
              autoFocus
            />
            <View className="flex-row gap-2 mt-2">
              <Pressable
                className="px-3 py-1.5 rounded-lg bg-primary"
                onPress={onSaveEdit}
              >
                <Text className="text-xs text-primary-foreground">Save</Text>
              </Pressable>
              <Pressable
                className="px-3 py-1.5 rounded-lg bg-muted-foreground"
                onPress={onCancelEdit}
              >
                <Text className="text-xs text-background">Cancel</Text>
              </Pressable>
            </View>
          </View>
        </View>
      ) : (
        <View className="max-w-[85%] sm:max-w-[75%] rounded-[24px] overflow-hidden border border-border">
          <BlurView intensity={60} tint="default" style={StyleSheet.absoluteFill} />
          <View className="px-4 py-2">
            {/* Inline images from multi-part content */}
            {images.length > 0 && (
              <View className="flex-row flex-wrap gap-2 mb-2">
                {images.map((imgUrl, imgIdx) => {
                  let ImageComponent: any;
                  try { ImageComponent = require('expo-image').Image; } catch { ImageComponent = null; }
                  if (!ImageComponent) return null;
                  return (
                    <View key={`img-${imgIdx}`} className="rounded-xl overflow-hidden" style={{ width: 120, height: 120 }}>
                      <ImageComponent
                        source={{ uri: imgUrl }}
                        className="w-full h-full"
                        contentFit="cover"
                      />
                    </View>
                  );
                })}
              </View>
            )}
            <Text className="text-base text-foreground leading-7">{text}</Text>
          </View>
        </View>
      )}
      {/* User message actions */}
      {!isEditing && (
        <View className="flex-row gap-1">
          <Pressable
            className="p-1.5 rounded-lg active:bg-muted"
            onPress={onCopy}
          >
            {copiedMessageId === message.id ? (
              <Check size={14} className="text-green-500" />
            ) : (
              <Copy size={14} className="text-muted-foreground" />
            )}
          </Pressable>
          {showEditButton && (
            <Pressable
              className="p-1.5 rounded-lg active:bg-muted"
              onPress={onStartEdit}
            >
              <Pencil size={14} className="text-muted-foreground" />
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}

// ── Assistant Message ──

function AssistantMessage({
  message,
  isStreamingThis,
  isLastMessage,
  isLoading,
  onReadAloud,
  ttsActiveMessageId,
  ttsPlaybackState,
  onCopy,
  copiedMessageId,
  onThumbsUp,
  onThumbsDown,
  onApprovePlan,
  onRejectPlan,
  onToolResultPress,
  renderMarkdown,
}: {
  message: ChatMessage;
  isStreamingThis: boolean;
  isLastMessage: boolean;
  isLoading: boolean;
  onReadAloud?: (messageId: string, text: string) => void;
  ttsActiveMessageId?: string | null;
  ttsPlaybackState?: PlaybackState;
  onCopy: () => void;
  copiedMessageId: string | null;
  onThumbsUp?: (messageId: string) => void;
  onThumbsDown?: (messageId: string) => void;
  onApprovePlan?: (planId: string) => void;
  onRejectPlan?: (planId: string) => void;
  onToolResultPress?: (messageId: string) => void;
  renderMarkdown?: (content: string) => React.ReactNode;
}) {
  const messageText = getTextFromContent(message.content);
  const hasContent = messageText.length > 0;
  const hasThinking = !!message.thinking;

  const isThisPlaying = ttsActiveMessageId === message.id && ttsPlaybackState === 'playing';
  const isThisPaused = ttsActiveMessageId === message.id && ttsPlaybackState === 'paused';
  const isThisLoading = ttsActiveMessageId === message.id && ttsPlaybackState === 'loading';

  return (
    <View className="w-full">
      {/* Plan Preview */}
      {message.pendingPlan && onApprovePlan && onRejectPlan && (
        <PlanPreviewCard
          steps={message.pendingPlan.steps}
          approved={message.pendingPlan.approved}
          rejected={message.pendingPlan.rejected}
          onApprove={() => onApprovePlan(message.pendingPlan!.planId)}
          onReject={() => onRejectPlan(message.pendingPlan!.planId)}
        />
      )}

      {/* Tool Invocations */}
      {message.toolInvocations?.map((t, ti) => {
        const key = t.toolCallId || `tool-${message.id}-${ti}`;
        const toolLabel = getToolLabel(t.toolName);
        const isRunning = t.state === 'call' || t.state === 'partial-call';
        const isDone = t.state === 'result';

        let description = '';
        if (t.args?.url) {
          const url = String(t.args.url);
          description = url.length > 40 ? url.substring(0, 40) + '...' : url;
        } else if (t.args?.query) {
          const q = String(t.args.query);
          description = `"${q.length > 30 ? q.substring(0, 30) + '...' : q}"`;
        }

        return (
          <Pressable
            key={key}
            className="flex-row items-center gap-2 py-1 active:opacity-70"
            onPress={isDone && onToolResultPress ? () => onToolResultPress(message.id) : undefined}
            disabled={!isDone || !onToolResultPress}
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

      {/* Research Progress */}
      {message.researchProgress && (
        <ResearchProgressCard progress={message.researchProgress} />
      )}

      {/* Extended Thinking */}
      {hasThinking && (
        <View className="mb-3 w-full">
          <Reasoning isStreaming={isStreamingThis && !hasContent}>
            <ReasoningTrigger />
            <ReasoningContent>{message.thinking!}</ReasoningContent>
          </Reasoning>
        </View>
      )}

      {/* Message Content */}
      {(hasContent || message.isStreaming) && (
        <View className="flex-col items-start gap-0.5">
          {/* Voice cohost label */}
          {message.source === 'voice' && message.speaker === 'cohost' && (
            <Text className="text-xs text-indigo-400 mb-0.5">Cohost</Text>
          )}
          {/* Agent identity */}
          {message.agentInfo && (
            <View className="flex-row items-center gap-2 mb-0.5">
              <View className="w-5 h-5 rounded-full bg-orange-500/20 items-center justify-center">
                <Text style={{ fontSize: 8, color: '#f97316' }}>{'\u25CF'}</Text>
              </View>
              <Text className="text-xs font-semibold" style={{ color: '#f97316' }}>
                {message.agentInfo.name}
              </Text>
            </View>
          )}
          <View className="w-full">
            {message.source === 'voice' ? (
              <Text className="text-base text-foreground leading-7">
                {messageText}
                {message.isStreaming ? '\u258C' : ''}
              </Text>
            ) : renderMarkdown ? (
              renderMarkdown(messageText)
            ) : (
              <AliaMarkdown content={messageText} />
            )}
          </View>
          {/* Action buttons */}
          {!isStreamingThis && hasContent && (
            <View className="flex-row gap-1">
              {onReadAloud && (
                <Pressable
                  className="p-1.5 rounded-lg active:bg-muted"
                  onPress={() => onReadAloud(message.id, messageText)}
                >
                  {isThisPlaying || isThisPaused ? (
                    <Square size={14} className={isThisPlaying ? 'text-primary' : 'text-muted-foreground'} />
                  ) : (
                    <Volume2 size={14} className={isThisLoading ? 'text-primary opacity-50' : 'text-muted-foreground'} />
                  )}
                </Pressable>
              )}
              <Pressable
                className="p-1.5 rounded-lg active:bg-muted"
                onPress={onCopy}
              >
                {copiedMessageId === message.id ? (
                  <Check size={14} className="text-green-500" />
                ) : (
                  <Copy size={14} className="text-muted-foreground" />
                )}
              </Pressable>
              {onThumbsUp && (
                <Pressable className="p-1.5 rounded-lg active:bg-muted" onPress={() => onThumbsUp(message.id)}>
                  <ThumbsUp size={14} className="text-muted-foreground" />
                </Pressable>
              )}
              {onThumbsDown && (
                <Pressable className="p-1.5 rounded-lg active:bg-muted" onPress={() => onThumbsDown(message.id)}>
                  <ThumbsDown size={14} className="text-muted-foreground" />
                </Pressable>
              )}
            </View>
          )}
        </View>
      )}

      {/* ThinkingIndicator — context-aware status */}
      {isLoading && isLastMessage && !hasContent && (() => {
        const activeTool = message.toolInvocations?.find(
          t => t.state === 'call' || t.state === 'partial-call',
        );
        const rp = message.researchProgress;
        let activeStatus: string | undefined;
        if (activeTool) {
          activeStatus = getToolActiveLabel(activeTool.toolName);
        } else if (rp?.phase && rp.phase !== 'complete') {
          activeStatus = RESEARCH_PHASE_LABELS[rp.phase];
        } else if (message.thinking) {
          activeStatus = 'Reasoning...';
        }
        return (
          <ThinkingIndicator
            isWorking={(message.toolInvocations?.length ?? 0) > 0}
            statusText={activeStatus}
          />
        );
      })()}
    </View>
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
  onEditMessage,
  onThumbsUp,
  onThumbsDown,
  onApprovePlan,
  onRejectPlan,
  onToolResultPress,
  welcomeComponent,
  conversationLoading,
  renderMarkdown,
}: AliaChatMessageListProps) {
  const scrollRef = useRef<Animated.ScrollView>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editedContent, setEditedContent] = useState('');
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const prevMessageCountRef = useRef(messages.length);

  useEffect(() => {
    prevMessageCountRef.current = messages.length;
  }, [messages.length]);

  // Auto-scroll
  useEffect(() => {
    if (messages.length > 0) {
      const timer = setTimeout(() => {
        (scrollRef.current as any)?.scrollToEnd?.({ animated: true });
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [messages.length, isStreaming]);

  const scrollHandler = useAnimatedScrollHandler({
    onScroll: (event) => {
      scrollOffsetY.value = event.contentOffset.y;
    },
  });

  const handleCopy = useCallback(async (content: string, messageId: string) => {
    try {
      if (Platform.OS === 'web') {
        await navigator.clipboard.writeText(content);
      } else {
        const Clipboard = await import('expo-clipboard');
        await Clipboard.setStringAsync(content);
      }
      setCopiedMessageId(messageId);
      setTimeout(() => setCopiedMessageId(null), 2000);
    } catch {}
  }, []);

  const handleStartEdit = useCallback((messageId: string, content: string) => {
    setEditingMessageId(messageId);
    setEditedContent(content);
  }, []);

  const editedContentRef = useRef(editedContent);
  editedContentRef.current = editedContent;

  const handleSaveEdit = useCallback((messageId: string) => {
    if (onEditMessage && editedContentRef.current.trim()) {
      onEditMessage(messageId, editedContentRef.current);
    }
    setEditingMessageId(null);
    setEditedContent('');
  }, [onEditMessage]);

  const handleCancelEdit = useCallback(() => {
    setEditingMessageId(null);
    setEditedContent('');
  }, []);

  const filteredMessages = messages.filter(m => m.role !== 'system');

  return (
    <Animated.ScrollView
      ref={scrollRef}
      className="flex-1 bg-background px-4 py-4"
      contentContainerStyle={{ flexGrow: 1, paddingTop: 4, paddingBottom: 16 }}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      onScroll={scrollHandler}
      scrollEventThrottle={16}
    >
      <View className="max-w-3xl mx-auto w-full" style={!filteredMessages.length ? { flex: 1, justifyContent: 'center' } : undefined}>
        {/* Welcome or loading */}
        {!filteredMessages.length && (
          welcomeComponent || null
        )}

        {/* Messages */}
        <View className="gap-2">
          {filteredMessages.map((msg, i) => {
            const isNewMessage = i >= prevMessageCountRef.current;
            const isLast = i === filteredMessages.length - 1;
            const isStreamingThis = isStreaming && isLast;
            const messageText = getTextFromContent(msg.content);

            return (
              <Animated.View
                key={msg.id}
                entering={isNewMessage ? FadeInUp.springify() : undefined}
              >
                {msg.role === 'user' ? (
                  <UserBubble
                    message={msg}
                    isEditing={editingMessageId === msg.id}
                    editedContent={editedContent}
                    onEditedContentChange={setEditedContent}
                    onSaveEdit={() => handleSaveEdit(msg.id)}
                    onCancelEdit={handleCancelEdit}
                    onStartEdit={() => handleStartEdit(msg.id, messageText)}
                    onCopy={() => handleCopy(messageText, msg.id)}
                    copiedMessageId={copiedMessageId}
                    showEditButton={!!onEditMessage}
                  />
                ) : (
                  <AssistantMessage
                    message={msg}
                    isStreamingThis={isStreamingThis}
                    isLastMessage={isLast}
                    isLoading={isStreaming}
                    onReadAloud={onReadAloud}
                    ttsActiveMessageId={ttsActiveMessageId}
                    ttsPlaybackState={ttsPlaybackState}
                    onCopy={() => handleCopy(messageText, msg.id)}
                    copiedMessageId={copiedMessageId}
                    onThumbsUp={onThumbsUp}
                    onThumbsDown={onThumbsDown}
                    onApprovePlan={onApprovePlan}
                    onRejectPlan={onRejectPlan}
                    onToolResultPress={onToolResultPress}
                    renderMarkdown={renderMarkdown}
                  />
                )}
              </Animated.View>
            );
          })}
        </View>
      </View>
    </Animated.ScrollView>
  );
}
