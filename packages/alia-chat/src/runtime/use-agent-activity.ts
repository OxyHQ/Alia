import { useOxy } from '@oxy.so/services/ui/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useAliaApi } from './api';
import { useAliaRuntime } from './config';
import { AGENT_ROUTES } from './routes';
import {
  type AgentActivityEvent,
  type AgentActivityState,
  type AgentSessionStatus,
  applyActivityEvent,
  hydrateActivity,
  INITIAL_ACTIVITY,
} from './thread/agent-activity';

export interface UseAgentActivityResult extends AgentActivityState {
  respondApproval: (requestId: string, approved: boolean, alwaysAllow?: boolean) => void;
}

interface ApprovalRequestFrame {
  requestId: string;
  toolName: string;
  args: Record<string, unknown>;
  description: string;
  severity: string;
  timeout: number;
}

interface ApprovalResultFrame {
  requestId: string;
  decision: 'approved' | 'denied' | 'timeout';
}

/**
 * Follow one agent run live: the session's room over Socket.IO, seeded with what the run had
 * already done (`GET` on its status, best-effort — the socket still carries live progress).
 *
 * @param sessionId - The agent session to follow; `null` follows nothing.
 * @param agentId - The agent's own room too, for the runs that announce themselves there.
 */
export function useAgentActivity(
  sessionId: string | null,
  agentId?: string | null,
): UseAgentActivityResult {
  const [state, setState] = useState<AgentActivityState>(INITIAL_ACTIVITY);
  const socketRef = useRef<Socket | null>(null);
  const api = useAliaApi();
  const { apiUrl } = useAliaRuntime();
  const { oxyServices } = useOxy();

  const handleEvent = useCallback((event: AgentActivityEvent) => {
    setState((prev) => applyActivityEvent(prev, event));
  }, []);

  useEffect(() => {
    if (!sessionId) return;

    setState(INITIAL_ACTIVITY);
    let cancelled = false;

    api
      .get<AgentSessionStatus>(AGENT_ROUTES.sessionStatus(sessionId))
      .then(({ data }) => {
        if (!cancelled) setState((prev) => hydrateActivity(prev, data, sessionId));
      })
      .catch(() => {
        // Socket updates still provide live progress; hydration is best-effort.
      });

    const socket = io(apiUrl, {
      transports: ['websocket'],
      // The function form reads a fresh token on every (re)connect, so it survives rotation.
      auth: (cb) => cb({ token: oxyServices.session.accessToken }),
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      socket.emit('subscribe-agent-session', sessionId);
      if (agentId) socket.emit('subscribe-agent', agentId);
    });

    socket.on('agent-activity', (event: AgentActivityEvent) => {
      if (event.sessionId === sessionId) handleEvent(event);
    });

    socket.on('alia.approval_request', (payload: ApprovalRequestFrame) => {
      handleEvent({
        type: 'approval_request',
        content: payload.description || 'Approval required',
        timestamp: Date.now(),
        sessionId,
        data: { approval: payload },
      });
    });

    socket.on('alia.approval_result', (payload: ApprovalResultFrame) => {
      handleEvent({
        type: 'approval_result',
        content: payload.decision || 'unknown',
        timestamp: Date.now(),
        sessionId,
        metadata: { requestId: payload.requestId, decision: payload.decision },
      });
    });

    return () => {
      cancelled = true;
      socket.disconnect();
      socketRef.current = null;
    };
  }, [sessionId, agentId, handleEvent, api, apiUrl, oxyServices]);

  const respondApproval = useCallback(
    (requestId: string, approved: boolean, alwaysAllow = false) => {
      if (!sessionId || !socketRef.current) return;
      socketRef.current.emit('agent-approval-response', {
        requestId,
        sessionId,
        approved,
        alwaysAllow,
      });
      // Optimistic local update while the server confirms.
      setState((prev) => ({
        ...prev,
        approvalRequest: null,
        approvalResult: { requestId, decision: approved ? 'approved' : 'denied' },
      }));
    },
    [sessionId],
  );

  return { ...state, respondApproval };
}
