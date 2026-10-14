import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { View, Pressable, Platform } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  withSequence,
  cancelAnimation,
} from 'react-native-reanimated';
import { Textarea } from '@oxy.so/bloom/textarea';
import { TaskList } from '@oxy.so/bloom/task-list';
import { Text } from '@oxy.so/bloom/typography';
import { WebSearch } from '@oxy.so/bloom/web-search';
import { AliaMarkdown } from './Markdown';
import { AiChatMessageLine, AiChatThread, AiChatUserMessage } from '@oxy.so/bloom/ai-chat';
import {
  AgentReply,
  AgentReplyAction,
  AgentReplyActions,
  AgentReplyBubble,
  AgentReplyIdentity,
} from '@oxy.so/bloom/agent-reply';
import { agentCharacter } from '../lib/agent-character';
import { ALIA_AVATAR } from './AliaAvatar';
import { Button } from '@oxy.so/bloom/button';
import { useLabels } from '../lib/labels';
import { isWebInvocation, taskListLog, webSearchLog } from '../lib/work-log';
import {
  RiCheckLine,
  RiFileCopyLine,
  RiPencilLine,
  RiStopFill,
  RiVolumeUpLine,
} from '@oxy.so/bloom/icons';
import { ThinkingBlock } from './ThinkingBlock';
import { PlanPreviewCard } from './PlanPreviewCard';
import { AskedQuestions } from './QuestionCard';
import { askedQuestions, isQuestionInvocation } from '../lib/questions';
import { chatMessageEnter } from '../animations';
import { getToolLabel, getToolActiveLabel, getResearchActiveLabel } from '../lib/tool-registry';
import { getTextFromContent, getImagesFromContent } from '../lib/content-utils';
import type { ChatMessage } from '../types';

// Resolve expo-image once at module load (optional peer dep)
type ExpoImageProps = {
  source: { uri: string };
  className?: string;
  contentFit?: string;
};
// expo-image is an optional peer dependency: SDK-only consumers that never render
// inline images may not install it. Degrade to skipping images when it can't be required.
let ExpoImage: React.ComponentType<ExpoImageProps> | null = null;
try {
  ExpoImage = require('expo-image').Image;
} catch {
  // Optional peer dependency absent — inline images are simply not rendered.
}

type PlaybackState = 'idle' | 'loading' | 'playing' | 'paused' | 'error';

export interface AliaChatMessageListProps {
  messages: ChatMessage[];
  isStreaming: boolean;
  onReadAloud?: (messageId: string, text: string) => void;
  ttsActiveMessageId?: string | null;
  ttsPlaybackState?: PlaybackState;
  // Injectable callbacks
  onEditMessage?: (messageId: string, newContent: string) => void;
  onThumbsUp?: (messageId: string) => void;
  onThumbsDown?: (messageId: string) => void;
  onApprovePlan?: (planId: string) => void;
  onRejectPlan?: (planId: string) => void;
  // Welcome
  welcomeComponent?: React.ReactNode;
  // Markdown renderer override (app passes CustomMarkdown, SDK uses AliaMarkdown)
  renderMarkdown?: (content: string) => React.ReactNode;
}

// ── User Bubble ──

