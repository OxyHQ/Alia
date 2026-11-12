/**
 * A group conversation is a room (ADR 0025): its members keep talking after the request that
 * started the round has ended, and the server pushes what they do over the socket as `group:event`.
 *
 * This file folds those events into the thread's messages. A member's reply is the SAME message the
 * thread already draws for the request's `alia.agent_*` frames (`agentInfo`, `isStreaming`,
 * `toolInvocations`), so nothing new is drawn. Pure: `use-room-events.ts` wires it to the host's
 * socket and `use-conversation-stream.ts` shares the {@link RoomLedger} so a reply is never drawn
 * twice, once for the request and once for the socket.
 */

import type { Message, ToolInvocation } from './types';

/** `group:event` as the server pushes it: the frame body carries no `eventVersion`. */
export interface RoomEvent {
  conversationId: string;
  chainId?: string;
  event: string;
  data: unknown;
}

export type RoomFailureReason = 'error' | 'rate_limited' | 'turn_cap' | 'reply_cap';

/** A room failure is distinct from deliberate silence, supersession and a lost connection. */
export function roomFailureReason(value: unknown): RoomFailureReason | null {
  return value === 'error' ||
    value === 'rate_limited' ||
    value === 'turn_cap' ||
    value === 'reply_cap'
    ? value
    : null;
}

/**
 * Which consultation is drawn in which message, and what the request already owns.
 *
 * Mutable on purpose: one per open conversation, held by the thread.
 */
export interface RoomLedger {
  /** `consultId` to the id of the message that draws it. */
  messages: Map<string, string>;
  /** Socket-observed chain for a consult, including one initially drawn by SSE. */
  chains: Map<string, string>;
  /** Consultations the chat request's SSE frames drew: the socket must not draw them again. */
  claimed: Set<string>;
  /** Claimed consultations whose request ended with `room_continues`: the socket carries them now. */
  released: Set<string>;
  /** Consultations whose end was applied. */
  ended: Set<string>;
  /** Provisional replies explicitly discarded by the room, never restored by late frames. */
  discarded: Set<string>;
}

export function createRoomLedger(): RoomLedger {
  return {
    messages: new Map(),
    chains: new Map(),
    claimed: new Set(),
    released: new Set(),
    ended: new Set(),
    discarded: new Set(),
  };
}

/** The id a consultation drawn from the socket gets until its stored reply names it. */
const roomDraftId = (consultId: string): string => `room-${consultId}`;

/**
 * The request drew `consultId` in message `id`. When the socket had already drawn it, the request
 * adopts that message and returns its id: the request's frames are complete from their start, so
 * the caller empties that message and lets the request say it all (what the socket added before
 * would otherwise be said twice).
 */
export function claimConsult(ledger: RoomLedger, consultId: string, id: string): string | null {
  const existing = ledger.messages.get(consultId);
  ledger.claimed.add(consultId);
  if (existing !== undefined) return existing;
  ledger.messages.set(consultId, id);
  return null;
}

/** The request closed `consultId` with `room_continues`: the room goes on, the socket takes over. */
export function releaseConsult(ledger: RoomLedger, consultId: string): void {
  if (ledger.claimed.has(consultId)) ledger.released.add(consultId);
}

/** Whether the room, not the request, owns `messageId` (so the request's end must not settle it). */
export function isRoomOwned(ledger: RoomLedger, messageId: string): boolean {
  for (const [consultId, id] of ledger.messages) {
    if (id === messageId) return ledger.released.has(consultId) && !ledger.ended.has(consultId);
  }
  return false;
}

type Raw = Record<string, unknown>;
const isObject = (value: unknown): value is Raw =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

/** A consultation the socket drives is live; one the request drew is, once it let go. */
const isLive = (ledger: RoomLedger, consultId: string): boolean =>
  !ledger.claimed.has(consultId) || ledger.released.has(consultId);

const replace = (messages: Message[], id: string, change: (m: Message) => Message): Message[] =>
  messages.map((m) => (m.id === id ? change(m) : m));

