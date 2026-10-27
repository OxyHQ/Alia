import { AgentProgress } from '@oxy.so/bloom/agent-progress';
import { AgentReplyIdentity } from '@oxy.so/bloom/agent-reply';
import {
  AiChatAssistantMessage,
  AiChatUserMessage,
  type AiChatTurnAction,
} from '@oxy.so/bloom/ai-chat';
import { RiEditLine } from '@oxy.so/bloom/icons/RiEditLine';
import { RiFileCopyLine } from '@oxy.so/bloom/icons/RiFileCopyLine';
import { RiRefreshLine } from '@oxy.so/bloom/icons/RiRefreshLine';
import { RiStopFill } from '@oxy.so/bloom/icons/RiStopFill';
import { RiThumbDownLine } from '@oxy.so/bloom/icons/RiThumbDownLine';
import { RiThumbUpLine } from '@oxy.so/bloom/icons/RiThumbUpLine';
import { RiVolumeUpLine } from '@oxy.so/bloom/icons/RiVolumeUpLine';
import { TaskList } from '@oxy.so/bloom/task-list';
import { Text } from '@oxy.so/bloom/typography';
import { WebSearch } from '@oxy.so/bloom/web-search';
import { memo } from 'react';
import { type LayoutChangeEvent, View } from 'react-native';
import Animated from 'react-native-reanimated';
import type { ReadAloudState } from '../../hooks/useReadAloud';
import type { Vote } from '../../hooks/useMessageVote';
import { readAgentCharacter } from '../../lib/agent-character';
import { getImagesFromContent, messageText } from '../../lib/content-utils';
import { ANCHORS, useAliaFlights } from '../../lib/flights';
import { useLabels } from '../../lib/labels';
import { canvasResultOf } from '../../lib/canvas-result';
import { askedQuestions, isQuestionInvocation } from '../../lib/questions';
import { parseCatalogueTool, useToolRenderers } from '../../lib/tool-renderers';
import { isWebInvocation, taskListLog, webSearchLog } from '../../lib/work-log';
import { useAliaRuntime } from '../../runtime/config';
import { type Message, cardOf, formatElapsed, getToolPillLabel } from '../../runtime/model';
import type { OpenThought } from '../../hooks/useOpenThought';
import { Image } from '../Image';
import { PlanPreviewCard } from '../PlanPreviewCard';
import { AskedQuestions } from '../QuestionCard';
import { CanvasComponent } from '../canvas/CanvasComponent';
import { ReplyMarkdown } from '../ReplyMarkdown';
import { MessageBlockBoundary } from './MessageBlockBoundary';
import { ToolResultCard } from './ToolResultCard';
import { TurnMenu } from './TurnMenu';
import { TurnStatusLine } from './TurnStatusLine';

/**
 * What a row can do, built once by the thread so every memoised row sees the same object: the
 * thread re-renders per streamed token, and a function made per row would re-render them all.
 */
export interface ThreadActions {
  /** Copy a turn's words; resolves whether they really reached the clipboard. */
  copy: (text: string) => Promise<boolean>;
  vote: (messageId: string, vote: Vote, conversationId: string | undefined) => void;
  readAloud: (messageId: string, text: string, conversationId: string | undefined) => void;
  /** Absent where the host has no thought panel: the "worked for" line is then plain text. */
  openThought?: OpenThought;
  /** A thread read by somebody it was shared with: words to copy, nothing to vote on or play. */
  readOnly?: boolean;
}

export interface ThreadRowProps {
  message: Message;
  /** The row only for a message that arrived while the conversation was open; history never animates. */
  isNew: boolean;
  /** The last of Alia's own replies: the one that may be streaming. */
  isLastReply: boolean;
  /** A turn is in flight. Given only to the last reply, so a turn starting re-renders one row. */
  isLoading: boolean;
  /** The conversation that holds this message, or `undefined` while none does (`Message.unsaved` also withholds it). */
  conversationId: string | undefined;
  /** Where this row ended up, for the one row a jump is aimed at. */
  onLayout?: (event: LayoutChangeEvent) => void;
  actions: ThreadActions;
  /** This reply's read-aloud, as a primitive so only its own row re-renders. */
  readAloudState: ReadAloudState;
  /** A call or a dictation holds the audio. */
  readAloudBlocked: boolean;
  /** Given only to the one reply that may be regenerated. */
  onRegenerate?: (assistantMessageId: string) => void;
  /** Given only to a question that may be edited. */
  onStartEdit?: (userMessageId: string) => void;
  /** The turn's timing for its work summary, as epoch ms, or `null` for a turn the server has not stamped. */
  workStartedAt: number | null;
  workEndedAt: number | null;
}

