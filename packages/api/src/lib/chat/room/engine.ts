/**
 * The room engine: one STEP of a group room's chain (ADR 0025).
 *
 * A chain is the answer to one message of the person. It is a sequence of steps, one member each,
 * and each step is a job (`queue.ts`): take the room's lock, check the chain is still the latest,
 * read the transcript as it is NOW, run the member's turn (`runAgentTurn`, so credits, memory per
 * actor and typed failures are the agent turn's own), store the reply, publish what happened, decide
 * who speaks next (structured v2 selection; legacy jobs drain through `planNext`) and enqueue that step. Nothing here knows about HTTP.
 *
 * ## Failure semantics
 *
 * A member's failure (no credits, a gate, a timeout, an unreachable agent) ends THAT turn with
 * `alia.agent_end` `failed`; nothing is stored and the chain goes on to the next member. A member
 * that declines ({@link PASS_SENTINEL}) ends its turn with `declined`; nothing is stored and it is
 * not an error. An infrastructure error (database, lock) is thrown to the queue, which retries the
 * step; the reply's id is derived from the step, so a retry after the reply was stored does not
 * answer twice.
 */

import type { RoomDecision, RoomSelectionInput, RoomSpeakerDecision } from './decision.js';
import { validateRoomDecision } from './decision.js';
import { randomUUID } from 'node:crypto';
import type { HydratedAgent } from '../../agent-identity.js';
import type { AgentInfo } from '../../../domain/conversation.js';
import { getErrorMessage } from '../../errors/index.js';
import { log } from '../../logger.js';
import type { AgentTurnResult, runAgentTurn } from '../../tools/agent-turn.js';
import type { RoomEvent } from './bus.js';
import { roomKeyOf, type RoomLock } from './lock.js';
import {
  type ChainState,
  type RoomMember,
  ROOM_REPLY_WINDOW_MS,
  MAX_REPLIES_PER_MESSAGE,
  MAX_TURNS_PER_MESSAGE,
  roomInstructions,
  createPassGate,
  isPass,
  isSuperseded,
  planNext,
  roomPrompt,
  roomRateExceeded,
} from './policy.js';
import { type GroupInputMessage, historyForMembers, memberMessages, textOf } from './transcript.js';
import { GROUP_REPLY_MESSAGE_ID_PREFIX } from '../../../domain/conversation.js';

/** One step of a chain, as the queue carries it. JSON only: it crosses Redis. */
export interface RoomJobData {
  /** v1 jobs drain on the legacy queue; only v2 jobs are created now. */
  readonly version?: 2;
  readonly phase?: 'select' | 'speak';
  readonly decision?: RoomSpeakerDecision;
  readonly userId: string;
  readonly conversationId: string;
  /** The person message (row id) this chain answers: its identity. */
  readonly triggerId: string;
  /** The members the chain may use, authorized when it started. Mentions never leave this list. */
  readonly roster: readonly RoomMember[];
  /** Who speaks in this step. */
  readonly speakerId: string;
  /** The member that handed the floor to this one by `@mention`, or `null` for the person's own turn. */
  readonly handedByAgentId: string | null;
  /** Members still to speak after this step. */
  readonly pending: readonly string[];
  readonly depth: number;
  readonly replies: number;
  /** Turns already taken: the index of this one. */
  readonly turns: number;
  readonly lastSpeakerId: string | null;
  readonly surfaceApplicationId: string | null;
  /** The space this room is the room of (ADR 0028): its name and brief, fixed when the chain started. */
  readonly space?: { readonly name: string; readonly instructions: string } | null;
}

/** A stored message as the engine reads it. */
export interface TranscriptRow {
  readonly id: string;
  readonly clientMessageId: string | null;
  readonly role: string;
  readonly content: unknown;
  readonly agentName: string | null;
  readonly agentId?: string | null;
  readonly seq?: number | null;
  readonly createdAt?: Date;
}

interface StoredReply {
  readonly id: string;
  readonly seq: number;
  readonly createdAt: Date;
}

