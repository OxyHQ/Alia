/**
 * What a call speaks WITH: its instructions and its tools (ADR 0017 §3).
 *
 * Built from the same pieces as a typed turn — `SystemPromptBuilder` with
 * `responseMode: 'voice'` (so `prompts/voice.md`, and no `askUserQuestion`
 * card), the actor's memory, the person's skills, and `ToolPipeline.forUser`
 * with the person on the socket as requester — plus two sections only a call
 * has: the recent conversation, as text (one instruction string, not one
 * billable item per message), and the session language.
 */

import type { ToolSet } from 'ai';
import type { UserMemoryProfile } from '../../db/memory/userMemoryRepository.js';
import { listMessages, toStoredMessage } from '../../db/chat/messageRepository.js';
import { getDb } from '../../db/index.js';
import type { MessageContent, ToolInvocation } from '../../domain/conversation.js';
import type { HydratedAgent } from '../agent-identity.js';
import { buildTurnSkills, EMPTY_SKILL_RUNTIME, recallTurnMemories } from '../chat/turn-inputs.js';
import { realtimeSessionConfigSchema } from '@kaana.ai/contracts';
import type { ChatMessage } from '../message-converter.js';
import { priorToolCallsOf } from '../message-converter.js';
import { SystemPromptBuilder, type OxyUserProfile } from '../system-prompt-builder.js';
import { ToolPipeline } from '../tool-pipeline.js';
import { VoiceFailure } from './errors.js';

/** A stored message of the conversation, as the instructions read it. */
export interface HistoryMessage {
  readonly role: string;
  readonly content: MessageContent;
  readonly toolInvocations?: ToolInvocation[];
}

/** The conversation's stored messages, oldest first. */
export async function loadConversationHistory(
  oxyUserId: string,
  conversationId: string,
): Promise<HistoryMessage[]> {
  const rows = await listMessages(getDb(), oxyUserId, conversationId);
  return rows.map((row) => {
    const message = toStoredMessage(row);
    return {
      role: message.role,
      content: message.content,
      ...(message.toolInvocations ? { toolInvocations: message.toolInvocations } : {}),
    };
  });
}

/** The plain text of a message, whatever its parts. */
export function textOf(content: MessageContent): string {
  if (typeof content === 'string') return content;
  return content
    .map((part) =>
      part && typeof part === 'object' && 'text' in part && typeof part.text === 'string'
        ? part.text
        : '',
    )
    .filter((text) => text !== '')
    .join('\n');
}

/** The contract's own bound on a session's instructions, read from its schema. */
const MAX_INSTRUCTIONS =
  realtimeSessionConfigSchema.shape.instructions.unwrap().maxLength ?? Number.POSITIVE_INFINITY;

/** The most history the instructions start from, before the cap trims it further. */
const HISTORY_START_CHARS = 16_000;
/** One message's share, so a single long answer cannot crowd out the rest. */
const HISTORY_MESSAGE_CHARS = 2_000;

/** The recent messages that fit `budget` characters, oldest first, as `Person:`/`You:` lines. */
export function historyLines(history: readonly HistoryMessage[], budget: number): string[] {
  const lines: string[] = [];
  let used = 0;
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index]!;
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    let text = textOf(message.content).replace(/\s+/g, ' ').trim();
    if (text === '') continue;
    if (text.length > HISTORY_MESSAGE_CHARS) text = `${text.slice(0, HISTORY_MESSAGE_CHARS)}…`;
    const line = `${message.role === 'user' ? 'Person' : 'You'}: ${text}`;
    if (used + line.length + 1 > budget) break;
    lines.unshift(line);
    used += line.length + 1;
  }
  return lines;
}

function historySection(lines: readonly string[]): string {
  if (lines.length === 0) return '';
  return [
    '## The conversation so far',
    'This call continues the conversation below (oldest first). Do not repeat it; carry on from it.',
    ...lines,
  ].join('\n');
}

function languageSection(language: string): string {
  return [
    '## Language',
    `The person is speaking ${language}. Answer in that language unless they switch to another.`,
  ].join('\n');
}