/** The message as the server stored it: no longer a draft. */
function stored(m: Message, reply: Raw): Message {
  const { unsaved: _unsaved, ...rest } = m;
  const createdAt = text(reply.createdAt);
  const info = reply.agentInfo;
  return {
    ...rest,
    content: typeof reply.content === 'string' ? reply.content : m.content,
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(isObject(info) && text(info.id) && text(info.name)
      ? { agentInfo: info as unknown as NonNullable<Message['agentInfo']> }
      : {}),
    isStreaming: false,
    turnOutcome: 'completed',
  };
}

/** A completed end names the stored reply: the draft becomes it, or yields to it if it is already here. */
function settleCompleted(
  messages: Message[],
  draftId: string | undefined,
  messageId: string,
  content: string | undefined,
  ledger: RoomLedger,
  consultId: string,
): Message[] {
  ledger.messages.set(consultId, messageId);
  const reply: Raw = content === undefined ? {} : { content };
  const has = messages.some((m) => m.id === messageId);
  if (draftId === undefined || draftId === messageId) {
    return has ? replace(messages, messageId, (m) => stored(m, reply)) : messages;
  }
  if (has) {
    // `group.message` came first: it is the record, the draft only drops out.
    return messages.filter((m) => m.id !== draftId);
  }
  return messages.map((m) => (m.id === draftId ? { ...stored(m, reply), id: messageId } : m));
}

/**
 * What one room event does to the thread's messages. Events of other conversations, malformed ones
 * and ones already applied return `messages` itself, so a caller can tell nothing changed.
 */