export interface RoomEngineDeps {
  readonly select?: (input: RoomSelectionInput) => Promise<RoomDecision>;
  readonly lock: RoomLock;
  readonly publish: (event: RoomEvent) => Promise<void> | void;
  /** Queues the next step. */
  readonly enqueue: (job: RoomJobData) => Promise<void>;
  /** The primary key of the person's newest message in the conversation. */
  readonly latestPersonMessageId: (
    userId: string,
    conversationId: string,
  ) => Promise<string | null>;
  readonly loadTranscript: (userId: string, conversationId: string) => Promise<TranscriptRow[]>;
  readonly repliesSince: (userId: string, conversationId: string, since: Date) => Promise<number>;
  readonly loadAgent: (agentId: string) => Promise<HydratedAgent | null>;
  readonly runTurn: typeof runAgentTurn;
  readonly storeReply: (input: {
    readonly userId: string;
    readonly conversationId: string;
    readonly clientMessageId: string;
    readonly content: string;
    readonly agentInfo: AgentInfo;
  }) => Promise<StoredReply>;
  readonly revokeTasks: (taskIds: readonly string[]) => Promise<void>;
  readonly now: () => number;
  /** Waits between attempts to store a reply that did not store. Defaults to {@link STORE_RETRY_DELAYS_MS}. */
  readonly storeRetryDelaysMs?: readonly number[];
}

/**
 * Pauses before each further attempt to store a finished reply. The member's turn is already paid
 * for, so a database that blinks is waited out here instead of being answered with a lost reply.
 */
const STORE_RETRY_DELAYS_MS: readonly number[] = [150, 500];

/**
 * A reply could not be stored after every attempt. Thrown out of the step (never turned into the
 * member's `failed`), so the queue retries the step instead of the room silently losing a paid reply.
 */
class RoomStoreError extends Error {
  constructor(cause: unknown) {
    super(`Could not store a room reply: ${getErrorMessage(cause)}`, { cause });
    this.name = 'RoomStoreError';
  }
}

async function storeWithRetry(
  deps: RoomEngineDeps,
  input: Parameters<RoomEngineDeps['storeReply']>[0],
): Promise<StoredReply> {
  const delays = deps.storeRetryDelaysMs ?? STORE_RETRY_DELAYS_MS;
  let lastError: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      return await deps.storeReply(input);
    } catch (error: unknown) {
      lastError = error;
      log.general.warn(
        { err: error, conversationId: input.conversationId, attempt: attempt + 1 },
        'Could not store a room reply',
      );
      const delay = delays[attempt];
      if (delay !== undefined) await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new RoomStoreError(lastError);
}

export type RoomStepOutcome = 'skipped' | 'ended' | 'continued';

/** The id a step's reply is stored under: derived, so a retried step finds its own reply. */
export const replyIdOf = (triggerId: string, turn: number) =>
  `${GROUP_REPLY_MESSAGE_ID_PREFIX}${triggerId}-${turn}`;

const infoOf = (roster: readonly RoomMember[], agentId: string) =>
  roster.find((member) => member.info.id === agentId);

/** Run one step of a chain, serialized with every other step of the same room. */
export function processRoomStep(data: RoomJobData, deps: RoomEngineDeps): Promise<RoomStepOutcome> {
  return deps.lock.run(roomKeyOf(data.userId, data.conversationId), () => runStep(data, deps));
}