/**
 * The call's instructions, within the contract's 32 768 characters: the
 * history shrinks first, then the recalled memories go; if the base prompt
 * alone still does not fit, the call refuses to open rather than cut it
 * silently (ADR 0017 §3).
 */
export async function composeVoiceInstructions(input: {
  readonly base: (withRecalledMemories: boolean) => Promise<string>;
  readonly history: readonly HistoryMessage[];
  readonly language: string;
  readonly cap?: number;
}): Promise<string> {
  const cap = input.cap ?? MAX_INSTRUCTIONS;
  const language = languageSection(input.language);
  const compose = (base: string, lines: readonly string[]) =>
    [base, historySection(lines), language].filter((part) => part !== '').join('\n\n');

  for (const withRecalled of [true, false]) {
    const base = await input.base(withRecalled);
    let budget = HISTORY_START_CHARS;
    for (;;) {
      const lines = historyLines(input.history, budget);
      const text = compose(base, lines);
      if (text.length <= cap) return text;
      if (lines.length === 0) break;
      budget = Math.max(0, Math.min(budget, lines.join('\n').length) - (text.length - cap) - 1);
    }
  }
  throw new VoiceFailure('realtime-rejected');
}

/** What a call speaks with, built once at open and refreshed on a reopen. */
export interface VoiceTurnContext {
  /** Every tool the call may run. */
  readonly tools: ToolSet;
  /** The tools the session currently carries (routing may load more with `loadTools`). */
  activeToolNames(): string[];
  /** The instructions for a session opened now, from this history. */
  instructions(history: readonly HistoryMessage[]): Promise<string>;
}

export interface VoiceTurnInput {
  readonly oxyUserId: string;
  readonly accessToken: () => string;
  readonly conversationId: string;
  readonly requestId: string;
  readonly linkedAgent: HydratedAgent | null;
  readonly userMemory: UserMemoryProfile | null;
  readonly oxyUser: OxyUserProfile | null;
  readonly language: string;
  readonly history: readonly HistoryMessage[];
}

/** The default builder: the real prompt, memory, skills and tool pipeline. */
export async function buildVoiceTurn(input: VoiceTurnInput): Promise<VoiceTurnContext> {
  const { oxyUserId, linkedAgent, conversationId } = input;
  const asChat = input.history as unknown as ChatMessage[];
  const [skills, recalledMemories] = await Promise.all([
    buildTurnSkills({ oxyUserId, linkedAgent }),
    recallTurnMemories({
      oxyUserId,
      conversationId,
      messages: asChat,
      modelId: 'voice',
    }),
  ]);

  const assembled = await ToolPipeline.forUser({
    userId: oxyUserId,
    accessToken: input.accessToken(),
    isDirectSession: true,
    actsForPerson: true,
    // The person on the socket: an agent's owner data only for its owner (ADR 0015).
    requesterAccountId: oxyUserId,
    agentMode: false,
    requestId: input.requestId,
    priorToolCalls: priorToolCallsOf(asChat),
    webSearch: true,
    isLocalRuntime: false,
    toolsEnabled: true,
    agent: linkedAgent,
    skills: skills ?? EMPTY_SKILL_RUNTIME,
  });

  const runtime = skills ?? EMPTY_SKILL_RUNTIME;
  const base = async (withRecalled: boolean): Promise<string> => {
    const parts = await SystemPromptBuilder.buildMeasured({
      surface: 'chat',
      model: null,
      isDirectUserSession: true,
      userId: oxyUserId,
      accessToken: input.accessToken(),
      oxyUser: input.oxyUser,
      userMemory: input.userMemory,
      ...(withRecalled && recalledMemories ? { recalledMemories } : {}),
      skills: runtime,
      linkedAgent,
      responseMode: 'voice',
      appCatalog: assembled.appCatalogPrompt,
      toolNames: Object.keys(assembled.tools),
      askUserQuestion: false,
    });
    return parts.text;
  };

  return {
    tools: assembled.tools,
    activeToolNames: assembled.activeToolNames,
    instructions: (history) =>
      composeVoiceInstructions({ base, history, language: input.language }),
  };
}
