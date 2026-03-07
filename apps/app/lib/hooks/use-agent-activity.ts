/**
 * useAgentActivity — Real-time agent activity subscription via Socket.IO.
 *
 * Subscribes to an agent's activity events and accumulates them into
 * structured state for rendering in AgentTaskCard.
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { io as socketIO, type Socket } from 'socket.io-client';
import config from '@/lib/config';

export interface PlanItem {
  id: number;
  text: string;
  status: string;
}

export interface PlanProgress {
  items: PlanItem[];
  completed: number;
  total: number;
}

export interface AgentScreenshot {
  base64: string;
  url: string;
  timestamp: number;
}

export interface AgentActivityEvent {
  type: 'system' | 'thinking' | 'response' | 'tool_call' | 'tool_result' | 'error' | 'complete' | 'screenshot' | 'plan_progress' | 'file_change' | 'source_found' | 'approval_request' | 'approval_result';
  content: string;
  timestamp: number;
  sessionId: string;
  agentId?: string;
  metadata?: {
    toolName?: string;
    args?: any;
    duration?: number;
    url?: string;
    title?: string;
    domain?: string;
    requestId?: string;
    decision?: 'approved' | 'denied' | 'timeout';
  };
  data?: {
    base64?: string;
    url?: string;
    plan?: PlanProgress;
    files?: string[];
    currentStep?: number;
    maxSteps?: number;
    approval?: {
      requestId: string;
      toolName: string;
      args: Record<string, unknown>;
      description: string;
      severity: string;
      timeout: number;
    };
  };
}

export interface AgentSource {
  url: string;
  title: string;
  domain: string;
  snippet: string;
  timestamp: number;
}

export interface AgentActivityState {
  /** Current plan with checklist items */
  plan: PlanProgress | null;
  /** Most recent screenshots (last 5) */
  screenshots: AgentScreenshot[];
  /** Current action being executed */
  currentAction: { toolName: string; content: string } | null;
  /** Whether the agent has completed */
  isComplete: boolean;
  /** Whether there's an error */
  hasError: boolean;
  /** Last error message */
  lastError: string | null;
  /** Total events received */
  eventCount: number;
  /** All activity events (last 50) */
  events: AgentActivityEvent[];
  /** Start time of first event */
  startedAt: number | null;
  /** Sources found during browsing */
  sources: AgentSource[];
  /** Files created/modified in workspace */
  files: string[];
  /** Latest text response from agent */
  latestResponse: string | null;
  /** Pending approval request for this session */
  approvalRequest: {
    requestId: string;
    toolName: string;
    description: string;
    severity: string;
    timeout: number;
    args?: Record<string, unknown>;
  } | null;
  /** Last approval decision */
  approvalResult: {
    requestId: string;
    decision: 'approved' | 'denied' | 'timeout';
  } | null;
}

export interface UseAgentActivityResult extends AgentActivityState {
  respondApproval: (requestId: string, approved: boolean, alwaysAllow?: boolean) => void;
}

const INITIAL_STATE: AgentActivityState = {
  plan: null,
  screenshots: [],
  currentAction: null,
  isComplete: false,
  hasError: false,
  lastError: null,
  eventCount: 0,
  events: [],
  startedAt: null,
  sources: [],
  files: [],
  latestResponse: null,
  approvalRequest: null,
  approvalResult: null,
};

const MAX_SCREENSHOTS = 5;
const MAX_EVENTS = 50;

/**
 * Hook to subscribe to real-time agent activity via Socket.IO.
 *
 * @param sessionId - The agent session ID to subscribe to (null to disable)
 * @param agentId - Optional agent ID for backward-compat subscription
 */
