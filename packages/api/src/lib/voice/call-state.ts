/**
 * The state shapes of one voice call: the exchange ledger (what the person
 * said, what Alia answered), the per-response and per-tool-call bookkeeping,
 * the upstream session and the call's lifecycle states. Types only; the
 * transitions are `VoiceCall`'s (`call.ts`).
 */
import type { RealtimeSession } from '@kaana.ai/sdk';
import type { ToolInvocation } from '../../domain/conversation.js';

/**
 * What the person said in one input item: its one `transcript.done`, the final
 * transcript (Kaana contract set 6.0.0, whatever the provider sends).
 */
export interface UserEntry {
  kind: 'user';
  /** Stored under this id, and named by every transcript event of the item. */
  messageId: string;
  itemId: string;
  text: string | null;
  /** Refreshed by every event of the item: stored as it is once this passes. */
  deadline: number;
}

export interface TurnEntry {
  kind: 'assistant';
  /** Stored under this id, and named by every transcript event of the turn. */
  messageId: string;
  /** Output transcripts by audio item, in the order the items began. */
  texts: Map<string, string>;
  toolInvocations: ToolInvocation[];
  audioItems: Set<string>;
  interruptedAfterMs?: number;
  done: boolean;
  /** Set when the turn was cancelled while it spoke: wait this long for the played ms. */
  interruptDeadline?: number;
}

export type LedgerEntry = UserEntry | TurnEntry;

export interface ResponseState {
  readonly turn: TurnEntry;
  toolCalls: number;
  readonly pending: Promise<void>[];
  audioItem: string | null;
}

export interface ToolCallState {
  name: string;
  args: string;
  responseId: string;
}

export interface UpstreamState {
  readonly session: RealtimeSession;
  requestId: string | null;
  createdAt: number | null;
  /** When it ended; the minutes between are what the session costs. */
  endedAt: number | null;
}

export type CallState = 'idle' | 'opening' | 'live' | 'reconnecting' | 'closing' | 'closed';
