import { useState, useRef, useCallback, useEffect } from 'react';
import { useOxy } from '@oxyhq/services';
import type { ChatMessage, ToolInvocation } from '../types';

const API_URL = process.env.EXPO_PUBLIC_ALIA_API_URL ?? 'https://api.alia.onl';

export interface UseAliaChatOptions {
  /** Alia API base URL (default: EXPO_PUBLIC_ALIA_API_URL or https://api.alia.onl) */
  apiUrl?: string;
  /** Alia model to use (default: 'alia-v1') */
  model?: string;
  /** App context injected as system message so Alia knows which app the user is in */
  clientContext?: string;
  /** Access token override — if not provided, fetched from useOxy() */
  accessToken?: string;
}

export interface UseAliaChatReturn {
  messages: ChatMessage[];
  send: (text: string) => void;
  isStreaming: boolean;
  clear: () => void;
  error: string | null;
}

function generateId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `msg-${crypto.randomUUID()}`;
  }
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * SSE streaming chat hook for Alia.
 *
 * Sends messages to Alia's /v1/chat/completions endpoint and streams
 * responses back, including tool invocations, reasoning, research progress,
 * and plan previews.
 */
export function useAliaChat(options: UseAliaChatOptions = {}): UseAliaChatReturn {
  const {
    apiUrl = API_URL,
    model = 'alia-v1',
    clientContext,
    accessToken: accessTokenProp,
  } = options;

  const { oxyServices } = useOxy();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Use a ref to read current messages without putting it in send's dep array
  const messagesRef = useRef<ChatMessage[]>([]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // Batching: accumulate streaming content and flush at ~20fps
  const pendingContentRef = useRef('');
  const pendingReasoningRef = useRef('');
  const toolInvocationsRef = useRef<ToolInvocation[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushPendingUpdates = useCallback(() => {
    const content = pendingContentRef.current;
    const reasoning = pendingReasoningRef.current;
    const tools = toolInvocationsRef.current;
    if (!content && !reasoning && tools.length === 0) return;

    pendingContentRef.current = '';
    pendingReasoningRef.current = '';

    setMessages((prev) => {
      const updated = [...prev];
      const last = updated[updated.length - 1];
      if (last?.role === 'assistant') {
        const changes: Partial<ChatMessage> = {};
        if (content) changes.content = last.content + content;
        if (reasoning) changes.thinking = (last.thinking || '') + reasoning;
        if (tools.length > 0) changes.toolInvocations = [...tools];
        updated[updated.length - 1] = { ...last, ...changes };
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

  // Cleanup flush timer on unmount
  useEffect(() => {
    return () => {
      flushPendingUpdates();
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
    };
  }, [flushPendingUpdates]);

  const getToken = useCallback((): string | null => {
    if (accessTokenProp) return accessTokenProp;
    return oxyServices.httpService.getAccessToken();
  }, [accessTokenProp, oxyServices]);

  /** Update the last assistant message with partial changes (callback receives current message) */
  const updateAssistant = useCallback(
    (updater: (msg: ChatMessage) => Partial<ChatMessage>) => {
      setMessages((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last?.role === 'assistant') {
          updated[updated.length - 1] = { ...last, ...updater(last) };
        }
        return updated;
      });
    },
    [],
  );

  /** Apply a tool result to the last assistant message and sync the ref */
  const applyToolResult = useCallback(
    (toolCallId: string, name: string | undefined, output: any) => {
      updateAssistant((last) => {
        const invocations = [...(last.toolInvocations || [])];
        const idx = invocations.findIndex((t) => t.toolCallId === toolCallId);
        if (idx >= 0) {
          invocations[idx] = { ...invocations[idx], state: 'result', result: output };
        } else {
          invocations.push({ toolCallId, toolName: name || 'unknown', state: 'result', result: output });
        }
        return { toolInvocations: invocations };
      });
      toolInvocationsRef.current = toolInvocationsRef.current.map((t) =>
        t.toolCallId === toolCallId ? { ...t, state: 'result' as const, result: output } : t
      );
    },
    [updateAssistant],
  );

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isStreaming) return;

      const token = getToken();
      if (!token) {
        setError('Not authenticated');
        return;
      }

      setError(null);

      // Add user message
      const userMsg: ChatMessage = {
        id: generateId(),
        role: 'user',
        content: trimmed,
        createdAt: Date.now(),
      };

      // Prepare assistant placeholder
      const assistantMsg: ChatMessage = {
        id: generateId(),
        role: 'assistant',
        content: '',
        toolInvocations: [],
        createdAt: Date.now(),
      };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setIsStreaming(true);

      // Build messages payload for the API (read from ref, not closure)
      const apiMessages: Array<{ role: string; content: string }> = [];

      if (clientContext) {
        apiMessages.push({ role: 'system', content: clientContext });
      }

      // Include full conversation history with tool context
      for (const msg of messagesRef.current) {
        if (msg.role === 'system') continue;
        apiMessages.push({ role: msg.role, content: msg.content });
        // Include tool results so the AI has full context
        if (msg.toolInvocations?.length) {
          for (const tool of msg.toolInvocations) {
            if (tool.state === 'result' && tool.result != null) {
              apiMessages.push({
                role: 'system',
                content: `[Tool result from ${tool.toolName}: ${JSON.stringify(tool.result).slice(0, 500)}]`,
              });
            }
          }
        }
      }

      apiMessages.push({ role: 'user', content: trimmed });

      const controller = new AbortController();
      abortRef.current = controller;

      // Reset batching state
      pendingContentRef.current = '';
      pendingReasoningRef.current = '';
      toolInvocationsRef.current = [];

      try {
        const response = await fetch(`${apiUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            model,
            messages: apiMessages,
            stream: true,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          throw new Error(`API error ${response.status}: ${body.slice(0, 200)}`);
        }

        // Non-streaming fallback
        if (!response.body || typeof response.body.getReader !== 'function') {
          const json = await response.json();
          const content = json.choices?.[0]?.message?.content ?? '';
          updateAssistant(() => ({ content }));
          return;
        }

        // Stream SSE (supports named events: event: X\ndata: Y)
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let currentEventType = '';

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

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

              const trimmedLine = line.trim();
              if (!trimmedLine.startsWith('data: ')) continue;
              const data = trimmedLine.slice(6);
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
                        applyToolResult(tool_call_id, name, output);
                      }
                      currentEventType = '';
                      continue;
                    }
                    case 'alia.research_progress': {
                      updateAssistant((last) => ({
                        researchProgress: {
                          phase: parsed.phase,
                          message: parsed.message,
                          subQuestions: parsed.subQuestions || last.researchProgress?.subQuestions,
                          sourcesFound: parsed.sourcesFound,
                          currentQuery: parsed.currentQuery,
                          iteration: parsed.iteration,
                        },
                      }));
                      currentEventType = '';
                      continue;
                    }
                    case 'alia.plan_preview': {
                      updateAssistant(() => ({
                        pendingPlan: {
                          planId: parsed.planId,
                          intent: parsed.intent,
                          confidence: parsed.confidence,
                          steps: parsed.steps || [],
                          approved: false,
                          rejected: false,
                        },
                      }));
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

                const choice = parsed.choices?.[0];
                if (!choice) {
                  // Legacy alia.tool_call event (type-based, not named SSE)
                  if (parsed.type === 'alia.tool_call') {
                    toolInvocationsRef.current = [
                      ...toolInvocationsRef.current,
                      {
                        toolName: parsed.tool || 'unknown',
                        state: 'call',
                        args: parsed.args,
                      },
                    ];
                    flushPendingUpdates();
                  }
                  // Legacy format matches by toolName (no toolCallId), so can't use applyToolResult
                  if (parsed.type === 'alia.tool_result') {
                    toolInvocationsRef.current = toolInvocationsRef.current.map((t) =>
                      t.toolName === parsed.tool && t.state === 'call'
                        ? { ...t, state: 'result' as const, result: parsed.result }
                        : t,
                    );
                    flushPendingUpdates();
                  }
                  continue;
                }

                const delta = choice.delta;
                if (!delta) continue;

                // Reasoning/thinking content (batched)
                if (delta.reasoning) {
                  pendingReasoningRef.current += delta.reasoning;
                  scheduleFlush();
                }

                // Text content (batched)
                if (delta.content) {
                  pendingContentRef.current += delta.content;
                  scheduleFlush();
                }

                // Tool calls (OpenAI format: delta.tool_calls)
                if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
                  for (const tc of delta.tool_calls) {
                    const toolCallId = tc.id;
                    const toolName = tc.function?.name;
                    if (!toolCallId || !toolName) continue;

                    let args: any;
                    if (tc.function?.arguments) {
                      try { args = JSON.parse(tc.function.arguments); } catch { args = { _raw: tc.function.arguments }; }
                    }

                    const invocation: ToolInvocation = { toolCallId, toolName, state: 'call', args };
                    const idx = toolInvocationsRef.current.findIndex((t) => t.toolCallId === toolCallId);
                    if (idx >= 0) {
                      toolInvocationsRef.current[idx] = invocation;
                    } else {
                      toolInvocationsRef.current = [...toolInvocationsRef.current, invocation];
                    }
                    flushPendingUpdates();
                  }
                }

                // Tool results (delta.tool_result)
                if (delta.tool_result) {
                  const { tool_call_id, name, output } = delta.tool_result;
                  if (tool_call_id) {
                    applyToolResult(tool_call_id, name, output);
                  }
                }
              } catch {
                // Skip malformed chunks
              }
            }
          }
        } finally {
          reader.releaseLock();
        }
      } catch (err: any) {
        if (err?.name === 'AbortError') return;
        const errorMessage = err?.message || 'Something went wrong';
        setError(errorMessage);
        updateAssistant((last) =>
          !last.content ? { content: "I'm having trouble connecting right now. Please try again." } : {}
        );
      } finally {
        // Flush any remaining batched content
        flushPendingUpdates();
        if (flushTimerRef.current) {
          clearTimeout(flushTimerRef.current);
          flushTimerRef.current = null;
        }
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [isStreaming, getToken, apiUrl, model, clientContext, scheduleFlush, flushPendingUpdates, updateAssistant, applyToolResult],
  );

  const clear = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setMessages([]);
    setIsStreaming(false);
    setError(null);
    pendingContentRef.current = '';
    pendingReasoningRef.current = '';
    toolInvocationsRef.current = [];
  }, []);

  return { messages, send, isStreaming, clear, error };
}
