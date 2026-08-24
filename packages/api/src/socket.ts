import { Server, type Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import http from 'http';
import { getRedisClient, getRedisSubClient } from './lib/redis.js';
import { log } from './lib/logger.js';
import { oxyClient } from './middleware/auth.js';
import { getDb } from './db/index.js';
import { agentIsOwnedBy } from './db/agents/agentRepository.js';
import {
  accountHasSessionWithAgent,
  agentSessionIsOwnedBy,
} from './db/agents/agentSessionRepository.js';
import { canvasSessionExists } from './db/chat/canvasSessionRepository.js';
import { findExecutionOwner } from './db/automation/workflowRepository.js';
import {
  deliverUserRuntimeMessage,
  userRuntimeRoom,
  type UserRuntimePresence,
} from './lib/inference/user-runtime-bridge.js';

/** Read the authenticated user id planted on the socket by `oxy.authSocket()`. */
function socketUserId(socket: Socket): string | null {
  const fromData = socket.data?.userId;
  if (typeof fromData === 'string' && fromData.length > 0) return fromData;
  return null;
}

/**
 * True if the authenticated user owns the given agent session.
 *
 * The `/^[a-f0-9]{24}$/` shape check this opened with is GONE with the ids it
 * described. Ids are uuid v7 now, so it rejected every real session — and its
 * failure mode is silent: a `subscribe-agent-session` that returns without
 * joining and without an error, so the agent panel simply never receives an
 * event and looks like a stalled run.
 *
 * An EXISTS, not a fetch-then-compare: a permission gate that hands back the row
 * is one edit from being a leak.
 */
async function ownsAgentSession(userId: string, sessionId: string): Promise<boolean> {
  return await agentSessionIsOwnedBy(getDb(), sessionId, userId);
}

/**
 * Validate a runtime offer before it is kept on the socket.
 *
 * The model list is capped: it is client-supplied, it is broadcast to the
 * person's other devices, and `fetchSockets()` carries it between tasks.
 */
function runtimeOffer(value: unknown): UserRuntimePresence | null {
  if (typeof value !== 'object' || value === null) return null;
  const { id, label, models } = value as Record<string, unknown>;
  if (typeof id !== 'string' || id.length === 0 || id.length > 128) return null;
  if (typeof label !== 'string' || label.length > 128) return null;
  if (!Array.isArray(models)) return null;
  const names = models.filter((m): m is string => typeof m === 'string' && m.length > 0 && m.length <= 200);
  if (names.length === 0 || names.length > 200) return null;
  return { id, label, models: names };
}

const ALLOWED_ORIGINS = [
  process.env.WEB_URL || 'http://localhost:4150',
  'https://alia.onl',
  'https://console.alia.onl',
];

let io: Server | null = null;

export function initSocket(server: http.Server) {
  io = new Server(server, {
    cors: {
      origin: ALLOWED_ORIGINS,
      methods: ['GET', 'POST'],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });

  // Attach Redis adapter for horizontal scaling
  const pubClient = getRedisClient();
  const subClient = getRedisSubClient();
  if (pubClient && subClient) {
    Promise.all([pubClient.connect(), subClient.connect()])
      .then(() => {
        io!.adapter(createAdapter(pubClient, subClient));
        log.general.info('Socket.IO Redis adapter attached');
      })
      .catch((err) => {
        log.general.warn({ err }, 'Socket.IO Redis adapter failed — using in-memory');
      });
  }
  // Authenticate every connection. `oxy.authSocket()` validates the handshake
  // bearer token, plants `socket.data.userId`, and rejects unauthenticated /
  // invalid / expired tokens before any `connection` handler runs.
  io.use(oxyClient.authSocket({ debug: process.env.NODE_ENV !== 'production' }));

  io.on('connection', (socket) => {
    const userId = socketUserId(socket);

    socket.on('subscribe-telegram-token', (token: string) => {
      // Telegram link tokens are short-lived, single-use codes minted for the
      // authenticated user who initiated linking; the room is the token itself.
      if (typeof token !== 'string' || token.length === 0 || token.length > 256) return;
      Promise.resolve(socket.join(`telegram-token:${token}`)).catch((err) => log.general.warn({ err }, 'socket.join telegram-token failed'));
    });

    socket.on('subscribe-workflow', async (executionId: string) => {
      if (typeof executionId !== 'string' || executionId.length === 0 || executionId.length > 256) return;
      if (!userId) return;
      // `oxy_user_id` is `text`, so the source's `.toString()` on a stored
      // ObjectId has no counterpart — but the comparison it guarded does, and it
      // is the whole access check for this room.
      const owner = await findExecutionOwner(getDb(), executionId);
      if (owner !== userId) return;
      Promise.resolve(socket.join(`workflow:${executionId}`)).catch((err) => log.general.warn({ err }, 'socket.join workflow failed'));
    });

    socket.on('subscribe-canvas', async (conversationId: string) => {
      if (typeof conversationId !== 'string' || conversationId.length === 0 || conversationId.length > 256) return;
      if (!userId) return;
      if (!(await canvasSessionExists(getDb(), userId, conversationId))) return;
      Promise.resolve(socket.join(`canvas:${conversationId}`)).catch((err) => log.general.warn({ err }, 'socket.join canvas failed'));
    });

    socket.on('subscribe-agent', async (agentId: string) => {
      if (typeof agentId !== 'string' || agentId.length === 0 || agentId.length > 256) return;
      if (!userId) return;
      // A user may observe an agent's activity room only if they authored it or
      // currently have a session with it. Agent-activity events carry tool calls,
      // file changes, and screenshots from a running (owned) session.
      // The 24-hex shape check that used to gate this is gone with the ObjectIds
      // it described — see `ownsAgentSession`.
      const authored = await agentIsOwnedBy(getDb(), agentId, userId);
      const hasSession = authored || (await accountHasSessionWithAgent(getDb(), agentId, userId));
      if (!authored && !hasSession) return;
      Promise.resolve(socket.join(`agent:${agentId}`)).catch((err) => log.general.warn({ err }, 'socket.join agent failed'));
    });

    socket.on('subscribe-agent-session', async (sessionId: string) => {
      if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 256) return;
      if (!userId || !(await ownsAgentSession(userId, sessionId))) return;
      Promise.resolve(socket.join(`agent-session:${sessionId}`)).catch((err) => log.general.warn({ err }, 'socket.join agent-session failed'));
    });

    /**
     * A device OFFERING its own inference runtime — a browser tab with Ollama on
     * the same machine, and later a local bridge or the native app.
     *
     * The catalogue of models travels with the offer and is kept on the socket
     * rather than in a table, because a runtime's lifetime IS its socket's
     * lifetime: anything persisted would keep advertising a model after the tab
     * that could serve it was closed. It is also what lets the person's OTHER
     * devices see the list — a phone cannot reach the laptop's `localhost`, so
     * without this announcement a local model would be unusable anywhere but
     * the machine running it.
     *
     * The endpoint URL is deliberately NOT part of the offer. It never leaves
     * the browser that talks to it.
     */
    socket.on('subscribe-user-runtime', (offer: unknown) => {
      if (!userId) return;
      const presence = runtimeOffer(offer);
      if (!presence) return;
      socket.data.localRuntime = presence;
      Promise.resolve(socket.join(userRuntimeRoom(userId))).catch((err) => log.general.warn({ err }, 'socket.join user-runtime failed'));
    });

    /**
     * Withdraw the offer without dropping the connection — what the settings
     * toggle does. Leaving the room is not enough on its own: `socket.data`
     * still holds the catalogue, and a later re-join would re-advertise a stale
     * model list.
     */
    socket.on('unsubscribe-user-runtime', () => {
      if (!userId) return;
      delete socket.data.localRuntime;
      Promise.resolve(socket.leave(userRuntimeRoom(userId))).catch((err) => log.general.warn({ err }, 'socket.leave user-runtime failed'));
    });

    /**
     * Reply frames from a runtime, on their way back to whichever task is
     * serving the chat request that asked for them.
     *
     * The authenticated `userId` is passed through and re-checked against the
     * run's owner in the bridge. The run id alone is not an authorisation.
     */
    socket.on('user-runtime:head', (frame: { runId?: unknown; status?: unknown }) => {
      if (!userId || typeof frame?.runId !== 'string') return;
      const status = typeof frame.status === 'number' ? frame.status : 200;
      deliverUserRuntimeMessage(userId, { runId: frame.runId, kind: 'head', status });
    });

    socket.on('user-runtime:chunk', (frame: { runId?: unknown; data?: unknown }) => {
      if (!userId || typeof frame?.runId !== 'string') return;
      const { data } = frame;
      const bytes =
        typeof data === 'string' ? data
          : data instanceof Uint8Array ? data
            : Buffer.isBuffer(data) ? new Uint8Array(data)
              : null;
      if (bytes === null) return;
      deliverUserRuntimeMessage(userId, { runId: frame.runId, kind: 'chunk', data: bytes });
    });

    socket.on('user-runtime:end', (frame: { runId?: unknown }) => {
      if (!userId || typeof frame?.runId !== 'string') return;
      deliverUserRuntimeMessage(userId, { runId: frame.runId, kind: 'end' });
    });

    socket.on('user-runtime:error', (frame: { runId?: unknown; message?: unknown }) => {
      if (!userId || typeof frame?.runId !== 'string') return;
      /**
       * The runtime's own failure text is the CALLER'S OWN environment talking
       * back, so it is capped rather than sanitised — but never trusted for
       * length, because a client controls it.
       */
      const message = typeof frame.message === 'string' ? frame.message.slice(0, 500) : 'The local runtime failed.';
      deliverUserRuntimeMessage(userId, { runId: frame.runId, kind: 'error', message });
    });

    socket.on('subscribe-notifications', () => {
      // Room is always derived from the authenticated user — any client-supplied
      // userId is ignored to prevent subscribing to another user's notifications.
      if (!userId) return;
      Promise.resolve(socket.join(`user:${userId}`)).catch((err) => log.general.warn({ err }, 'socket.join notifications failed'));
    });

    // Agent action approval response from user
    socket.on('agent-approval-response', async (data: { requestId: string; sessionId: string; approved: boolean; alwaysAllow?: boolean }) => {
      if (!data?.requestId || typeof data.requestId !== 'string' || typeof data.sessionId !== 'string') return;
      if (!userId) return;

      const { getPendingApprovalSession, resolveApprovalDecision } = await import('./lib/agent/action-approval.js');

      // The pending approval is bound to a sessionId at creation time. Reject if
      // the claimed session does not match the request, or the user does not own it.
      const boundSessionId = getPendingApprovalSession(data.requestId);
      if (!boundSessionId || boundSessionId !== data.sessionId) return;
      if (!(await ownsAgentSession(userId, data.sessionId))) return;

      // Resolve pending approval in-memory and broadcast the decision.
      resolveApprovalDecision({
        requestId: data.requestId,
        approved: !!data.approved,
        alwaysAllow: data.alwaysAllow || false,
      });

      // Also mirror to the session room for real-time client updates.
      io!.to(`agent-session:${data.sessionId}`).emit('agent-approval-decision', {
        requestId: data.requestId,
        approved: data.approved,
        alwaysAllow: data.alwaysAllow || false,
      });
    });
  });
  return io;
}

export function getIO(): Server | null {
  return io;
}

export function emitTelegramLinked(token: string, data: any) {
  if (io) {
    io.to(`telegram-token:${token}`).emit('telegram-linked', data);
  }
}

export function emitCanvasUpdate(conversationId: string, component: any) {
  if (io) {
    io.to(`canvas:${conversationId}`).emit('canvas-update', { conversationId, component });
  }
}

export function emitWorkflowProgress(executionId: string, data: any) {
  if (io) {
    io.to(`workflow:${executionId}`).emit('workflow-progress', { executionId, ...data });
  }
}

export interface AgentActivityEvent {
  type: 'system' | 'thinking' | 'response' | 'tool_call' | 'tool_result' | 'error' | 'complete' | 'screenshot' | 'plan_progress' | 'file_change' | 'source_found' | 'threat' | 'approval_request';
  content: string;
  timestamp: number;
  sessionId: string;
  metadata?: { toolName?: string; args?: any; duration?: number; url?: string; title?: string; domain?: string; threatSeverity?: string; threatCategory?: string };
  data?: {
    base64?: string;
    url?: string;
    plan?: { items: Array<{ id: number; text: string; status: string }>; completed: number; total: number };
    files?: string[];
    currentStep?: number;
    maxSteps?: number;
    approval?: { requestId: string; toolName: string; args: any; description: string; severity: string; timeout: number };
    taskProgress?: {
      stepIndex: number;
      maxSteps: number;
      totalTokens: number;
      state: string;
      planCompleted: number;
      planTotal: number;
      elapsedMs: number;
      lastAction: string | null;
    };
  };
}

export function emitApprovalRequest(sessionId: string, data: {
  eventVersion?: number;
  requestId: string;
  agentId: string;
  toolName: string;
  args: any;
  description: string;
  severity: string;
  timeout: number;
}) {
  if (io) {
    const payload = {
      eventVersion: data.eventVersion ?? 1,
      ...data,
    };
    io.to(`agent-session:${sessionId}`).emit('agent-approval-request', payload);
    io.to(`agent-session:${sessionId}`).emit('alia.approval_request', payload);
  }
}

export function emitApprovalResult(sessionId: string, data: {
  eventVersion?: number;
  requestId: string;
  decision: 'approved' | 'denied' | 'timeout';
}) {
  if (io) {
    const payload = {
      eventVersion: data.eventVersion ?? 1,
      ...data,
    };
    io.to(`agent-session:${sessionId}`).emit('agent-approval-result', payload);
    io.to(`agent-session:${sessionId}`).emit('alia.approval_result', payload);
  }
}

export interface AudioJobUpdate {
  jobId: string;
  status: 'completed' | 'failed';
  audioUrl?: string;
  error?: string;
}

export function emitAudioJobUpdate(userId: string, data: AudioJobUpdate) {
  if (io) {
    io.to(`user:${userId}`).emit('audio:job-update', data);
  }
}

export function emitAgentActivity(agentId: string, data: AgentActivityEvent) {
  if (io) {
    io.to(`agent:${agentId}`).emit('agent-activity', { agentId, ...data });
    // Also emit to session-specific room for task card subscribers
    if (data.sessionId) {
      io.to(`agent-session:${data.sessionId}`).emit('agent-activity', { agentId, ...data });
    }
  }
}