export function applyRoomEvent(
  messages: Message[],
  ledger: RoomLedger,
  conversationId: string,
  incoming: RoomEvent,
): Message[] {
  if (incoming.conversationId !== conversationId || !isObject(incoming.data)) return messages;
  const data = incoming.data;
  const consultId = text(data.consultId);
  const chainId = text(incoming.chainId);
  if (
    consultId !== undefined &&
    chainId !== undefined &&
    (incoming.event === 'alia.agent_start' ||
      incoming.event === 'alia.agent_delta' ||
      incoming.event === 'alia.agent_tool' ||
      incoming.event === 'alia.agent_end')
  ) {
    // SSE may already own this consult, but only the socket carries its chain.
    // Record it before the duplicate/ownership guards can discard the frame.
    const knownChain = ledger.chains.get(consultId);
    if (knownChain !== undefined && knownChain !== chainId) return messages;
    ledger.chains.set(consultId, chainId);
  }

  switch (incoming.event) {
    case 'alia.agent_start': {
      const agent = data.agent;
      if (consultId === undefined || ledger.messages.has(consultId)) return messages;
      if (!isObject(agent) || !text(agent.id) || !text(agent.name)) return messages;
      const id = roomDraftId(consultId);
      ledger.messages.set(consultId, id);
      return [
        ...messages,
        {
          id,
          unsaved: true,
          role: 'assistant',
          content: '',
          toolInvocations: [],
          createdAt: new Date().toISOString(),
          isStreaming: true,
          agentInfo: {
            id: agent.id as string,
            name: agent.name as string,
            ...(text(agent.handle) ? { handle: agent.handle as string } : {}),
            ...(text(agent.color) ? { color: agent.color as string } : {}),
            ...(agent.character === undefined || agent.character === null
              ? {}
              : { character: agent.character }),
          },
        },
      ];
    }
    case 'alia.agent_delta': {
      if (consultId === undefined || ledger.ended.has(consultId) || !isLive(ledger, consultId)) {
        return messages;
      }
      const id = ledger.messages.get(consultId);
      if (id === undefined || typeof data.content !== 'string' || data.content === '') {
        return messages;
      }
      const words = data.content;
      return replace(messages, id, (m) => ({
        ...m,
        content: (typeof m.content === 'string' ? m.content : '') + words,
      }));
    }
    case 'alia.agent_tool': {
      if (consultId === undefined || ledger.ended.has(consultId) || !isLive(ledger, consultId)) {
        return messages;
      }
      const id = ledger.messages.get(consultId);
      const { phase, toolCallId, name, input } = data;
      if (id === undefined || (phase !== 'call' && phase !== 'result')) return messages;
      if (!text(toolCallId) || !text(name)) return messages;
      return replace(messages, id, (m) => {
        const invocations = [...(m.toolInvocations ?? [])];
        const at = invocations.findIndex((call) => call.toolCallId === toolCallId);
        const invocation: ToolInvocation = {
          toolCallId: toolCallId as string,
          toolName: name as string,
          state: phase,
          args: isObject(input) ? input : invocations[at]?.args,
          ...(phase === 'result' ? { result: data.output } : {}),
        };
        if (at < 0) invocations.push(invocation);
        else invocations[at] = invocation;
        return { ...m, toolInvocations: invocations };
      });
    }
    case 'alia.agent_end': {
      if (consultId === undefined || ledger.discarded.has(consultId)) return messages;
      const draftId = ledger.messages.get(consultId);
      const { status } = data;
      const messageId = text(data.messageId);
      if (status === 'completed' && messageId !== undefined) {
        // A stored completion is authoritative, even after a prior failed attempt.
        // Replaying it converges on the same row rather than reviving a failed draft.
        ledger.ended.add(consultId);
        return settleCompleted(
          messages,
          draftId,
          messageId,
          typeof data.content === 'string' ? data.content.trim() : undefined,
          ledger,
          consultId,
        );
      }
      if (ledger.ended.has(consultId) || !isLive(ledger, consultId)) return messages;
      // `room_continues` is the request letting go, never a failure.
      if (isObject(data.error) && data.error.code === 'room_continues') return messages;
      ledger.ended.add(consultId);
      if (draftId === undefined) return messages;
      if (status === 'declined') {
        ledger.discarded.add(consultId);
        return messages.filter((m) => m.id !== draftId);
      }
      return replace(messages, draftId, (m) => ({
        ...m,
        isStreaming: false,
        turnOutcome: status === 'failed' ? 'failed' : 'completed',
      }));
    }
    case 'group.message': {
      const reply = data.message;
      if (!isObject(reply)) return messages;
      const id = text(reply.id);
      if (id === undefined || (reply.role !== undefined && reply.role !== 'assistant')) {
        return messages;
      }
      // v2 room turns use their canonical reply ID as consultId. The stored
      // message can therefore repair a failed draft even if agent_end was lost.
      if (ledger.discarded.has(id)) return messages;
      const draftId = ledger.messages.get(id);
      const reconciled =
        draftId === undefined
          ? messages
          : settleCompleted(
              messages,
              draftId,
              id,
              typeof reply.content === 'string' ? reply.content : undefined,
              ledger,
              id,
            );
      if (draftId !== undefined) ledger.ended.add(id);
      if (reconciled.some((m) => m.id === id)) {
        return replace(reconciled, id, (m) => stored(m, reply));
      }
      return [...reconciled, stored({ id, role: 'assistant', content: '' }, reply)];
    }
    case 'group.idle': {
      // The room has ended. A failure must not look like deliberate silence.
      const failure = roomFailureReason(data.reason);
      // An old chain can finish after a new one starts. Unknown ownership is left
      // for the synthetic silence timeout, never guessed from a terminal event.
      if (chainId === undefined && data.reason !== 'silent') return messages;
      const open = [...ledger.messages].filter(
        ([cid]) =>
          !ledger.ended.has(cid) &&
          isLive(ledger, cid) &&
          (chainId === undefined || ledger.chains.get(cid) === chainId),
      );
      if (open.length === 0) return messages;
      const ids = new Set(open.map(([, id]) => id));
      for (const [cid] of open) ledger.ended.add(cid);
      return messages.flatMap((m) => {
        if (!ids.has(m.id)) return [m];
        if (m.content === '' && (m.toolInvocations?.length ?? 0) === 0) return [];
        return [
          {
            ...m,
            isStreaming: false,
            ...(failure === null ? {} : { turnOutcome: 'failed' as const }),
          },
        ];
      });
    }
    default:
      return messages;
  }
}