const UserBubble = React.memo(function UserBubble({
  message,
  text,
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
  text: string;
  isEditing: boolean;
  editedContent: string;
  onEditedContentChange: (text: string) => void;
  onSaveEdit: (messageId: string) => void;
  onCancelEdit: () => void;
  onStartEdit: (messageId: string, content: string) => void;
  onCopy: (text: string, messageId: string) => void;
  copiedMessageId: string | null;
  showEditButton: boolean;
}) {
  const labels = useLabels();
  const images = getImagesFromContent(message.content);

  return (
    <View className="flex-col items-end gap-0.5">
      {isEditing ? (
        <View className="w-full max-w-[85%] gap-2 sm:max-w-[75%]">
          <Textarea
            value={editedContent}
            onValueChange={onEditedContentChange}
            rows={1}
            autoResize
            autoFocus
            accessibilityLabel={labels.edit}
          />
          <View className="flex-row justify-end gap-2">
            <Button tone="neutral" appearance="subtle" size="xs" onPress={onCancelEdit}>
              {labels.cancel}
            </Button>
            <Button tone="action" size="xs" onPress={() => onSaveEdit(message.id)}>
              {labels.save}
            </Button>
          </View>
        </View>
      ) : (
        <AiChatUserMessage
          animate={false}
          actions={[
            {
              key: 'copy',
              label: copiedMessageId === message.id ? labels.copied : labels.copy,
              icon: copiedMessageId === message.id ? RiCheckLine : RiFileCopyLine,
              onPress: () => onCopy(text, message.id),
            },
            ...(showEditButton
              ? [
                  {
                    key: 'edit',
                    label: labels.edit,
                    icon: RiPencilLine,
                    onPress: () => onStartEdit(message.id, text),
                  },
                ]
              : []),
          ]}
        >
          {images.length > 0 && ExpoImage ? (
            <AiChatMessageLine block>
              <View className="flex-row flex-wrap gap-2">
                {images.map((imgUrl) => (
                  <View
                    key={imgUrl}
                    className="rounded-xl overflow-hidden"
                    style={{ width: 120, height: 120 }}
                  >
                    <ExpoImage
                      source={{ uri: imgUrl }}
                      className="w-full h-full"
                      contentFit="cover"
                    />
                  </View>
                ))}
              </View>
            </AiChatMessageLine>
          ) : null}
          <AiChatMessageLine>{text}</AiChatMessageLine>
        </AiChatUserMessage>
      )}
    </View>
  );
});

// ── Assistant Message ──

/**
 * One reply, Alia's or a delegated agent's: the reply, and under it who answered. While the one
 * who answers is working the identity shows its avatar large and thinking, and when the reply
 * arrives it is the same avatar that settles under it, as in Bloom's multi-agent chat. Alia's own
 * text runs the width of the thread; an agent answers in a bubble.
 */
function ReplyBody({
  agent,
  thinking,
  reasoning,
  actions,
  children,
}: {
  agent: ChatMessage['agentInfo'];
  thinking: boolean;
  /** What the model has reasoned so far: the thinking avatar folds it under its row. */
  reasoning: React.ReactNode;
  actions: React.ReactNode;
  children: React.ReactNode;
}) {
  const identity = (
    <AgentReplyIdentity
      character={agent ? agentCharacter(agent.id) : ALIA_AVATAR}
      name={agent?.name ?? 'Alia'}
      thinking={thinking}
      reasoning={reasoning}
    />
  );
  if (agent === undefined)
    return (
      <AgentReply
        identity={identity}
        actions={actions}
        // The thread pads its content and spaces its messages: the text starts at its edge, full width.
        style={{ marginHorizontal: 0, marginTop: 0, maxWidth: '100%', width: '100%' }}
      >
        {children}
      </AgentReply>
    );
  return (
    <AgentReply
      identity={identity}
      actions={actions}
      // The reply starts where Alia's own text does and sits one thread gap from the message above.
      style={{ marginHorizontal: 0, marginTop: 0, maxWidth: '100%' }}
    >
      {children ? <AgentReplyBubble>{children}</AgentReplyBubble> : null}
    </AgentReply>
  );
}

