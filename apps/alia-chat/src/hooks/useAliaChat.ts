import { useState, useRef, useCallback } from 'react';
import { useOxy } from '@oxyhq/services';
import type { ChatMessage, ToolInvocation } from '../types';

const API_URL = process.env.EXPO_PUBLIC_API_URL;

export interface UseAliaChatOptions {
  /** Alia API base URL (default: EXPO_PUBLIC_API_URL) */
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

let nextId = 0;
function generateId(): string {
  return `msg-${Date.now()}-${nextId++}`;
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

      // Build messages payload for the API
      const apiMessages: Array<{ role: string; content: string }> = [];

      // System context (tells Alia which app the user is in)
      if (clientContext) {
        apiMessages.push({ role: 'system', content: clientContext });
      }

      // Previous conversation history
      for (const msg of messages) {
        if (msg.role === 'system') continue;
        apiMessages.push({ role: msg.role, content: msg.content });
      }

      // New user message
      apiMessages.push({ role: 'user', content: trimmed });

      const controller = new AbortController();
      abortRef.current = controller;

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
        let accumulatedContent = '';
        const toolInvocations: ToolInvocation[] = [];

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

                // Standard content delta
                const delta = parsed.choices?.[0]?.delta?.content;
                if (delta) {
                  accumulatedContent += delta;
                  setMessages((prev) => {
                    const updated = [...prev];
                    const last = updated[updated.length - 1];
                    if (last?.role === 'assistant') {
                      updated[updated.length - 1] = {
                        ...last,
                        content: accumulatedContent,
                        toolInvocations: toolInvocations.length > 0 ? [...toolInvocations] : undefined,
                      };
                    }
                    return updated;
                  });
                }

                // Alia tool call event
                if (parsed.type === 'alia.tool_call') {
                  toolInvocations.push({
                    toolName: parsed.tool || 'unknown',
                    state: 'call',
                    args: parsed.args,
                  });
                  setMessages((prev) => {
                    const updated = [...prev];
                    const last = updated[updated.length - 1];
                    if (last?.role === 'assistant') {
                      updated[updated.length - 1] = {
                        ...last,
                        toolInvocations: [...toolInvocations],
                      };
                    }
                    return updated;
                  });
                }

                // Alia tool result event
                if (parsed.type === 'alia.tool_result') {
                  const existing = toolInvocations.find(
                    (t) => t.toolName === parsed.tool && t.state === 'call',
                  );
                  if (existing) {
                    existing.state = 'result';
                    existing.result = parsed.result;
                  }
                  setMessages((prev) => {
                    const updated = [...prev];
                    const last = updated[updated.length - 1];
                    if (last?.role === 'assistant') {
                      updated[updated.length - 1] = {
                        ...last,
                        toolInvocations: [...toolInvocations],
                      };
                    }
                    return updated;
                  });
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
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [isStreaming, messages, getToken, apiUrl, model, clientContext],
  );

  const clear = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setMessages([]);
    setIsStreaming(false);
    setError(null);
  }, []);

  return { messages, send, isStreaming, clear, error };
}
