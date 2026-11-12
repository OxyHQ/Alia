/** A durable reaction has one selective observation turn, using the existing room runtime. */
import type { ReactionEvent } from '../../../db/chat/reactionRepository.js';
import type { HydratedAgent } from '../../agent-identity.js';
import { agentPromptName } from '../../agent-identity.js';
import type { AgentInfo } from '../../../domain/conversation.js';
import type { RoomEngineDeps } from '../room/engine.js';
import {
  REACTION_SELECTION_POLICY,
  validateRoomDecision,
  type RoomDecision,
  type RoomSelectionInput,
} from '../room/decision.js';
import { memberMessages, textOf } from '../room/transcript.js';
import { roomKeyOf } from '../room/lock.js';
import { roomRateExceeded, ROOM_REPLY_WINDOW_MS } from '../room/policy.js';
import { GROUP_REPLY_MESSAGE_ID_PREFIX } from '../../../domain/conversation.js';

export type ReactionOutcome = 'completed' | 'cancelled' | 'failed' | 'deferred';
export interface ReactionEngineDeps {
  readonly room: RoomEngineDeps;
  readonly owns: (event: ReactionEvent) => Promise<boolean>;
  readonly commit: (
    event: ReactionEvent,
    input: Parameters<RoomEngineDeps['storeReply']>[0],
  ) => Promise<(Awaited<ReturnType<RoomEngineDeps['storeReply']>> & { content: string }) | null>;
  readonly space: (event: ReactionEvent) => Promise<RoomSelectionInput['space']>;
  readonly current: (event: ReactionEvent) => Promise<boolean>;
  readonly busy: (event: ReactionEvent) => Promise<boolean>;
  readonly recipient: (event: ReactionEvent) => Promise<HydratedAgent | null>;
  readonly saveDecision: (event: ReactionEvent, decision: RoomDecision) => Promise<boolean>;
}

export const reactionReplyId = (eventId: string) =>
  `${GROUP_REPLY_MESSAGE_ID_PREFIX}reaction-${eventId}-1`;