const isPresent = <T,>(value: T | null): value is T => value !== null;

/**
 * One turn of the thread: a question in Bloom's bubble, or a reply with its work summary, cards
 * and Markdown.
 *
 * The turn's own actions are each offered only where they can be done — read aloud and copy need
 * words, regenerate a finished reply in a thread not busy with another turn — and the row under
 * the turn and the long-press menu are the same list.
 */
export const ThreadRow = memo(function ThreadRow({
  message,
  isNew,
  isLastReply,
  isLoading,
  conversationId,
  onLayout,
  actions,
  readAloudState,
  readAloudBlocked,
  onRegenerate,
  onStartEdit,
  workStartedAt,
  workEndedAt,
}: ThreadRowProps) {
  const { t } = useLabels();
  const text = messageText(message);
  const images = message.content ? getImagesFromContent(message.content) : [];
  const isReply = message.role === 'assistant';
  const storedIn = message.unsaved === true ? undefined : conversationId;
  const hasText = text.length > 0;

  const copyAction: AiChatTurnAction | null = hasText
    ? {
        key: 'copy',
        label: t('chat.copy'),
        icon: RiFileCopyLine,
        onPress: () => void actions.copy(text),
      }
    : null;

  if (!isReply) {
    const editAction: AiChatTurnAction | null =
      onStartEdit === undefined
        ? null
        : {
            key: 'edit',
            label: t('chat.edit'),
            icon: RiEditLine,
            onPress: () => onStartEdit(message.id),
          };
    const questionActions = [copyAction, editAction].filter(isPresent);
    return (
      <Animated.View onLayout={onLayout}>
        {text.length === 0 && images.length === 0 ? null : (
          // Bloom's user turn, with the breathing room above it the thread has always had.
          <View className="mt-2 w-full flex-col items-end">
            <TurnMenu actions={questionActions} label={t('chat.turnActions')}>
              <AiChatUserMessage animate={isNew} actions={questionActions}>
                {images.length > 0 && (
                  <View className="flex-row flex-wrap gap-2">
                    {images.map((url) => (
                      <View key={url} className="size-[120px] overflow-hidden rounded-xl">
                        <Image source={{ uri: url }} className="h-full w-full" contentFit="cover" />
                      </View>
                    ))}
                  </View>
                )}
                {text}
              </AiChatUserMessage>
            </TurnMenu>
          </View>
        )}
      </Animated.View>
    );
  }

  return (
    <Animated.View onLayout={onLayout}>
      <ReplyTurn
        message={message}
        text={text}
        isNew={isNew}
        isLastReply={isLastReply}
        isLoading={isLoading}
        storedIn={storedIn}
        actions={actions}
        copyAction={copyAction}
        readAloudState={readAloudState}
        readAloudBlocked={readAloudBlocked}
        onRegenerate={onRegenerate}
        workStartedAt={workStartedAt}
        workEndedAt={workEndedAt}
      />
    </Animated.View>
  );
});

interface ReplyTurnProps {
  message: Message;
  text: string;
  isNew: boolean;
  isLastReply: boolean;
  isLoading: boolean;
  storedIn: string | undefined;
  actions: ThreadActions;
  copyAction: AiChatTurnAction | null;
  readAloudState: ReadAloudState;
  readAloudBlocked: boolean;
  onRegenerate?: (assistantMessageId: string) => void;
  workStartedAt: number | null;
  workEndedAt: number | null;
}