const AssistantMessage = React.memo(function AssistantMessage({
  message,
  messageText,
  isStreamingThis,
  isLastMessage,
  isLoading,
  agentsWorking,
  onReadAloud,
  ttsActiveMessageId,
  ttsPlaybackState,
  onCopy,
  onThumbsUp,
  onThumbsDown,
  onApprovePlan,
  onRejectPlan,
  renderMarkdown,
}: {
  message: ChatMessage;
  messageText: string;
  isStreamingThis: boolean;
  isLastMessage: boolean;
  isLoading: boolean;
  /** An agent Alia sent for has not answered yet: it is the one thinking, not Alia. */
  agentsWorking: boolean;
  onReadAloud?: (messageId: string, text: string) => void;
  ttsActiveMessageId?: string | null;
  ttsPlaybackState?: PlaybackState;
  onCopy: (text: string, messageId: string) => void;
  onThumbsUp?: (messageId: string) => void;
  onThumbsDown?: (messageId: string) => void;
  onApprovePlan?: (planId: string) => void;
  onRejectPlan?: (planId: string) => void;
  renderMarkdown?: (content: string) => React.ReactNode;
}) {
  const labels = useLabels();
  const hasContent = messageText.length > 0;
  const hasThinking = !!message.thinking;

  // Both logs count units and are driven by `revealed`, from the calls that have really
  // arrived — never by their own demo ticker. The task list waits for the turn to end.
  const toolInvocations = message.toolInvocations;
  const researchProgress = message.researchProgress;
  const webLog = useMemo(
    () => webSearchLog(toolInvocations, researchProgress, { t: labels.workLog }),
    [toolInvocations, researchProgress, labels.workLog],
  );
  // The questions Alia asked, kept in the thread as a record. They are answered above the
  // composer (`AliaChatContent`), where the person is about to type.
  const questions = useMemo(
    () => (toolInvocations ?? []).flatMap((inv) => askedQuestions(inv) ?? []),
    [toolInvocations],
  );
  const taskLog = useMemo(() => {
    const tasks = (toolInvocations ?? []).filter(
      (inv) => !isWebInvocation(inv) && !isQuestionInvocation(inv),
    );
    return tasks.length === 0 || isStreamingThis
      ? null
      : taskListLog(tasks, false, { t: labels.workLog });
  }, [toolInvocations, isStreamingThis, labels.workLog]);

  const isThisPlaying = ttsActiveMessageId === message.id && ttsPlaybackState === 'playing';
  const isThisPaused = ttsActiveMessageId === message.id && ttsPlaybackState === 'paused';
  const isThisLoading = ttsActiveMessageId === message.id && ttsPlaybackState === 'loading';
  const replyActions =
    !isStreamingThis && hasContent ? (
      <AgentReplyActions
        onVoteChange={(vote) =>
          vote === 'up' ? onThumbsUp?.(message.id) : onThumbsDown?.(message.id)
        }
        onCopy={() => onCopy(messageText, message.id)}
      >
        {onReadAloud ? (
          <AgentReplyAction
            icon={isThisPlaying || isThisPaused ? RiStopFill : RiVolumeUpLine}
            label={isThisPlaying || isThisPaused ? labels.stopReading : labels.readAloud}
            selected={isThisPlaying || isThisPaused}
            disabled={isThisLoading}
            onPress={() => onReadAloud(message.id, messageText)}
          />
        ) : null}
      </AgentReplyActions>
    ) : undefined;

  // The one who answers is thinking until its reply starts: an agent from the call that sent for it,
  // Alia when no agent is working for her. The avatar is the indicator.
  const thinking =
    isLoading && !hasContent && (message.agentInfo ? true : isLastMessage && !agentsWorking);

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

      {/* What the turn did: where it went (searches, pages, research) and everything else. */}
      {taskLog === null ? null : (
        <TaskList
          tasks={taskLog.tasks}
          revealed={taskLog.revealed}
          collapseOnComplete="all"
          working={false}
        />
      )}
      {webLog.steps.length === 0 ? null : (
        <WebSearch
          steps={webLog.steps}
          revealed={webLog.revealed}
          working={isStreamingThis ? undefined : false}
        />
      )}

      {/* Extended Thinking */}
      {hasThinking && (
        <View className="mb-3 w-full">
          <ThinkingBlock text={message.thinking!} streaming={isStreamingThis && !hasContent} />
        </View>
      )}

      {/* Message Content */}
      {(hasContent || message.isStreaming || thinking) && (
        <ReplyBody
          agent={message.agentInfo}
          thinking={thinking}
          reasoning={
            thinking && hasThinking ? <AliaMarkdown content={message.thinking!} /> : undefined
          }
          actions={replyActions}
        >
          {!hasContent && !message.isStreaming ? null : message.source === 'voice' ? (
            <Text className="text-base text-text-primary leading-7">
              {messageText}
              {message.isStreaming ? '\u258C' : ''}
            </Text>
          ) : renderMarkdown ? (
            renderMarkdown(messageText)
          ) : (
            <AliaMarkdown content={messageText} />
          )}
        </ReplyBody>
      )}

      {/* What Alia asked stays in the thread as a record; answering happens above the composer. */}
      {questions.length === 0 ? null : <AskedQuestions questions={questions} />}
    </View>
  );
});

