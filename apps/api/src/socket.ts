import { Server } from 'socket.io';
import http from 'http';

const ALLOWED_ORIGINS = [
  process.env.WEB_URL || 'http://localhost:3000',
  'https://alia.onl',
  'https://console.alia.onl',
  'https://providers.alia.onl',
];

let io: Server | null = null;

export function initSocket(server: http.Server) {
  io = new Server(server, {
    cors: {
      origin: ALLOWED_ORIGINS,
      methods: ['GET', 'POST'],
      credentials: true,
    }
  });
  io.on('connection', (socket) => {
    socket.on('subscribe-telegram-token', (token: string) => {
      if (typeof token !== 'string' || token.length > 256) return;
      socket.join(`telegram-token:${token}`);
    });

    socket.on('subscribe-workflow', (executionId: string) => {
      if (typeof executionId !== 'string' || executionId.length > 256) return;
      socket.join(`workflow:${executionId}`);
    });

    socket.on('subscribe-canvas', (conversationId: string) => {
      if (typeof conversationId !== 'string' || conversationId.length > 256) return;
      socket.join(`canvas:${conversationId}`);
    });

    socket.on('subscribe-agent', (agentId: string) => {
      if (typeof agentId !== 'string' || agentId.length > 256) return;
      socket.join(`agent:${agentId}`);
    });

    socket.on('subscribe-agent-session', (sessionId: string) => {
      if (typeof sessionId !== 'string' || sessionId.length > 256) return;
      socket.join(`agent-session:${sessionId}`);
    });

    socket.on('subscribe-notifications', (userId: string) => {
      if (typeof userId !== 'string' || userId.length > 256) return;
      socket.join(`user:${userId}`);
    });

    // Agent action approval response from user
    socket.on('agent-approval-response', async (data: { requestId: string; sessionId: string; approved: boolean; alwaysAllow?: boolean }) => {
      if (!data?.requestId || typeof data.sessionId !== 'string') return;
      // Resolve pending approval in-memory and broadcast the decision.
      const { resolveApprovalDecision } = await import('./lib/agent/action-approval.js');
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

export function emitAgentActivity(agentId: string, data: AgentActivityEvent) {
  if (io) {
    io.to(`agent:${agentId}`).emit('agent-activity', { agentId, ...data });
    // Also emit to session-specific room for task card subscribers
    if (data.sessionId) {
      io.to(`agent-session:${data.sessionId}`).emit('agent-activity', { agentId, ...data });
    }
  }
}