function ReplyTurn({
  message,
  text,
  isNew,
  isLastReply,
  isLoading,
  storedIn,
  actions,
  copyAction,
  readAloudState,
  readAloudBlocked,
  onRegenerate,
  workStartedAt,
  workEndedAt,
}: ReplyTurnProps) {
  const { t } = useLabels();
  const { faviconUrl } = useAliaRuntime().host;
  const renderers = useToolRenderers();
  const flights = useAliaFlights();
  const toolInvocations = message.toolInvocations ?? [];
  const plan = message.plan;
  const agent = message.agentInfo;
  const { readOnly = false } = actions;

  // A host's own drawing of a catalogue tool's result, before any generic card: keyed by the
  // tool's canonical name (`oxy_<app>__<tool>`), never by anything the model wrote.
  const rendered = toolInvocations.flatMap((call, index) => {
    if (call.state !== 'result') return [];
    const parsed = parseCatalogueTool(call.toolName);
    const render = parsed ? renderers[`${parsed.app}:${parsed.tool}`] : undefined;
    if (!parsed || render === undefined) return [];
    return [
      {
        key: call.toolCallId || `rendered-${message.id}-${index}`,
        call,
        node: render({
          app: parsed.app,
          tool: parsed.tool,
          toolCallId: call.toolCallId,
          input: call.args,
          output: call.result,
          ...(agent ? { agentId: agent.id } : {}),
        }),
      },
    ];
  });

  // A shared conversation has no canvas panel to open an artifact in, so it draws each one inline.
  const inlineCanvases = readOnly
    ? toolInvocations.flatMap((call, index) => {
        const canvas = canvasResultOf(call);
        return canvas === null
          ? []
          : [{ key: call.toolCallId || `canvas-${message.id}-${index}`, call, canvas }];
      })
    : [];
  const renderedCalls = new Set([
    ...rendered.map(({ call }) => call),
    ...inlineCanvases.map(({ call }) => call),
  ]);

  // The calls the work summary lists: every one that did not draw its own card. Read on each
  // render — the list changes per streamed tool event and the row is memoised on `message`.
  const workInvocations = toolInvocations.filter(
    (call) => cardOf(call) === null && !isQuestionInvocation(call) && !renderedCalls.has(call),
  );
  const questions = toolInvocations.flatMap((call) => askedQuestions(call) ?? []);
  const toolCards = toolInvocations.flatMap((call, index) => {
    if (renderedCalls.has(call)) return [];
    const card = cardOf(call);
    return card === null ? [] : [{ key: call.toolCallId || `tool-${message.id}-${index}`, card }];
  });
  /** The template swaps the steps for the reply once the turn is done. */
  const turnWorking = isLoading && isLastReply && message.isStreaming === true;

  // Where the turn went — searches, page visits, research — as a `WebSearch` trail with its
  // sources, and everything else it did as a `TaskList`. Both are driven by `revealed` from the
  // calls that have really arrived, never by their own demo ticker.
  const webLog = webSearchLog(workInvocations, message.researchProgress, { t, faviconUrl });
  const taskInvocations = workInvocations.filter((call) => !isWebInvocation(call));
  const taskLog =
    taskInvocations.length === 0 || turnWorking ? null : taskListLog(taskInvocations, false, { t });
  const hasWorkLog = webLog.steps.length > 0 || (workInvocations.length > 0 && !turnWorking);

  const reading =
    readAloudState === 'loading' || readAloudState === 'playing' || readAloudState === 'paused';
  const readAloudAction: AiChatTurnAction | null =
    !text || readOnly
      ? null
      : {
          key: 'read-aloud',
          label: reading ? t('chat.stopReading') : t('chat.readAloud'),
          icon: reading ? RiStopFill : RiVolumeUpLine,
          active: reading,
          disabled: readAloudBlocked && !reading,
          onPress: () => actions.readAloud(message.id, text, storedIn),
        };
  const regenerateAction: AiChatTurnAction | null =
    onRegenerate === undefined || message.isStreaming || isLoading || readOnly
      ? null
      : {
          key: 'regenerate',
          label: t('chat.regenerate'),
          icon: RiRefreshLine,
          onPress: () => onRegenerate(message.id),
        };
  /** Under a reply, after Bloom's like / dislike / copy. */
  const replyActions = [readAloudAction, regenerateAction].filter(isPresent);
  const hasFeedback = !message.isStreaming && text.length > 0 && !readOnly;
  /** The long-press menu: everything the rows offer, likes included. */
  const menuActions: AiChatTurnAction[] = hasFeedback
    ? [
        readAloudAction,
        copyAction,
        regenerateAction,
        {
          key: 'like',
          label: t('chat.like'),
          icon: RiThumbUpLine,
          onPress: () => actions.vote(message.id, 'up', storedIn),
        },
        {
          key: 'dislike',
          label: t('chat.dislike'),
          icon: RiThumbDownLine,
          onPress: () => actions.vote(message.id, 'down', storedIn),
        },
      ].filter(isPresent)
    : [];

  const { openThought } = actions;
  const viewDetails = openThought && (() => openThought(message.id, 'steps'));
  /** A consulted agent's reply is drawn from its first frame: its identity is where it joins from. */
  const showsContent =
    agent !== undefined ||
    text.length > 0 ||
    hasWorkLog ||
    toolCards.length > 0 ||
    rendered.length > 0 ||
    inlineCanvases.length > 0 ||
    (message.isStreaming === true && message.source === 'voice');
  /** Its avatar is the source of the flight into the header while it is answering. */
  const agentLive = agent !== undefined && message.isStreaming === true;
  const agentAnchor = agent ? ANCHORS.reply(agent.id) : undefined;

  return (
    <>
      {/* Plan Preview — shown before tool execution */}
      {plan && (
        <MessageBlockBoundary>
          <PlanPreviewCard steps={plan.steps} />
        </MessageBlockBoundary>
      )}

      {/* The template's steps: Bloom's AgentProgress, driven by the tool calls as the runtime
          reports them. Web calls are left to the WebSearch trail inside the turn, which streams
          them itself. */}
      {taskInvocations.length === 0 || !turnWorking ? null : (
        <AgentProgress
          steps={taskInvocations.map((call) => getToolPillLabel(call.toolName, t))}
          completedCount={taskInvocations.filter((call) => call.state === 'result').length}
        />
      )}

      {/* `isStreaming` opens the block for VOICE only: a voice row shows its cursor before it has
          words, while a text turn's placeholder — stamped `isStreaming` too — is the thinking
          indicator's until its first token arrives. */}
      {showsContent && (
        <View className="w-full flex-col">
          {agent && agentAnchor ? (
            <View className="mb-0.5">
              <AgentReplyIdentity
                character={readAgentCharacter(agent.character)}
                name={agent.name}
                thinking={agentLive && text.length === 0}
                workingKey={agent.id}
                avatarRef={agentLive && flights ? flights.anchor(agentAnchor) : undefined}
                avatarHidden={agentLive && flights ? flights.isLeaving(agentAnchor) : false}
              />
            </View>
          ) : null}
          {/* Bloom's reply: its reveal and its own feedback row (like / dislike / copy), then read
              aloud and regenerate. Copy confirms only what the clipboard did. */}
          <TurnMenu actions={menuActions} label={t('chat.turnActions')}>
            <AiChatAssistantMessage
              animate={isNew}
              feedback={hasFeedback}
              feedbackProps={{
                onLike: () => actions.vote(message.id, 'up', storedIn),
                onDislike: () => actions.vote(message.id, 'down', storedIn),
                onCopy: () => actions.copy(text),
                actions: replyActions,
                labels: {
                  like: t('chat.like'),
                  dislike: t('chat.dislike'),
                  copy: t('chat.copy'),
                  copied: t('chat.copied'),
                },
              }}
            >
              {workInvocations.length === 0 || turnWorking ? null : (
                <TurnStatusLine
                  label={
                    workStartedAt !== null && workEndedAt !== null
                      ? t('thought.workedFor', {
                          elapsed: formatElapsed(workEndedAt - workStartedAt),
                        })
                      : t('thought.worked')
                  }
                  hint={t('thought.viewDetails')}
                  onPress={viewDetails}
                />
              )}
              {/* A turn that reasoned without tools: its reasoning, a press away. */}
              {workInvocations.length > 0 || !message.thinking || turnWorking ? null : (
                <TurnStatusLine
                  label={t('thought.reasoning')}
                  hint={t('thought.viewDetails')}
                  onPress={viewDetails}
                />
              )}
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
                  working={turnWorking ? t('chat.working') : false}
                  labels={{ sources: t('chat.sources') }}
                />
              )}
              {rendered.map(({ key, node }) => (
                <MessageBlockBoundary key={key}>{node}</MessageBlockBoundary>
              ))}
              {inlineCanvases.map(({ key, canvas }) => (
                <MessageBlockBoundary key={key}>
                  <View className="rounded-2xl border border-border p-4" testID="shared-canvas">
                    <CanvasComponent component={{ id: key, ...canvas }} />
                  </View>
                </MessageBlockBoundary>
              ))}
              {/* Each card in its own boundary: `cardOf` checks the card's NAME, and its data is
                  cast unchecked. */}
              {toolCards.map(({ key, card }) => (
                <MessageBlockBoundary key={key}>
                  <ToolResultCard card={card} />
                </MessageBlockBoundary>
              ))}
              {questions.length === 0 ? null : (
                <MessageBlockBoundary>
                  <AskedQuestions questions={questions} />
                </MessageBlockBoundary>
              )}
              {agent && message.turnOutcome === 'failed' && text.length === 0 ? (
                <Text className="text-sm text-muted-foreground">
                  {t('chat.consultFailed', { name: agent.name })}
                </Text>
              ) : null}
              {message.source === 'voice' ? (
                <Text className="text-base leading-7 text-foreground">
                  {text}
                  {message.isStreaming ? '▌' : ''}
                </Text>
              ) : (
                <ReplyMarkdown
                  content={text}
                  toolInvocations={message.toolInvocations}
                  researchSources={message.researchProgress?.sources}
                  streaming={message.isStreaming === true}
                />
              )}
            </AiChatAssistantMessage>
          </TurnMenu>
        </View>
      )}
    </>
  );
}
