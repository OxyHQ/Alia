import { Server, type Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import http from 'http';
import { getRedisClient, getRedisSubClient } from './lib/redis.js';
import { log } from './lib/logger.js';
import { oxyClient } from './middleware/auth.js';
import { AgentSession } from './models/agent-session.js';
import { Agent } from './models/agent.js';
import { CanvasSession } from './models/canvas-session.js';
import { WorkflowExecution } from './models/workflow-execution.js';

/** Read the authenticated user id planted on the socket by `oxy.authSocket()`. */
function socketUserId(socket: Socket): string | null {
  const fromData = socket.data?.userId;
  if (typeof fromData === 'string' && fromData.length > 0) return fromData;
  return null;
}

/** True if the authenticated user owns the given agent session. */
async function ownsAgentSession(userId: string, sessionId: string): Promise<boolean> {
  if (!/^[a-f0-9]{24}$/i.test(sessionId)) return false;
  const session = await AgentSession.findById(sessionId).select('userId').lean();
  return !!session && session.userId?.toString() === userId;
}

const ALLOWED_ORIGINS = [
  process.env.WEB_URL || 'http://localhost:3000',
  'https://alia.onl',
  'https://console.alia.onl',
  'https://gateway.alia.onl',
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
      socket.join(`telegram-token:${token}`);
    });

    socket.on('subscribe-workflow', async (executionId: string) => {
      if (typeof executionId !== 'string' || executionId.length === 0 || executionId.length > 256) return;
      if (!userId) return;
      const execution = await WorkflowExecution.findOne({ executionId }).select('oxyUserId').lean();
      if (!execution || execution.oxyUserId?.toString() !== userId) return;
      socket.join(`workflow:${executionId}`);
    });

    socket.on('subscribe-canvas', async (conversationId: string) => {
      if (typeof conversationId !== 'string' || conversationId.length === 0 || conversationId.length > 256) return;
      if (!userId) return;
      const canvas = await CanvasSession.findOne({ oxyUserId: userId, conversationId }).select('_id').lean();
      if (!canvas) return;
      socket.join(`canvas:${conversationId}`);
    });

    socket.on('subscribe-agent', async (agentId: string) => {
      if (typeof agentId !== 'string' || agentId.length === 0 || agentId.length > 256) return;
      if (!userId || !/^[a-f0-9]{24}$/i.test(agentId)) return;
      // A user may observe an agent's activity room only if they authored it or
      // currently have a session with it. Agent-activity events carry tool calls,
      // file changes, and screenshots from a running (owned) session.
      const authored = await Agent.exists({ _id: agentId, author: userId });
      const hasSession = authored
        ? true
        : !!(await AgentSession.exists({ agentId, userId }));
      if (!authored && !hasSession) return;
      socket.join(`agent:${agentId}`);
    });

    socket.on('subscribe-agent-session', async (sessionId: string) => {
      if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 256) return;
      if (!userId || !(await ownsAgentSession(userId, sessionId))) return;
      socket.join(`agent-session:${sessionId}`);
    });

    socket.on('subscribe-notifications', () => {
      // Room is always derived from the authenticated user — any client-supplied
      // userId is ignored to prevent subscribing to another user's notifications.
      if (!userId) return;
      socket.join(`user:${userId}`);
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
