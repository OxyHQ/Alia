/**
 * Makes a linked-agent chat request one durable, tool-capable turn instead of
 * launching an unrelated autonomous session beside it.
 */
import { getDb } from '../../db/index.js';
import { findConversation } from '../../db/chat/conversationRepository.js';
import { createAgentSession, updateAgentSession } from '../../db/agents/agentSessionRepository.js';
import type { HydratedAgent } from '../agent-identity.js';
import type { AgentRuntimeContext } from './actions.js';
import { TodoManager } from './todo-manager.js';
import { BrowserSession } from './browser-session.js';
import { EventStream } from './event-stream.js';
import { withAgentAdmission } from '../../db/agents/agentRuntimeRepository.js';
import { startAgentSession } from './session-handoff.js';
import { log } from '../logger.js';

export interface CoordinatedAgentTurn {
  id: string;
  runtime: AgentRuntimeContext;
  complete(result?: string): Promise<void>;
  fail(error: unknown): Promise<void>;
}

export class AgentTurnCoordinator {
  static async begin(input: {
    agent: HydratedAgent;
    oxyUserId: string;
    conversationId?: string;
    task: string;
  }): Promise<CoordinatedAgentTurn> {
    const conversation = input.conversationId
      ? await findConversation(getDb(), input.oxyUserId, input.conversationId)
      : undefined;
    const admission = await withAgentAdmission(getDb(), { agentId: input.agent._id, oxyUserId: input.oxyUserId }, input.agent.maxConcurrentThreads, (tx) =>
      createAgentSession(tx, {
        agentId: input.agent._id,
        oxyUserId: input.oxyUserId,
        task: input.task.slice(0, 2000) || 'Continue the agent thread',
        status: 'running',
        // The route has an 80-second hard deadline. This explicit two-minute
        // lease covers that request with margin and is the proof admission uses
        // after a process/socket dies; autonomous sessions have no chat lease.
        chatLeaseExpiresAt: new Date(Date.now() + 120_000),
        threadId: conversation?.agentThreadId ?? undefined,
        conversationId: input.conversationId,
      }),
    );
    if (!admission.admitted) throw new Error('Agent concurrency limit reached');
    const session = admission.value;
    const startedAt = new Date();
    await updateAgentSession(getDb(), session._id, {
      stats: { startedAt, lastActivityAt: startedAt },
    });

    const todoManager = new TodoManager();
    const eventStream = new EventStream({ agentId: input.agent._id, sessionId: session._id });
    const browserSession = new BrowserSession();
    let completedResult: string | undefined;
    const runtime: AgentRuntimeContext = {
      session,
      todoManager,
      browserSession,
      eventStream,
      onComplete: (result) => { completedResult = result; },
      /**
       * A chat turn has 80 seconds. Work that needs longer is handed to a
       * durable background run of the same agent, which resumes across
       * restarts and writes its result into this conversation when it is done.
       */
      continueInBackground: async (task) => {
        const admission = await withAgentAdmission(
          getDb(),
          { agentId: input.agent._id, oxyUserId: input.oxyUserId },
          input.agent.maxConcurrentThreads,
          () => startAgentSession({
            agent: input.agent,
            userId: input.oxyUserId,
            task: task.slice(0, 2000),
            origin: 'delegation',
            ...(conversation?.agentThreadId ? { threadId: conversation.agentThreadId } : {}),
          }),
        );
        if (!admission.admitted) return 'Not started: you already have as much work running for this person as you may. Tell them, and do what you can now.';
        const handoff = admission.value;
        if (!handoff.ok) {
          return handoff.reason === 'insufficient_credits'
            ? 'Not started: the person does not have enough credits for background work. Tell them.'
            : 'Not started: the background run could not be queued. Do what you can now.';
        }
        return 'Started. It runs in the background and its result will be posted in this conversation when done. Tell the person briefly that you are on it; do not do the same work now.';
      },
    };
    eventStream.append('user_message', input.task);

    let settlement: Promise<void> | null = null;
    const settle = (status: 'completed' | 'failed', result: string): Promise<void> => {
      // Admission is released by the status write, and nothing slow may sit
      // before it: the client is allowed to send its next turn as soon as it
      // receives [DONE], and counting cleanup time as active work made that
      // immediate follow-up lose a race against maxConcurrentThreads=1. (There
      // used to be a disposable browser to tear down here; the Clarity-only
      // browser holds nothing to close.)
      settlement ??= (async () => {
        eventStream.append(status === 'completed' ? 'complete' : 'error', result);
        await eventStream.flush().catch((err: unknown) => {
          log.agents.warn({ err, sessionId: session._id }, 'Failed to flush final agent events');
        });
        await updateAgentSession(getDb(), session._id, {
          status,
          result,
          chatLeaseExpiresAt: null,
          stats: { completedAt: new Date(), lastActivityAt: new Date() },
        });
      })();
      return settlement;
    };

    return {
      id: session._id,
      runtime,
      complete: async (result = completedResult ?? 'Completed in the agent thread') => settle('completed', result),
      fail: async (error) => settle('failed', error instanceof Error ? error.message : String(error)),
    };
  }
}