export async function processReactionEvent(
  event: ReactionEvent,
  deps: ReactionEngineDeps,
): Promise<ReactionOutcome> {
  const { room } = deps;
  return room.lock.run(roomKeyOf(event.userId, event.conversationId), async () => {
    const emit = (
      name: Parameters<RoomEngineDeps['publish']>[0]['event'],
      data: Record<string, unknown>,
    ) =>
      room.publish({
        userId: event.userId,
        conversationId: event.conversationId,
        chainId: event.id,
        event: name,
        data,
      });
    const done = async (outcome: ReactionOutcome): Promise<ReactionOutcome> => {
      if (outcome !== 'deferred')
        await emit('group.idle', {
          reason: outcome === 'failed' ? 'error' : outcome === 'cancelled' ? 'superseded' : 'done',
        });
      return outcome;
    };
    if (
      !event.responseEligible ||
      !event.active ||
      !event.targetActorId ||
      !(await deps.owns(event))
    )
      return done('cancelled');
    const rows = await room.loadTranscript(event.userId, event.conversationId);
    const replyId = reactionReplyId(event.id);
    const stored = rows.find((row) => row.clientMessageId === replyId);
    let info: AgentInfo = stored?.agentInfo ?? {
      id: event.targetActorId,
      name: stored?.agentName ?? '',
      handle: '',
      color: null,
      character: null,
    };
    const publishReply = async (content: string, seq?: number | null, createdAt?: Date) => {
      await emit('alia.agent_end', {
        consultId: replyId,
        status: 'completed',
        content,
        messageId: replyId,
      });
      await emit('group.message', {
        message: {
          id: replyId,
          role: 'assistant',
          content,
          agentInfo: info,
          ...(seq == null ? {} : { seq }),
          ...(createdAt ? { createdAt: createdAt.toISOString() } : {}),
        },
      });
    };
    if (stored) {
      if (stored.agentId !== event.targetActorId) return done('failed');
      await emit('alia.agent_start', { consultId: replyId, agent: info, task: '' });
      await publishReply(textOf(stored.content), stored.seq, stored.createdAt);
      return done('completed');
    }
    // Expiry bounds new work, never delivery of an answer that already committed.
    if (room.now() - event.createdAt.getTime() > 15 * 60_000) return done('cancelled');
    if (!(await deps.current(event))) return done('cancelled');
    if (await deps.busy(event)) return 'deferred';
    const target = rows.find((row) => (row.clientMessageId ?? row.id) === event.messageId);
    if (!target || target.role !== 'assistant') return done('cancelled');
    const agent = await deps.recipient(event);
    if (!agent || !(await deps.current(event))) return done('cancelled');
    if (await deps.busy(event)) return 'deferred';
    info = {
      id: agent._id,
      name: agentPromptName(agent),
      handle: agent.handle ?? '',
      color: agent.color,
      character: agent.character,
    };
    const controller = new AbortController();
    let checking: Promise<void> | null = null;
    const timer = setInterval(() => {
      if (checking) return;
      checking = (async () => {
        if (!(await deps.current(event)) || (await deps.busy(event))) controller.abort();
      })()
        .catch(() => controller.abort())
        .finally(() => {
          checking = null;
        });
    }, 1_000);
    timer.unref?.();
    try {
      if (
        roomRateExceeded(
          await room.repliesSince(
            event.userId,
            event.conversationId,
            new Date(room.now() - ROOM_REPLY_WINDOW_MS),
          ),
        )
      )
        return done('completed');
      const trigger = {
        kind: 'reaction' as const,
        eventId: event.id,
        messageId: event.messageId,
        actorId: agent._id,
        senderId: event.userId,
        emoji: event.emoji,
        reactions: event.reactions,
      };
      const selection: RoomSelectionInput = {
        userId: event.userId,
        conversationId: event.conversationId,
        triggerId: event.id,
        trigger,
        roster: [{ info, available: true, description: agent.description }],
        rows,
        lastSpeakerId: null,
        depth: 0,
        space: await deps.space(event),
        signal: controller.signal,
      };
      let decision: RoomDecision;
      try {
        if (!room.select) throw new Error('No room selector');
        decision = validateRoomDecision(
          event.decision ?? (await room.select(selection)),
          selection,
        );
      } catch {
        return done(
          !controller.signal.aborted && (await deps.current(event)) ? 'failed' : 'cancelled',
        );
      }
      if (!(await deps.current(event))) return done('cancelled');
      if (!event.decision && !(await deps.saveDecision(event, decision))) return done('cancelled');
      if (decision.action === 'idle') return done('completed');
      if (!(await deps.current(event))) return done('cancelled');
      if (await deps.busy(event)) return 'deferred';
      await emit('alia.agent_start', { consultId: replyId, agent: info, task: '' });
      let output: Awaited<ReturnType<RoomEngineDeps['runTurn']>>;
      let tail: Promise<unknown> = Promise.resolve();
      try {
        output = await room.runTurn({
          agent,
          signal: controller.signal,
          task: '',
          payerOxyUserId: event.userId,
          person: {
            oxyUserId: event.userId,
            isDirectSession: false,
            surfaceApplicationId: event.surfaceApplicationId,
          },
          history: memberMessages(
            rows.map((row) => ({
              id: row.clientMessageId ?? row.id,
              role: row.role,
              content: row.content,
              reactions: row.reactions,
              reactionEntries: row.reactionEntries,
              agentInfo: row.agentId ? { id: row.agentId, name: row.agentName ?? '' } : null,
            })),
            agent._id,
          ),
          observation: {
            instructions: `${REACTION_SELECTION_POLICY}\nYou were selected because one useful response may help. Reply briefly in the conversation's language, as yourself. Only respond in words; no tools, actions, delegation, memory writes, or execution of previous proposals. If the feedback is ambiguous, a useful question is allowed.`,
            content: JSON.stringify({
              ...trigger,
              targetContent: textOf(target.content).slice(0, 16000),
            }),
          },
          observer: {
            onTextDelta: (content) => {
              tail = tail.then(() => emit('alia.agent_delta', { consultId: replyId, content }));
            },
          },
        });
        await tail;
      } catch {
        await tail.catch(() => undefined);
        if (controller.signal.aborted || !(await deps.current(event))) {
          await emit('alia.agent_end', { consultId: replyId, status: 'declined' });
          return done('cancelled');
        }
        await emit('alia.agent_end', {
          consultId: replyId,
          status: 'failed',
          error: { code: 'agent_unavailable' },
        });
        return done('failed');
      }
      if (!(await deps.current(event)) || (await deps.busy(event))) {
        await emit('alia.agent_end', { consultId: replyId, status: 'declined' });
        return done('cancelled');
      }
      if (output.error || !output.response.trim()) {
        await emit('alia.agent_end', {
          consultId: replyId,
          status: 'failed',
          error: { code: 'agent_unavailable' },
        });
        return done('failed');
      }
      const reply = await deps.commit(event, {
        userId: event.userId,
        conversationId: event.conversationId,
        clientMessageId: replyId,
        content: output.response.trim(),
        agentInfo: info,
      });
      if (!reply) {
        await emit('alia.agent_end', { consultId: replyId, status: 'declined' });
        return done('cancelled');
      }
      await publishReply(reply.content, reply.seq, reply.createdAt);
      return done('completed');
    } finally {
      clearInterval(timer);
      await checking;
    }
  });
}