// ── List ──

export function AliaChatMessageList({
  messages,
  isStreaming,
  onReadAloud,
  ttsActiveMessageId,
  ttsPlaybackState,
  onEditMessage,
  onThumbsUp,
  onThumbsDown,
  onApprovePlan,
  onRejectPlan,
  welcomeComponent,
  renderMarkdown,
}: AliaChatMessageListProps) {
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editedContent, setEditedContent] = useState('');
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const prevMessageCountRef = useRef(messages.length);

  useEffect(() => {
    prevMessageCountRef.current = messages.length;
  }, [messages.length]);

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
    } catch (err) {
      console.warn('[AliaChat] Failed to copy message to clipboard:', err);
    }
  }, []);

  const handleStartEdit = useCallback((messageId: string, content: string) => {
    setEditingMessageId(messageId);
    setEditedContent(content);
  }, []);

  const editedContentRef = useRef(editedContent);
  editedContentRef.current = editedContent;

  const handleSaveEdit = useCallback(
    (messageId: string) => {
      if (onEditMessage && editedContentRef.current.trim()) {
        onEditMessage(messageId, editedContentRef.current);
      }
      setEditingMessageId(null);
      setEditedContent('');
    },
    [onEditMessage],
  );

  const handleCancelEdit = useCallback(() => {
    setEditingMessageId(null);
    setEditedContent('');
  }, []);

  const filteredMessages = useMemo(() => messages.filter((m) => m.role !== 'system'), [messages]);
  // An agent Alia sent for that has not answered: it is the one that is thinking.
  const agentsWorking =
    isStreaming && filteredMessages.some((m) => m.agentInfo && !getTextFromContent(m.content));

  return (
    // Bloom's thread: follows the newest turn, and reports its scroll to a floating-chrome
    // container so the header and composer fade in over it.
    <AiChatThread>
      <View
        className="max-w-3xl mx-auto w-full"
        style={!filteredMessages.length ? { flex: 1, justifyContent: 'center' } : undefined}
      >
        {/* Welcome or loading */}
        {!filteredMessages.length && (welcomeComponent || null)}

        {/* Messages */}
        <View className="gap-2">
          {filteredMessages.map((msg, i) => {
            const isNewMessage = i >= prevMessageCountRef.current;
            const isLast = i === filteredMessages.length - 1;
            const isStreamingThis = isStreaming && isLast;
            const messageText = getTextFromContent(msg.content);

            return (
              <Animated.View key={msg.id} entering={isNewMessage ? chatMessageEnter : undefined}>
                {msg.role === 'user' ? (
                  <UserBubble
                    message={msg}
                    text={messageText}
                    isEditing={editingMessageId === msg.id}
                    editedContent={editingMessageId === msg.id ? editedContent : ''}
                    onEditedContentChange={setEditedContent}
                    onSaveEdit={handleSaveEdit}
                    onCancelEdit={handleCancelEdit}
                    onStartEdit={handleStartEdit}
                    onCopy={handleCopy}
                    copiedMessageId={copiedMessageId}
                    showEditButton={!!onEditMessage}
                  />
                ) : (
                  <AssistantMessage
                    message={msg}
                    messageText={messageText}
                    isStreamingThis={isStreamingThis}
                    isLastMessage={isLast}
                    isLoading={isStreaming}
                    agentsWorking={agentsWorking}
                    onReadAloud={onReadAloud}
                    ttsActiveMessageId={ttsActiveMessageId}
                    ttsPlaybackState={ttsPlaybackState}
                    onCopy={handleCopy}
                    onThumbsUp={onThumbsUp}
                    onThumbsDown={onThumbsDown}
                    onApprovePlan={onApprovePlan}
                    onRejectPlan={onRejectPlan}
                    renderMarkdown={renderMarkdown}
                  />
                )}
              </Animated.View>
            );
          })}
        </View>
      </View>
    </AiChatThread>
  );
}