async function runStep(data: RoomJobData, deps: RoomEngineDeps): Promise<RoomStepOutcome> {
  const { userId, conversationId, triggerId } = data;
  // Events leave in the order they were made: a delta never overtakes the one before it.
  let tail: Promise<unknown> = Promise.resolve();
  const emit = (event: RoomEvent['event'], body: Record<string, unknown>): Promise<void> => {
    const sent = tail
      .then(() => deps.publish({ userId, conversationId, chainId: triggerId, event, data: body }))
      .catch((err: unknown) => log.general.warn({ err, event }, 'Could not publish a room event'));
    tail = sent;
    return sent;
  };
  const end = async (reason: string, outcome: RoomStepOutcome): Promise<RoomStepOutcome> => {
    await deps
      .revokeTasks(data.roster.flatMap((member) => (member.oxyTaskId ? [member.oxyTaskId] : [])))
      .catch((err: unknown) =>
        log.general.warn({ err, conversationId }, 'Could not revoke room tasks'),
      );
    await emit('group.idle', { reason });
    return outcome;
  };

  // A newer person message supersedes this chain: the latest one is the one being answered.
  const latest = await deps.latestPersonMessageId(userId, conversationId);
  if (isSuperseded(triggerId, latest)) return end('superseded', 'skipped');

  const since = new Date(deps.now() - ROOM_REPLY_WINDOW_MS);
  if (roomRateExceeded(await deps.repliesSince(userId, conversationId, since))) {
    return end('rate_limited', 'ended');
  }

  const rows = await deps.loadTranscript(userId, conversationId);
  const triggerIndex = rows.findIndex((row) => row.id === triggerId);
  if (triggerIndex === -1) return end('superseded', 'skipped');

  if (data.version === 2) {
    if (data.turns >= MAX_TURNS_PER_MESSAGE) return end('turn_cap', 'ended');
    if (data.replies >= MAX_REPLIES_PER_MESSAGE) return end('reply_cap', 'ended');
    if (data.phase === 'select') {
      const selectionInput: RoomSelectionInput = {
        userId,
        conversationId,
        triggerId,
        roster: data.roster,
        rows,
        lastSpeakerId: data.lastSpeakerId,
        depth: data.depth,
        space: data.space,
      };
      let decision: RoomDecision;
      try {
        if (!deps.select) throw new Error('No room selector configured');
        decision = validateRoomDecision(await deps.select(selectionInput), selectionInput);
      } catch {
        if (isSuperseded(triggerId, await deps.latestPersonMessageId(userId, conversationId))) {
          return end('superseded', 'skipped');
        }
        // Model errors may contain prompts. Log only identifiers, never the raw generation error.
        log.agents.warn({ conversationId, triggerId }, 'Room selection failed');
        return end('error', 'ended');
      }
      if (isSuperseded(triggerId, await deps.latestPersonMessageId(userId, conversationId))) {
        return end('superseded', 'skipped');
      }
      if (decision.action === 'idle') return end('done', 'ended');
      if (decision.action === 'unavailable') return end('error', 'ended');
      const speaker = decision.agentId!;
      await deps.enqueue({
        ...data,
        phase: 'speak',
        speakerId: speaker,
        decision: { ...decision, action: decision.action, agentId: speaker },
        handedByAgentId: decision.reason === 'handoff' ? data.lastSpeakerId : null,
        depth: data.depth + (decision.reason === 'handoff' ? 1 : 0),
        turns: data.turns + 1,
      });
      return 'continued';
    }
    // A speak job contains the validated decision chosen before it was queued.
    if (data.phase !== 'speak' || !data.decision || data.decision.agentId !== data.speakerId) {
      return end('error', 'ended');
    }
    if (infoOf(data.roster, data.speakerId)?.available === false) return end('error', 'ended');
  }

  const member = infoOf(data.roster, data.speakerId);
  const replyId = replyIdOf(triggerId, data.turns);
  const alreadyStored = rows.find((row) => row.clientMessageId === replyId);

  let reply: string | null = null;
  if (alreadyStored) {
    // A retried step whose reply was stored before the failure: it spoke, do not answer twice.
    if (data.version === 2 && alreadyStored.agentId !== data.speakerId)
      return end('error', 'ended');
    reply = textOf(alreadyStored.content);
    if (data.version === 2 && member) {
      // The database commit may have preceded a lost event or failed next-job enqueue. Replay the
      // SAME consultation and stored message so every subscriber converges, without another turn.
      await emit('alia.agent_start', {
        consultId: replyId,
        agent: member.info,
        task: textOf(rows[triggerIndex]?.content),
      });
      await emit('alia.agent_end', {
        consultId: replyId,
        status: 'completed',
        content: reply,
        messageId: replyId,
      });
      await emit('group.message', {
        message: {
          id: replyId,
          role: 'assistant',
          content: reply,
          agentInfo: member.info,
          ...(alreadyStored.seq == null ? {} : { seq: alreadyStored.seq }),
          ...(alreadyStored.createdAt ? { createdAt: alreadyStored.createdAt.toISOString() } : {}),
        },
      });
    }
  } else if (member) {
    reply = await speak({ data, deps, member, rows, triggerIndex, replyId, emit });
  }

  if (data.version === 2) {
    if (isSuperseded(triggerId, await deps.latestPersonMessageId(userId, conversationId))) {
      return end('superseded', 'skipped');
    }
    if (reply === null) return end('error', 'ended');
    if (data.decision?.action === 'clarify') return end('done', 'ended');
    const { decision: _decision, ...nextData } = data;
    await deps.enqueue({
      ...nextData,
      phase: 'select',
      speakerId: '',
      handedByAgentId: null,
      turns: data.turns + 1,
      replies: data.replies + 1,
      lastSpeakerId: data.speakerId,
    });
    return 'continued';
  }

  const state: ChainState = {
    pending: data.pending,
    depth: data.depth,
    replies: data.replies + (reply === null ? 0 : 1),
    turns: data.turns + 1,
    lastSpeakerId: reply === null ? data.lastSpeakerId : data.speakerId,
  };
  const next = planNext({
    roster: data.roster.map((m) => m.info),
    speakerId: data.speakerId,
    reply,
    state,
  });
  const [nextSpeaker, ...rest] = next.queue;
  if (nextSpeaker === undefined) return end(next.stop ?? 'done', 'ended');

  await deps.enqueue({
    ...data,
    speakerId: nextSpeaker,
    // The depth only rises when the reply handed the floor on, and then the handed member is first.
    handedByAgentId: next.depth > data.depth ? data.speakerId : null,
    pending: rest,
    depth: next.depth,
    replies: state.replies,
    turns: state.turns,
    lastSpeakerId: state.lastSpeakerId,
  });
  return 'continued';
}

