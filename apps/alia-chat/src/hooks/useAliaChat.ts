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
 * responses back, including tool invocations.
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
  const toolInvocationsRef = useRef<ToolInvocation[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushPendingUpdates = useCallback(() => {
    const content = pendingContentRef.current;
    const tools = toolInvocationsRef.current;
    if (!content && tools.length === 0) return;

    pendingContentRef.current = '';

    setMessages((prev) => {
      const updated = [...prev];
      const last = updated[updated.length - 1];
      if (last?.role === 'assistant') {
        updated[updated.length - 1] = {
          ...last,
          content: last.content + content,
          toolInvocations: tools.length > 0 ? [...tools] : last.toolInvocations,
        };
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
          setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.role === 'assistant') {
              updated[updated.length - 1] = { ...last, content };
            }
            return updated;
          });
          return;
        }

        // Stream SSE
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
              const trimmedLine = line.trim();
              if (!trimmedLine || !trimmedLine.startsWith('data: ')) continue;
              const data = trimmedLine.slice(6);
              if (data === '[DONE]') continue;

              try {
                const parsed = JSON.parse(data);

                // Standard content delta — batch it
                const delta = parsed.choices?.[0]?.delta?.content;
                if (delta) {
                  pendingContentRef.current += delta;
                  scheduleFlush();
                }

                // Alia tool call event — update immediately (infrequent)
                if (parsed.type === 'alia.tool_call') {
                  toolInvocationsRef.current = [
                    ...toolInvocationsRef.current,
                    {
                      toolName: parsed.tool || 'unknown',
                      state: 'call',
                      args: parsed.args,
                    },
                  ];
                  // Flush immediately so UI shows tool status
                  flushPendingUpdates();
                }

                // Alia tool result event — immutable update
                if (parsed.type === 'alia.tool_result') {
                  toolInvocationsRef.current = toolInvocationsRef.current.map((t) =>
                    t.toolName === parsed.tool && t.state === 'call'
                      ? { ...t, state: 'result' as const, result: parsed.result }
                      : t,
                  );
                  flushPendingUpdates();
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
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.role === 'assistant' && !last.content) {
            updated[updated.length - 1] = {
              ...last,
              content: "I'm having trouble connecting right now. Please try again.",
            };
          }
          return updated;
        });
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
    [isStreaming, getToken, apiUrl, model, clientContext, scheduleFlush, flushPendingUpdates],
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
    toolInvocationsRef.current = [];
  }, []);

  return { messages, send, isStreaming, clear, error };
}
