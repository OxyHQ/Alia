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
import { WorkspaceMemory } from './workspace-memory.js';
import { TerminalSession } from './terminal-session.js';
import { BrowserSession } from './browser-session.js';
import { EventStream } from './event-stream.js';
import { cleanupSessionResources } from './session-resources.js';
import { withAgentAdmission } from '../../db/agents/agentRuntimeRepository.js';
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
    const admission = await withAgentAdmission(getDb(), input.agent._id, input.agent.maxConcurrentThreads, (tx) =>
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
    const workspaceMemory = new WorkspaceMemory();
    const eventStream = new EventStream({ agentId: input.agent._id, sessionId: session._id });
    const terminalSession = new TerminalSession({
      sessionId: session._id,
      agentId: input.agent._id,
      userId: input.oxyUserId,
      workspaceMemory,
      image: input.agent.preferredImage ?? undefined,
      onContainerCreated: async (containerId) => {
        eventStream.append('observation', `Sandbox ready: ${containerId}`, { toolName: 'shell' });
      },
    });
    const browserSession = new BrowserSession({ agentId: input.agent._id, sessionId: session._id });
    let completedResult: string | undefined;
    const runtime: AgentRuntimeContext = {
      session,
      todoManager,
      workspaceMemory,
      terminalSession,
      browserSession,
      eventStream,
      onComplete: (result) => { completedResult = result; },
    };
    eventStream.append('user_message', input.task);

    let settlement: Promise<void> | null = null;
    const settle = (status: 'completed' | 'failed', result: string): Promise<void> => {
      // A successful inference turn is over before its disposable browser and
      // sandbox resources have finished tearing down. Release admission first:
      // the client is allowed to send its next turn as soon as it receives
      // [DONE], and counting cleanup time as active work made that immediate
      // follow-up lose a race against maxConcurrentThreads=1.
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
        await browserSession.close().catch((err: unknown) => {
          log.agents.warn({ err, sessionId: session._id }, 'Failed to close agent browser session');
        });
        await cleanupSessionResources(session._id, input.oxyUserId).catch((err: unknown) => {
          log.agents.warn({ err, sessionId: session._id }, 'Failed to clean up agent session resources');
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