export function useAgentActivity(sessionId: string | null, agentId?: string | null): UseAgentActivityResult {
  const [state, setState] = useState<AgentActivityState>(INITIAL_STATE);
  const socketRef = useRef<Socket | null>(null);

  const handleEvent = useCallback((event: AgentActivityEvent) => {
    setState(prev => {
      const updated = { ...prev };
      updated.eventCount = prev.eventCount + 1;
      updated.events = [...prev.events.slice(-(MAX_EVENTS - 1)), event];

      if (!prev.startedAt) {
        updated.startedAt = event.timestamp;
      }

      switch (event.type) {
        case 'plan_progress':
          if (event.data?.plan) {
            updated.plan = event.data.plan;
          }
          break;

        case 'screenshot':
          if (event.data?.base64) {
            updated.screenshots = [
              ...prev.screenshots.slice(-(MAX_SCREENSHOTS - 1)),
              { base64: event.data.base64, url: event.data.url || '', timestamp: event.timestamp },
            ];
          }
          break;

        case 'tool_call':
          updated.currentAction = {
            toolName: event.metadata?.toolName || 'action',
            content: event.content,
          };
          break;

        case 'tool_result':
          updated.currentAction = null;
          break;

        case 'error':
          updated.hasError = true;
          updated.lastError = event.content;
          updated.currentAction = null;
          break;

        case 'complete':
          updated.isComplete = true;
          updated.currentAction = null;
          updated.latestResponse = null;
          break;

        case 'source_found':
          if (event.metadata?.url) {
            const newSource: AgentSource = {
              url: event.metadata.url,
              title: event.metadata.title || '',
              domain: event.metadata.domain || new URL(event.metadata.url).hostname,
              snippet: event.content?.slice(0, 200) || '',
              timestamp: event.timestamp,
            };
            // Deduplicate by URL
            if (!prev.sources.some(s => s.url === newSource.url)) {
              updated.sources = [...prev.sources, newSource];
            }
          }
          break;

        case 'file_change':
          if (event.data?.files) {
            const newFiles = event.data.files.filter(f => !prev.files.includes(f));
            if (newFiles.length > 0) {
              updated.files = [...prev.files, ...newFiles];
            }
          }
          break;

        case 'response':
          updated.latestResponse = event.content;
          break;

        case 'approval_request':
          if (event.data?.approval) {
            updated.approvalRequest = {
              requestId: event.data.approval.requestId,
              toolName: event.data.approval.toolName,
              description: event.data.approval.description,
              severity: event.data.approval.severity,
              timeout: event.data.approval.timeout,
              args: event.data.approval.args,
            };
          }
          break;

        case 'approval_result':
          if (event.metadata?.requestId && event.metadata?.decision) {
            updated.approvalResult = {
              requestId: event.metadata.requestId as string,
              decision: event.metadata.decision as 'approved' | 'denied' | 'timeout',
            };
          }
          updated.approvalRequest = null;
          break;
      }

      return updated;
    });
  }, []);

  useEffect(() => {
    if (!sessionId) return;

    // Reset state for new session
    setState(INITIAL_STATE);

    const socket = socketIO(config.apiUrl, {
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      // Subscribe to session-specific room
      socket.emit('subscribe-agent-session', sessionId);
      // Also subscribe to agent room for backward compat
      if (agentId) {
        socket.emit('subscribe-agent', agentId);
      }
    });

    socket.on('agent-activity', (data: AgentActivityEvent & { agentId?: string }) => {
      // Only process events for our session
      if (data.sessionId === sessionId) {
        handleEvent(data);
      }
    });

    socket.on('alia.approval_request', (payload: any) => {
      handleEvent({
        type: 'approval_request',
        content: payload.description || 'Approval required',
        timestamp: Date.now(),
        sessionId,
        data: {
          approval: {
            requestId: payload.requestId,
            toolName: payload.toolName,
            args: payload.args,
            description: payload.description,
            severity: payload.severity,
            timeout: payload.timeout,
          },
        },
      } as AgentActivityEvent);
    });

    socket.on('alia.approval_result', (payload: any) => {
      handleEvent({
        type: 'approval_result',
        content: payload.decision || 'unknown',
        timestamp: Date.now(),
        sessionId,
        metadata: {
          requestId: payload.requestId,
          decision: payload.decision,
        } as any,
      } as AgentActivityEvent);
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [sessionId, agentId, handleEvent]);

  const respondApproval = useCallback((requestId: string, approved: boolean, alwaysAllow = false) => {
    if (!sessionId || !socketRef.current) return;
    socketRef.current.emit('agent-approval-response', {
      requestId,
      sessionId,
      approved,
      alwaysAllow,
    });

    // Optimistic local update while server confirms.
    setState(prev => ({
      ...prev,
      approvalRequest: null,
      approvalResult: { requestId, decision: approved ? 'approved' : 'denied' },
    }));
  }, [sessionId]);

  return {
    ...state,
    respondApproval,
  };
}