/** One member's turn. Resolves with the text it stored, or `null` when it failed or declined. */
async function speak(input: {
  readonly data: RoomJobData;
  readonly deps: RoomEngineDeps;
  readonly member: RoomMember;
  readonly rows: readonly TranscriptRow[];
  readonly triggerIndex: number;
  readonly replyId: string;
  readonly emit: (event: RoomEvent['event'], body: Record<string, unknown>) => Promise<void>;
}): Promise<string | null> {
  const { data, deps, member, rows, triggerIndex, replyId, emit } = input;
  const { info } = member;
  const consultId = data.version === 2 ? replyId : randomUUID();
  const roster = data.roster.map((m) => m.info);
  const originalText = textOf(rows[triggerIndex]?.content);
  const personText = data.version === 2 ? originalText : originalText.trim();

  const fail = async (error: Record<string, unknown>) => {
    await emit('alia.agent_end', { consultId, status: 'failed', error });
    return null;
  };

  try {
    const agent = await deps.loadAgent(info.id);
    if (
      data.version === 2 &&
      isSuperseded(
        data.triggerId,
        await deps.latestPersonMessageId(data.userId, data.conversationId),
      )
    )
      return null;
    await emit('alia.agent_start', {
      consultId,
      agent: {
        id: info.id,
        name: info.name,
        handle: info.handle,
        color: info.color,
        character: info.character,
      },
      task: personText,
    });
    if (agent === null) return await fail({ code: 'agent_unavailable' });

    const handedBy =
      data.handedByAgentId === null
        ? null
        : (infoOf(data.roster, data.handedByAgentId)?.info.name ?? null);
    const asRow = (row: TranscriptRow): GroupInputMessage => ({
      role: row.role,
      content: row.content,
      agentInfo:
        row.agentName === null ? null : { id: row.agentId ?? undefined, name: row.agentName },
    });
    const history = historyForMembers(rows.slice(0, triggerIndex + 1).map(asRow), info.id);
    const since = rows
      .slice(triggerIndex + 1)
      .filter((row) => row.role === 'assistant' && row.agentName !== null)
      .map((row) => ({ name: row.agentName!, content: textOf(row.content).trim() }))
      .filter((reply) => reply.content !== '');

    // Deltas are held while they could still be the decline sentinel, so it is never shown.
    const gate = createPassGate((content) => {
      void emit('alia.agent_delta', { consultId, content });
    });
    const outcome: AgentTurnResult = await deps.runTurn({
      agent,
      task:
        data.version === 2
          ? personText
          : roomPrompt({
              self: info,
              roster,
              personText,
              since,
              handedBy,
              space: data.space ?? null,
            }),
      history,
      ...(data.version === 2
        ? {
            room: {
              instructions: roomInstructions({
                self: info,
                roster,
                clarify: data.decision?.action === 'clarify',
                space: data.space,
              }),
              observations: memberMessages(rows.slice(triggerIndex + 1).map(asRow), info.id),
            },
          }
        : {}),
      person: {
        oxyUserId: data.userId,
        isDirectSession: false,
        ...(member.oxyTaskId ? { taskId: member.oxyTaskId } : {}),
        surfaceApplicationId: data.surfaceApplicationId,
      },
      payerOxyUserId: data.userId,
      observer: {
        onTextDelta: (content) =>
          data.version === 2
            ? void emit('alia.agent_delta', { consultId, content })
            : gate.push(content),
        onToolCall: ({ toolCallId, name, input: args }) => {
          void emit('alia.agent_tool', { consultId, phase: 'call', toolCallId, name, input: args });
        },
        onToolResult: ({ toolCallId, name, output }) => {
          void emit('alia.agent_tool', {
            consultId,
            phase: 'result',
            toolCallId,
            name,
            output,
          });
        },
      },
    });
    const passed = data.version !== 2 && gate.finish();

    if (outcome.error !== undefined || outcome.response.trim() === '') {
      return await fail(
        outcome.refusal
          ? { code: outcome.refusal.code, feature: outcome.refusal.feature }
          : { code: 'agent_unavailable' },
      );
    }
    if (data.version !== 2 && (passed || isPass(outcome.response))) {
      await emit('alia.agent_end', { consultId, status: 'declined' });
      return null;
    }

    if (
      data.version === 2 &&
      isSuperseded(
        data.triggerId,
        await deps.latestPersonMessageId(data.userId, data.conversationId),
      )
    ) {
      await emit('alia.agent_end', { consultId, status: 'declined' });
      return null;
    }
    const content = outcome.response.trim();
    const stored = await storeWithRetry(deps, {
      userId: data.userId,
      conversationId: data.conversationId,
      clientMessageId: replyId,
      content,
      agentInfo: info,
    });
    await emit('alia.agent_end', {
      consultId,
      status: 'completed',
      content: outcome.response,
      messageId: stored.id,
    });
    await emit('group.message', {
      message: {
        id: stored.id,
        role: 'assistant',
        content,
        agentInfo: info,
        seq: stored.seq,
        createdAt: stored.createdAt.toISOString(),
      },
    });
    return content;
  } catch (error: unknown) {
    if (error instanceof RoomStoreError) {
      // Infrastructure, not the member: close its turn for the watchers, then let the queue retry the
      // step (the reply id is derived from the step, so a retry that finds it stored does not repeat).
      await emit('alia.agent_end', {
        consultId,
        status: 'failed',
        error: { code: 'store_failed' },
      });
      throw error;
    }
    log.general.error({ err: error, agentId: info.id }, 'A group member failed');
    return fail({ code: 'agent_unavailable', message: getErrorMessage(error) });
  }
}

/**
 * A step the queue gave up on (its retries are spent): end the chain for the watchers and give the
 * members' task authority back, so a room never stays "typing" and no task outlives its chain.
 */
export async function abandonRoomChain(data: RoomJobData, deps: RoomEngineDeps): Promise<void> {
  await deps
    .revokeTasks(data.roster.flatMap((member) => (member.oxyTaskId ? [member.oxyTaskId] : [])))
    .catch((err: unknown) => log.general.warn({ err }, 'Could not revoke room tasks'));
  await Promise.resolve(
    deps.publish({
      userId: data.userId,
      conversationId: data.conversationId,
      chainId: data.triggerId,
      event: 'group.idle',
      data: { reason: 'error' },
    }),
  );
}
