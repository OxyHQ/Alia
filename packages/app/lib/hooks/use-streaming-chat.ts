import { useState, useCallback, useRef, useEffect } from 'react';
import { fetch as expoFetch } from 'expo/fetch';
import * as Haptics from 'expo-haptics';
import { useOxy } from '@oxyhq/services';
import { useQueryClient } from '@tanstack/react-query';
import type { Message } from '@/lib/hooks/use-conversations';
import type { CreditsInfo } from '@/lib/hooks/use-credits';
import { collectDeviceInfo } from '@/lib/device-info';
import { UsageLimitError } from '@/lib/errors/usage-limit-error';
import { queryKeys } from '@/lib/hooks/query-keys';
import { USER_MEMORY_QUERY_KEY } from '@/lib/hooks/use-user-data';
import { useStore } from '@/lib/stores/global-store';
import { useModelStore } from '@/lib/stores/model-store';
import type { EffortLevel } from '@/lib/hooks/use-catalogue';
import { useUIStore } from '@/lib/stores/ui-store';
import { toast } from '@oxyhq/bloom/toast';
import i18n from '@/lib/i18n';
import type { Conversation } from '@/lib/hooks/use-conversations';
import { buildOutboundMessages } from '@/lib/chat-message-history';

import type { ToolInvocation } from '@/lib/types/messages';
import { errorMessage as getErrorMessage, errorStatus, errorCode, errorName } from '../errors/error-utils';
export type { ToolInvocation };

/**
 * How a send ended. `failed` means the turn produced no real output — the
 * message list has been rolled back to what it was before the send, so the
 * caller can hand the text back to the composer.
 */
export type SendOutcome = 'sent' | 'failed' | 'aborted';

export interface SendOptions {
  /** `null` explicitly withholds MCP tools; omission preserves legacy callers. */
  mcpServerId?: string | null;
}

/** Server tools that mutate the user's memory document (see packages/api `lib/tools/user-memory.ts`). */
const MEMORY_WRITING_TOOLS = new Set([
  'saveUserMemory',
  'updateUserMemory',
  'updateUserPreferences',
  'updateUserContext',
]);

/** Shape of an error body thrown by the streaming fetch (rate-limit / credit info). */
interface ThrownErrorBody {
  code?: string;
  message?: string;
  retryable?: boolean;
  retryAfter?: number;
  suggestedAction?: 'wait' | 'upgrade';
}

/** Structured `error` object the server may embed in a non-OK response / SSE error event. */
interface StreamErrorObject {
  code?: string;
  message?: string;
  retryable?: boolean;
  retryAfter?: number;
  suggestedAction?: 'wait' | 'upgrade';
  type?: string;
  details?: {
    limitType?: string;
    current?: number;
    limit?: number;
    tier?: string;
  };
}

/** Non-OK response body read from the stream before the SSE loop starts. */
interface StreamErrorResponse {
  error?: StreamErrorObject | string;
  details?: unknown;
}

/** Infinite-query cache shape for the conversation list. */
interface ConversationsInfinite {
  pages: Array<{ conversations: Conversation[] }>;
  pageParams: unknown[];
}


