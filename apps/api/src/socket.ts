import { Server } from 'socket.io';
import http from 'http';
import { log } from './lib/logger.js';

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
  type: 'system' | 'thinking' | 'response' | 'tool_call' | 'tool_result' | 'error' | 'complete' | 'screenshot' | 'plan_progress' | 'file_change' | 'source_found';
  content: string;
  timestamp: number;
  sessionId: string;
  metadata?: { toolName?: string; args?: any; duration?: number; url?: string; title?: string; domain?: string };
  data?: {
    base64?: string;
    url?: string;
    plan?: { items: Array<{ id: number; text: string; status: string }>; completed: number; total: number };
    files?: string[];
    currentStep?: number;
    maxSteps?: number;
  };
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
