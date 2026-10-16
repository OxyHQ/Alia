/**
 * The conversation as data: the records, and what a list of messages becomes before anything
 * draws it (the timeline, the thought panel's steps and sources, tool cards, day lines,
 * the agent thread's windows, the markdown export), plus the typed ways a turn fails.
 *
 * Pure: no React, no React Native, no Oxy client. It is a leaf entry (`@alia.onl/sdk/model`) for
 * code that only reads conversations, and the runtime re-exports all of it.
 */

export { API_ROUTES as ALIA_API_ROUTES } from './routes';
export * from './power-levels';
export { englishCopy } from '../lib/copy';
export type { Translate } from '../lib/copy';
export * from './thread/agent-activity';
export * from './thread/automation-labels';
export * from './thread/conversation-export';
export * from './thread/message-days';
export * from './thread/message-processor';
export * from './thread/task-utils';
export * from './thread/thought-utils';
export * from './thread/thread-history';
export * from './thread/timeline';
export * from './thread/tool-cards';
export { failureDetail } from './turn-failure';
export type { FailedTurn } from './turn-failure';
export type {
  AgentRun,
  AutomationResource,
  AutomationTrigger,
  Conversation,
  ConversationsInfiniteData,
  ConversationsPage,
  Message,
  MessageContent,
  SendOptions,
  ToolInvocation,
} from './types';
export { UsageLimitError } from './usage-limit-error';
export type { UsageLimitDetails, UsageLimitType } from './usage-limit-error';