export function useStreamingChat(apiUrl: string, conversationId?: string, reasoningEffort?: EffortLevel | null, selectedModel?: string, skillId?: string | null, agentId?: string | null) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [conversationTitle, setConversationTitle] = useState<string | null>(null);
  /**
   * The agent proposing that the next stretch of the thread start fresh, or
   * `null` for none.
   *
   * The `reason` is the model's own sentence, in the model's own words. It is
   * carried through untouched so the offer can say WHY instead of appearing as
   * a button with no context.
   *
   * At most one is ever in flight: the server bounds it to one per turn and a
   * later one replaces an unanswered earlier one, so there is nothing to
   * collapse here. And nothing has been written when it arrives — the tool that
   * emits it creates nothing — so ignoring it leaves the thread exactly as it
   * was.
   */
  const [suggestedNewConversation, setSuggestedNewConversation] = useState<string | null>(null);
  const { oxyServices } = useOxy();
  const queryClient = useQueryClient();
  const abortControllerRef = useRef<AbortController | null>(null);

  // Batching refs: accumulate streaming text and flush at ~20fps instead of per-chunk
  const pendingContentRef = useRef('');
  const pendingReasoningRef = useRef('');
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushPendingUpdates = useCallback(() => {
    const content = pendingContentRef.current;
    const reasoning = pendingReasoningRef.current;
    if (!content && !reasoning) return;

    pendingContentRef.current = '';
    pendingReasoningRef.current = '';

    setMessages((prev) => {
      const updated = [...prev];
      const lastMessage = updated[updated.length - 1];
      if (lastMessage?.role === 'assistant') {
        const changes: Partial<Message> = {};
        if (content) changes.content = lastMessage.content + content;
        if (reasoning) changes.thinking = (lastMessage.thinking || '') + reasoning;
        updated[updated.length - 1] = { ...lastMessage, ...changes };
      }
      return updated;
    });
  }, []);

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current) return;
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null;
      flushPendingUpdates();
    }, 50);
  }, [flushPendingUpdates]);

  // Cleanup: flush remaining content and clear timer on unmount
  useEffect(() => {
    return () => {
      flushPendingUpdates();
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
    };
  }, [flushPendingUpdates]);

  // Ref to avoid messages in append's dep array (avoids recreation every 50ms during streaming)
  // Synced both via useEffect (for streaming updates) and eagerly in setMessagesAndRef
  // so that setMessages + append in the same tick see the correct history.
  const messagesRef = useRef<Message[]>([]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // Wrapper that eagerly syncs messagesRef before React re-renders,
  // so append() called in the same tick reads truncated history (e.g. editMessage).
  const setMessagesAndRef = useCallback((update: Message[] | ((prev: Message[]) => Message[])) => {
    if (typeof update === 'function') {
      setMessages(prev => {
        const next = update(prev);
        messagesRef.current = next;
        return next;
      });
    } else {
      messagesRef.current = update;
      setMessages(update);
    }
  }, []);

  const append = useCallback(async (
    message: Omit<Message, 'id'>,
    options?: SendOptions,
  ): Promise<SendOutcome> => {
    setIsLoading(true);
    setError(null);

    // Everything the send is about to change, so a turn that produces no real
    // output can be undone in one step: the user message, the assistant
    // placeholder, and any history editMessage truncated just before this call.
    const snapshot = messagesRef.current;

    // Only content the model actually produced counts. The server answers a
    // dead provider, a mid-stream break or a global timeout with HTTP 200 and a
    // stand-in message flagged `alia_meta.synthetic` — that is a failed send
    // wearing a reply's clothes.
    let realOutputChars = 0;
    let hasToolInvocations = false;

    const rollback = (): SendOutcome => {
      // Drop anything still batched first: flushPendingUpdates appends to
      // whichever message is last, so a buffered fragment surviving the restore
      // would land on the previous turn's reply.
      pendingContentRef.current = '';
      pendingReasoningRef.current = '';
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      setMessagesAndRef(snapshot);
      return 'failed';
    };

    /** Keep a half-streamed turn — destroying real output is worse than showing the error. */
    const settleError = (): SendOutcome => (realOutputChars || hasToolInvocations ? 'sent' : rollback());

    /**
     * Stamped here, not on the way back: a thread left open across midnight has
     * to draw its date line as the turn happens, and the server's own stamp only
     * arrives with the next full load. `POST /conversations` already accepts a
     * client `createdAt`, so this is the value that persists too.
     */
    const userMessage: Message = { ...message, id: Date.now().toString(), createdAt: new Date().toISOString() };
    // Build from the pre-send snapshot before any await. The optimistic user
    // row and assistant placeholder may reach messagesRef while device info is
    // collected; reading the ref afterwards used to send both plus userMessage
    // again, persisting user -> empty assistant -> duplicate user.
    const messagesToSend = buildOutboundMessages(snapshot, userMessage);
    setMessages((prev) => [...prev, userMessage]);

    // Create assistant message placeholder
    const assistantMessage: Message = {
      id: (Date.now() + 1).toString(),
      role: 'assistant',
      content: '',
      toolInvocations: [],
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, assistantMessage]);

    try {
      // Collect device info (will be available to AI via tool if needed)
      const deviceInfo = await collectDeviceInfo();

      // Build headers with optional session ID
      const headers: HeadersInit = {
        'Content-Type': 'application/json',
        'X-Device-Info': JSON.stringify(deviceInfo),
      };

      const token = oxyServices.getAccessToken();
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      // Create abort controller for this request
      abortControllerRef.current = new AbortController();

      const agentMode = useStore.getState().agentMode;
      const deepResearchMode = useStore.getState().deepResearchMode;
      /**
       * Read at send time rather than closed over, like the two above it: the
       * capability switches live in a menu that stays open across a send, and a
       * value captured when the callback was built would send the state the
       * composer had before the person touched it.
       */
      const webSearch = useModelStore.getState().webSearch;

      const response = await expoFetch(apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          messages: messagesToSend,
          stream: true,
          ...(conversationId && { conversationId }),
          // Omitted entirely when nothing was chosen, so the request means "the
          // model's own default" rather than "the cheapest level".
          ...(reasoningEffort && { reasoningEffort }),
          // Only sent when OFF. `true` is the server's default and every
          // request has behaved that way, so sending it would be noise.
          ...(webSearch === false && { webSearch: false }),
          ...(selectedModel && { model: selectedModel }),
          ...(skillId && { skillId }),
          ...(agentId && { agentId }),
          ...(agentMode && { agentMode: true }),
          ...(deepResearchMode && { deepResearch: true }),
          ...(options?.mcpServerId === undefined
            ? {}
            : { mcpServerId: options.mcpServerId }),
        }),
        signal: abortControllerRef.current.signal,
      });

      if (!response.ok) {
        let errorData: StreamErrorResponse | null = null;
        try {
          // expoFetch is streaming-oriented; .json() may not work for error responses.
          // Read the body manually via the ReadableStream reader.
          if (response.body) {
            const errReader = response.body.getReader();
            const { value } = await errReader.read();
            if (value) {
              errorData = JSON.parse(new TextDecoder().decode(value));
            }
          }
        } catch {
          // Best-effort: if the error body isn't readable/JSON, fall through to
          // the generic status-based error message below.
        }

        // Detect usage limit errors (429 rate limit, 402 insufficient credits, 403 model access)
        if (response.status === 429 || response.status === 402 || response.status === 403) {
          const errObj = errorData?.error && typeof errorData.error === 'object' ? errorData.error : null;
          const isModelAccess = response.status === 403 && errObj?.code === 'MODEL_NOT_IN_PLAN';
          const isCredits = response.status === 402 || errObj?.code === 'INSUFFICIENT_CREDITS';

          if (isModelAccess || isCredits || response.status === 429) {
            throw new UsageLimitError({
              type: isModelAccess ? 'model_access' : isCredits ? 'credits' : 'rate_limit',
              code: errObj?.code || (isModelAccess ? 'MODEL_NOT_IN_PLAN' : isCredits ? 'INSUFFICIENT_CREDITS' : 'RATE_LIMIT_EXCEEDED'),
              message: errObj?.message || (isModelAccess
                ? 'Upgrade your plan to use this model.'
                : isCredits
                  ? "You've run out of credits."
                  : "You've sent too many messages."),
              retryable: errObj?.retryable ?? (!isCredits && !isModelAccess),
              retryAfterSeconds: errObj?.retryAfter,
              suggestedAction: errObj?.suggestedAction || (isCredits || isModelAccess ? 'upgrade' : 'wait'),
              limitType: errObj?.details?.limitType,
              current: errObj?.details?.current,
              limit: errObj?.details?.limit,
              tier: errObj?.details?.tier,
            });
          }
        }

        // Session expired or signed out mid-request: friendly sign-in prompt
        // instead of the raw server error string.
        if (response.status === 401) {
          throw new Error(i18n.t('subscribe.signInRequired'));
        }

        // Generic error fallback
        let errorMessage = `Server error (${response.status})`;
        if (errorData) {
          const err = errorData.error;
          if (typeof err === 'string') {
            errorMessage = err;
          } else if (getErrorMessage(err)) {
            errorMessage = getErrorMessage(err);
          } else if (typeof errorData.details === 'string') {
            errorMessage = errorData.details;
          }
        } else {
          errorMessage = response.statusText || errorMessage;
        }
        throw new Error(errorMessage);
      }

      if (!response.body) {
        throw new Error('No response received from server');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let lastHapticAt = 0;

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          // Flush any remaining batched content before checking
          flushPendingUpdates();

          // The stream closed without the model producing anything usable.
          if (!realOutputChars && !hasToolInvocations) {
            setError(new Error('No response received from AI'));
            return rollback();
          }
          break;
        }

        // Decode chunk and add to buffer
        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;

        // Process complete lines (supports named SSE events: event: X\ndata: Y)
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        let currentEventType = '';
        for (const line of lines) {
          // Track named SSE event type
          if (line.startsWith('event: ')) {
            currentEventType = line.slice(7).trim();
            continue;
          }

          // Reset event type on empty line (SSE event boundary)
          if (line === '') {
            currentEventType = '';
            continue;
          }

          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();

            // Skip [DONE] marker
            if (data === '[DONE]') { currentEventType = ''; continue; }

            try {
              const parsed = JSON.parse(data);

              // ── Named SSE events (Alia extensions) ──
              if (currentEventType) {
                switch (currentEventType) {
                  case 'alia.reasoning': {
                    const content = parsed.content;
                    if (content) {
                      pendingReasoningRef.current += content;
                      scheduleFlush();
                    }
                    currentEventType = '';
                    continue;
                  }
                  case 'alia.tool_result': {
                    const { tool_call_id, name, output } = parsed;
                    if (tool_call_id) {
                      setMessages((prev) => {
                        const updated = [...prev];
                        const lastMessage = updated[updated.length - 1];
                        if (lastMessage?.role === 'assistant') {
                          const invocations = [...(lastMessage.toolInvocations || [])];
                          const idx = invocations.findIndex((t) => t.toolCallId === tool_call_id);
                          if (idx >= 0) {
                            invocations[idx] = { ...invocations[idx], state: 'result', result: output };
                          } else {
                            invocations.push({ toolCallId: tool_call_id, toolName: name || 'unknown', state: 'result', result: output });
                          }
                          updated[updated.length - 1] = { ...lastMessage, toolInvocations: invocations };
                        }
                        return updated;
                      });
                      // The assistant just rewrote the memory document, so any
                      // screen showing it (settings/memory) is now out of date.
                      if (name && MEMORY_WRITING_TOOLS.has(name)) {
                        queryClient.invalidateQueries({ queryKey: USER_MEMORY_QUERY_KEY });
                      }
                      // Detect artifact-like results
                      if (name === 'generateFile' && output && typeof output === 'object') {
                        const artifactType = output.language ? 'code' : 'markdown';
                        useUIStore.getState().addCanvasArtifact({
                          id: tool_call_id,
                          type: artifactType,
                          content: artifactType === 'code'
                            ? { language: output.language, code: output.content }
                            : { content: output.content },
                          title: output.filename || output.title || 'Generated file',
                          timestamp: Date.now(),
                        });
                        useUIStore.getState().setRightPanel('canvas');
                      } else if (output?.artifact) {
                        const a = output.artifact;
                        useUIStore.getState().addCanvasArtifact({
                          id: tool_call_id,
                          type: a.type || 'markdown',
                          content: a.data || a.content || a,
                          title: a.title || name || 'Artifact',
                          timestamp: Date.now(),
                        });
                        useUIStore.getState().setRightPanel('canvas');
                      }
                    }
                    currentEventType = '';
                    continue;
                  }
                  case 'alia.agent': {
                    const am = parsed;
                    setMessages((prev) => {
                      const updated = [...prev];
                      const agentMsg: Message = {
                        id: `agent-${Date.now()}-${am.agentId}`,
                        role: 'assistant',
                        content: am.content,
                        agentInfo: {
                          id: am.agentId,
                          name: am.agentName,
                          color: am.agentColor ?? null,
                          handle: am.agentHandle,
                        },
                      };
                      const lastIdx = updated.length - 1;
                      updated.splice(lastIdx, 0, agentMsg);
                      return updated;
                    });
                    currentEventType = '';
                    continue;
                  }
                  case 'alia.title': {
                    if (parsed.title && parsed.conversationId) {
                      queryClient.setQueryData(
                        queryKeys.conversations.detail(parsed.conversationId),
                        (old: Conversation | undefined) => old ? { ...old, title: parsed.title } : old
                      );
                      queryClient.setQueriesData(
                        { queryKey: queryKeys.conversations.all },
                        (old: ConversationsInfinite | undefined) => {
                          if (!old?.pages) return old;
                          return {
                            ...old,
                            pages: old.pages.map((page) => ({
                              ...page,
                              conversations: page.conversations.map((c) =>
                                c.id === parsed.conversationId ? { ...c, title: parsed.title } : c
                              ),
                            })),
                          };
                        }
                      );
                      setConversationTitle(parsed.title);
                    }
                    currentEventType = '';
                    continue;
                  }
                  case 'alia.research_progress': {
                    setMessages((prev) => {
                      const updated = [...prev];
                      const lastMessage = updated[updated.length - 1];
                      if (lastMessage?.role === 'assistant') {
                        updated[updated.length - 1] = {
                          ...lastMessage,
                          researchProgress: {
                            phase: parsed.phase,
                            message: parsed.message,
                            subQuestions: parsed.subQuestions || lastMessage.researchProgress?.subQuestions,
                            sourcesFound: parsed.sourcesFound,
                            currentQuery: parsed.currentQuery,
                            iteration: parsed.iteration,
                          },
                        };
                      }
                      return updated;
                    });
                    currentEventType = '';
                    continue;
                  }
                  case 'alia.plan_preview': {
                    setMessages((prev) => {
                      const updated = [...prev];
                      const lastMessage = updated[updated.length - 1];
                      if (lastMessage?.role === 'assistant') {
                        updated[updated.length - 1] = {
                          ...lastMessage,
                          pendingPlan: {
                            planId: parsed.planId,
                            steps: parsed.steps || [],
                            approved: false,
                            rejected: false,
                          },
                        };
                      }
                      return updated;
                    });
                    currentEventType = '';
                    continue;
                  }
                  case 'alia.approval_request': {
                    setMessages((prev) => {
                      const updated = [...prev];
                      const lastMessage = updated[updated.length - 1];
                      if (lastMessage?.role === 'assistant') {
                        updated[updated.length - 1] = {
                          ...lastMessage,
                          pendingApproval: {
                            requestId: parsed.requestId,
                            toolName: parsed.toolName,
                            description: parsed.description,
                            severity: parsed.severity,
                            timeout: parsed.timeout,
                            args: parsed.args,
                          },
                        };
                      }
                      return updated;
                    });
                    currentEventType = '';
                    continue;
                  }
                  case 'alia.approval_result': {
                    setMessages((prev) => {
                      const updated = [...prev];
                      const lastMessage = updated[updated.length - 1];
                      if (lastMessage?.role === 'assistant') {
                        updated[updated.length - 1] = {
                          ...lastMessage,
                          pendingApprovalResult: {
                            requestId: parsed.requestId,
                            decision: parsed.decision,
                          },
                        };
                      }
                      return updated;
                    });
                    currentEventType = '';
                    continue;
                  }
                  case 'alia.model_switch': {
                    if (parsed.model) {
                      useModelStore.getState().setSelectedModel(parsed.model);
                    }
                    currentEventType = '';
                    continue;
                  }
                  case 'alia.suggest_new_conversation': {
                    // A missing or blank reason degrades to an offer without
                    // one rather than to an invented one: the sentence belongs
                    // to the model, and a plausible substitute would be worse
                    // than none.
                    setSuggestedNewConversation(
                      typeof parsed.reason === 'string' && parsed.reason.trim() !== ''
                        ? parsed.reason.trim()
                        : '',
                    );
                    currentEventType = '';
                    continue;
                  }
                  case 'alia.agent_session': {
                    if (parsed.sessionId) {
                      const { useUIStore } = await import('@/lib/stores/ui-store');
                      useUIStore.getState().openAgentPanel(parsed.sessionId, parsed.agentId || '');
                    }
                    currentEventType = '';
                    continue;
                  }
                  default:
                    // Unknown named event — skip
                    currentEventType = '';
                    continue;
                }
              }

              // ── Standard OpenAI data events ──

              // Handle structured error events sent via SSE
              if (parsed.error) {
                const err = parsed.error;
                // Check for usage limit errors (rate limit, credits, model access)
                if (errorCode(err) === 'MODEL_NOT_IN_PLAN' || errorCode(err) === 'INSUFFICIENT_CREDITS' || err.type === 'rate_limit_error') {
                  throw new UsageLimitError({
                    type: errorCode(err) === 'MODEL_NOT_IN_PLAN' ? 'model_access' : errorCode(err) === 'INSUFFICIENT_CREDITS' ? 'credits' : 'rate_limit',
                    code: String(errorCode(err) ?? ''),
                    message: getErrorMessage(err),
                    retryable: false,
                    suggestedAction: 'upgrade',
                  });
                }

                // Generic SSE error — stop and report
                const msg = getErrorMessage(err) || 'Something went wrong. Please try again.';
                setError(new Error(msg));
                setIsLoading(false);
                if (abortControllerRef.current) {
                  abortControllerRef.current.abort();
                  abortControllerRef.current = null;
                }
                reader.cancel();
                const outcome = settleError();
                // A rolled-back send is announced by the caller, which knows the
                // text went back to the composer; don't stack two toasts.
                if (outcome === 'sent') toast.error(msg);
                return outcome;
              }

              // Handle OpenAI-compatible format
              const choice = parsed.choices?.[0];
              if (!choice) continue;

              const delta = choice.delta;
              if (!delta) continue;

              // Handle reasoning/thinking content (batched for performance)
              if (delta.reasoning) {
                pendingReasoningRef.current += delta.reasoning;
                scheduleFlush();
              }

              // Handle text content (batched for performance)
              if (delta.content) {
                if (parsed.alia_meta?.synthetic !== true) {
                  realOutputChars += delta.content.length;
                }

                // Subtle streaming haptic, throttled by time — per-character
                // counting fired dozens of native bridge calls per second on
                // fast streams.
                const now = Date.now();
                if (now - lastHapticAt >= 150) {
                  lastHapticAt = now;
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
                }

                pendingContentRef.current += delta.content;
                scheduleFlush();
              }

              // Handle usage/credits info (comes at the end of stream)
              // New format: alia_usage (separate from OpenAI usage), fallback to legacy usage
              const aliaUsage = parsed.alia_usage || parsed.usage;
              if (aliaUsage && aliaUsage.credits_remaining !== undefined) {
                queryClient.setQueryData<CreditsInfo>(queryKeys.credits.info, (old) => {
                  if (!old) return old;
                  return { ...old, credits: aliaUsage.credits_remaining };
                });
                queryClient.invalidateQueries({ queryKey: queryKeys.credits.usage() });

                // Proactive warning when spending anomaly detected
                if (aliaUsage.credit_warning) {
                  const w = aliaUsage.credit_warning;
                  queryClient.setQueryData(queryKeys.credits.usageWarning, {
                    level: w.level,
                    daysRemaining: w.daysRemaining,
                    todaySpend: w.todaySpend,
                    avgDailySpend: w.avgDailySpend,
                    currentModelMultiplier: w.currentModelMultiplier,
                  });
                }
              }

              // Handle tool calls (OpenAI format: delta.tool_calls)
              if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
                hasToolInvocations = true;
                for (const tc of delta.tool_calls) {
                  const toolCallId = tc.id;
                  const toolName = tc.function?.name;
                  if (!toolCallId || !toolName) continue;

                  let args: Record<string, unknown> | undefined;
                  if (tc.function?.arguments) {
                    try {
                      args = JSON.parse(tc.function.arguments);
                    } catch {
                      args = { _raw: tc.function.arguments };
                    }
                  }

                  setMessages((prev) => {
                    const updated = [...prev];
                    const lastMessage = updated[updated.length - 1];
                    if (lastMessage?.role === 'assistant') {
                      const invocations = [...(lastMessage.toolInvocations || [])];
                      const idx = invocations.findIndex((t) => t.toolCallId === toolCallId);
                      const invocation: ToolInvocation = { toolCallId, toolName, state: 'call', args };

                      if (idx >= 0) {
                        invocations[idx] = invocation;
                      } else {
                        invocations.push(invocation);
                      }

                      updated[updated.length - 1] = { ...lastMessage, toolInvocations: invocations };
                    }
                    return updated;
                  });
                }
              }

              // Handle tool results (custom extension: delta.tool_result)
              if (delta.tool_result) {
                const { tool_call_id, name, output } = delta.tool_result;
                if (tool_call_id) {
                  setMessages((prev) => {
                    const updated = [...prev];
                    const lastMessage = updated[updated.length - 1];
                    if (lastMessage?.role === 'assistant') {
                      const invocations = [...(lastMessage.toolInvocations || [])];
                      const idx = invocations.findIndex((t) => t.toolCallId === tool_call_id);

                      if (idx >= 0) {
                        invocations[idx] = { ...invocations[idx], state: 'result', result: output };
                      } else {
                        invocations.push({ toolCallId: tool_call_id, toolName: name || 'unknown', state: 'result', result: output });
                      }

                      updated[updated.length - 1] = { ...lastMessage, toolInvocations: invocations };
                    }
                    return updated;
                  });

                  // Detect artifact-like results and push to canvas panel
                  if (name === 'generateFile' && output && typeof output === 'object') {
                    const artifactType = output.language ? 'code' : 'markdown';
                    useUIStore.getState().addCanvasArtifact({
                      id: tool_call_id,
                      type: artifactType,
                      content: artifactType === 'code'
                        ? { language: output.language, code: output.content }
                        : { content: output.content },
                      title: output.filename || output.title || 'Generated file',
                      timestamp: Date.now(),
                    });
                    useUIStore.getState().setRightPanel('canvas');
                  } else if (output?.artifact) {
                    const a = output.artifact;
                    useUIStore.getState().addCanvasArtifact({
                      id: tool_call_id,
                      type: a.type || 'markdown',
                      content: a.data || a.content || a,
                      title: a.title || name || 'Artifact',
                      timestamp: Date.now(),
                    });
                    useUIStore.getState().setRightPanel('canvas');
                  }
                }
              }

              // Handle agent delegation messages (agent mode)
              if (delta.agent_message) {
                const am = delta.agent_message;
                setMessages((prev) => {
                  const updated = [...prev];
                  const agentMsg: Message = {
                    id: `agent-${Date.now()}-${am.agentId}`,
                    role: 'assistant',
                    content: am.content,
                    agentInfo: {
                      id: am.agentId,
                      name: am.agentName,
                      color: am.agentColor ?? null,
                      handle: am.agentHandle,
                    },
                  };
                  // Insert before the last message (Alia's in-progress response)
                  const lastIdx = updated.length - 1;
                  updated.splice(lastIdx, 0, agentMsg);
                  return updated;
                });
              }

              // Handle error events from server
              if (parsed.type === 'error') {
                const errMsg = typeof parsed.error === 'string' ? parsed.error : (parsed.error?.message || JSON.stringify(parsed.error));
                setError(new Error(errMsg));
                setIsLoading(false);

                // Abort the stream
                if (abortControllerRef.current) {
                  abortControllerRef.current.abort();
                  abortControllerRef.current = null;
                }

                // Break out of the streaming loop
                reader.cancel();
                return settleError();
              }
            } catch {
              // Malformed SSE fragments are expected mid-stream; the next
              // complete event supersedes them.
            }
          }
        }
      }

      // The send landed, so a draft parked for THIS composer is stale — clearing
      // it stops the text reappearing when the screen remounts. A draft aimed at
      // another screen is none of this send's business.
      const parkedDraft = useStore.getState().composerDraft;
      if (parkedDraft && parkedDraft.target === (conversationId ?? null)) {
        useStore.getState().clearComposerDraft();
      }
      return 'sent';
    } catch (e: unknown) {
      // Ignore abort errors (user cancelled) — partial output is theirs to keep.
      if (e instanceof Error && errorName(e) === 'AbortError') {
        return 'aborted';
      }

      // UsageLimitError thrown from the 429/402 handler above
      // Check both instanceof AND name — Hermes can break instanceof for Error subclasses
      if (e instanceof UsageLimitError || errorName(e) === 'UsageLimitError') {
        setError(e instanceof Error ? e : new Error(getErrorMessage(e)));
        return settleError();
      }

      // expoFetch may throw a non-Error object (e.g. the response body)
      // Try to detect rate limit / credit errors from the thrown object
      if (e && typeof e === 'object' && !(e instanceof Error)) {
        const thrown = e as {
          status?: number;
          error?: ThrownErrorBody;
          body?: { error?: ThrownErrorBody };
        };
        const status = thrown.status || errorStatus(e);
        const errBody: ThrownErrorBody | undefined = thrown.error || thrown.body?.error || (thrown as ThrownErrorBody);
        if (status === 429 || status === 402 || errBody?.code === 'RATE_LIMIT_EXCEEDED' || errBody?.code === 'INSUFFICIENT_CREDITS') {
          const isCredits = status === 402 || errBody?.code === 'INSUFFICIENT_CREDITS';
          const usageError = new UsageLimitError({
            type: isCredits ? 'credits' : 'rate_limit',
            code: errBody?.code || (isCredits ? 'INSUFFICIENT_CREDITS' : 'RATE_LIMIT_EXCEEDED'),
            message: errBody?.message || (isCredits ? "You've run out of credits." : "You've sent too many messages."),
            retryable: errBody?.retryable ?? !isCredits,
            retryAfterSeconds: errBody?.retryAfter,
            suggestedAction: errBody?.suggestedAction || (isCredits ? 'upgrade' : 'wait'),
          });
          setError(usageError);
          return settleError();
        }
      }

      const finalError = e instanceof Error
        ? e
        : new Error(typeof e === 'string' ? e : (getErrorMessage(e) || 'An unexpected error occurred'));
      setError(finalError);
      return settleError();
    } finally {
      // Flush any remaining batched content
      flushPendingUpdates();
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      abortControllerRef.current = null;
      setIsLoading(false);
    }
  }, [apiUrl, oxyServices, queryClient, conversationId, reasoningEffort, selectedModel, skillId, agentId, scheduleFlush, flushPendingUpdates, setMessagesAndRef]);

  const stop = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsLoading(false);
  }, []);

  const clearError = useCallback(() => setError(null), []);

  const approvePlan = useCallback((planId: string) => {
    setMessages((prev) => prev.map((m) => {
      const plan = m.pendingPlan;
      if (!plan || plan.planId !== planId) return m;
      return { ...m, pendingPlan: { ...plan, approved: true } };
    }));
    // Backend integration: POST plan approval (follow-up task)
  }, []);

  const rejectPlan = useCallback((planId: string) => {
    setMessages((prev) => prev.map((m) => {
      const plan = m.pendingPlan;
      if (!plan || plan.planId !== planId) return m;
      return { ...m, pendingPlan: { ...plan, rejected: true } };
    }));
    stop();
  }, [stop]);

  /** Put the offer away. It wrote nothing, so there is nothing else to undo. */
  const dismissSuggestedNewConversation = useCallback(() => {
    setSuggestedNewConversation(null);
  }, []);

  return {
    messages,
    isLoading,
    error,
    append,
    stop,
    setMessages: setMessagesAndRef,
    conversationTitle,
    clearError,
    approvePlan,
    rejectPlan,
    suggestedNewConversation,
    dismissSuggestedNewConversation,
  };
}
