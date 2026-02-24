import { useState, useCallback, useRef } from 'react';
import { fetch as expoFetch } from 'expo/fetch';
import * as Haptics from 'expo-haptics';
import { useOxy } from '@oxyhq/services';
import { useQueryClient } from '@tanstack/react-query';
import type { Message } from '@/lib/hooks/use-conversations';
import type { CreditsInfo } from '@/lib/hooks/use-credits';
import { collectDeviceInfo } from '@/lib/device-info';
import { UsageLimitError } from '@/lib/errors/usage-limit-error';
import { queryKeys } from '@/lib/hooks/query-keys';
import { useStore } from '@/lib/globalStore';
import { toast } from '@/components/sonner';

import type { ToolInvocation } from '@/lib/types/messages';
export type { ToolInvocation };


export function useStreamingChat(apiUrl: string, activeRole?: any, conversationId?: string, thinkingMode?: boolean, selectedModel?: string, skillId?: string | null, agentId?: string | null) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [conversationTitle, setConversationTitle] = useState<string | null>(null);
  const { oxyServices } = useOxy();
  const queryClient = useQueryClient();
  const abortControllerRef = useRef<AbortController | null>(null);

  const append = useCallback(async (message: Message) => {
    setIsLoading(true);
    setError(null);

    const userMessage = { ...message, id: Date.now().toString() };
    setMessages((prev) => [...prev, userMessage]);

    // Create assistant message placeholder
    const assistantMessageId = (Date.now() + 1).toString();
    const assistantMessage: Message = {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      toolInvocations: [],
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

      // Build system message with role context if active
      let systemMessage = '';
      if (activeRole) {
        systemMessage = `You are acting in the role of "${activeRole.name}".

Role Description: ${activeRole.description}

Reasoning Approach: ${activeRole.reasoning}
Writing Style: ${activeRole.writingStyle}
Tone: ${activeRole.tone}
Priorities: ${activeRole.priorities.join(', ')}

Use this role to guide your responses, maintaining the specified tone, style, and priorities throughout the conversation.`;
      }

      // Build messages array with system message if present
      // Include tool invocations for proper conversation context
      const conversationMessages = [...messages, userMessage];

      const formatMessage = (m: Message | { role: string; content: string }) => {
        const msg: any = {
          role: m.role,
          content: m.content,
        };
        // Include tool invocations if present for assistant messages
        if ('toolInvocations' in m && m.role === 'assistant' && m.toolInvocations && m.toolInvocations.length > 0) {
          msg.toolInvocations = m.toolInvocations.map((inv: ToolInvocation) => ({
            toolCallId: inv.toolCallId,
            toolName: inv.toolName,
            state: inv.state,
            args: inv.args,
            result: inv.result,
          }));
        }
        return msg;
      };

      const messagesToSend = systemMessage
        ? [
            { role: 'system', content: systemMessage },
            ...conversationMessages,
          ].map(formatMessage)
        : conversationMessages.map(formatMessage);

      // Create abort controller for this request
      abortControllerRef.current = new AbortController();

      const agentMode = useStore.getState().agentMode;

      const response = await expoFetch(apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          messages: messagesToSend,
          stream: true,
          ...(conversationId && { conversationId }),
          ...(thinkingMode && { thinkingMode: true }),
          ...(selectedModel && { model: selectedModel }),
          ...(skillId && { skillId }),
          ...(agentId && { agentId }),
          ...(agentMode && { agentMode: true }),
        }),
        signal: abortControllerRef.current.signal,
      });

      if (!response.ok) {
        let errorData: any = null;
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
        } catch {}

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

        // Generic error fallback
        let errorMessage = `Server error (${response.status})`;
        if (errorData) {
          const err = errorData.error;
          if (typeof err === 'string') {
            errorMessage = err;
          } else if (err?.message) {
            errorMessage = err.message;
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
      let fullContent = '';
      let charCount = 0;
      let hasToolInvocations = false;

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          // Check if we received any content
          if (!fullContent && !error && !hasToolInvocations) {
            console.error('[useStreamingChat] Stream ended without content');
            setMessages((prev) => {
              const updated = [...prev];
              const lastMessage = updated[updated.length - 1];
              if (lastMessage?.role === 'assistant' && !lastMessage.content) {
                updated[updated.length - 1] = {
                  ...lastMessage,
                  content: '⚠️ No response received from AI. Please try again.',
                };
              }
              return updated;
            });
            setError(new Error('No response received from AI'));
          }
          break;
        }

        // Decode chunk and add to buffer
        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;

        // Process complete lines
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();

            // Skip [DONE] marker
            if (data === '[DONE]') continue;

            try {
              const parsed = JSON.parse(data);

              // Handle structured error events sent via SSE (when headers were sent before validation)
              if (parsed.error?.status) {
                const err = parsed.error;
                if ([429, 402, 403].includes(err.status)) {
                  throw new UsageLimitError({
                    type: err.code === 'MODEL_NOT_IN_PLAN' ? 'model_access' : err.code === 'INSUFFICIENT_CREDITS' ? 'credits' : 'rate_limit',
                    code: err.code,
                    message: err.message,
                    retryable: err.retryable ?? false,
                    suggestedAction: err.suggestedAction || 'upgrade',
                  });
                }
              }

              // Generic SSE error (503 NO_MODELS, 500, etc.) — show toast and stop
              if (parsed.error) {
                const msg = parsed.error.message || 'Something went wrong. Please try again.';
                toast.error(msg);
                setError(new Error(msg));
                setIsLoading(false);
                setMessages((prev) => prev.filter((m) => m.id !== assistantMessageId));
                if (abortControllerRef.current) {
                  abortControllerRef.current.abort();
                  abortControllerRef.current = null;
                }
                reader.cancel();
                return;
              }

              // Handle OpenAI-compatible format
              const choice = parsed.choices?.[0];
              if (!choice) continue;

              const delta = choice.delta;
              if (!delta) continue;

              // Handle reasoning/thinking content (thinking mode)
              if (delta.reasoning) {
                setMessages((prev) => {
                  const updated = [...prev];
                  const lastMessage = updated[updated.length - 1];
                  if (lastMessage?.role === 'assistant') {
                    const currentThinking = (lastMessage as any).thinking || '';
                    updated[updated.length - 1] = {
                      ...lastMessage,
                      thinking: currentThinking + delta.reasoning,
                    } as any;
                  }
                  return updated;
                });
              }

              // Handle text content
              if (delta.content) {
                fullContent += delta.content;

                // Subtle haptic feedback every 15 characters
                charCount += delta.content.length;
                if (charCount >= 15) {
                  charCount = 0;
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
                }

                setMessages((prev) => {
                  const updated = [...prev];
                  const lastMessage = updated[updated.length - 1];
                  if (lastMessage?.role === 'assistant') {
                    updated[updated.length - 1] = {
                      ...lastMessage,
                      content: lastMessage.content + delta.content,
                    };
                  }
                  return updated;
                });
              }

              // Handle usage/credits info (comes at the end of stream)
              if (parsed.usage && parsed.usage.credits_remaining !== undefined) {
                queryClient.setQueryData<CreditsInfo>(queryKeys.credits.info, (old) => {
                  if (!old) return old;
                  return { ...old, credits: parsed.usage.credits_remaining };
                });
                queryClient.invalidateQueries({ queryKey: queryKeys.credits.usage() });

                // Proactive warning when spending anomaly detected
                if (parsed.usage.credit_warning) {
                  const w = parsed.usage.credit_warning;
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

                  let args: any;
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
                      avatar: am.agentAvatar,
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
                console.error('[useStreamingChat] Server error:', parsed.error);

                // Update the assistant message with error information
                setMessages((prev) => {
                  const updated = [...prev];
                  const lastMessage = updated[updated.length - 1];
                  if (lastMessage?.role === 'assistant' && !lastMessage.content) {
                    // If assistant message is empty, show error in it
                    updated[updated.length - 1] = {
                      ...lastMessage,
                      content: `⚠️ Error: ${typeof parsed.error === 'string' ? parsed.error : (parsed.error?.message || 'Unknown error')}`,
                    };
                  }
                  return updated;
                });

                // Set error state and stop loading
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
                return;
              }
            } catch (e) {
              // Ignore parse errors for malformed JSON
              console.warn('[useStreamingChat] Failed to parse SSE event:', e);
            }
          }
        }
      }
    } catch (e: any) {
      // Ignore abort errors (user cancelled)
      if (e instanceof Error && e.name === 'AbortError') {
        return;
      }

      // UsageLimitError thrown from the 429/402 handler above
      // Check both instanceof AND name — Hermes can break instanceof for Error subclasses
      if (e instanceof UsageLimitError || e?.name === 'UsageLimitError') {
        setError(e);
        setMessages((prev) => prev.filter((m) => m.id !== assistantMessageId));
        return;
      }

      // expoFetch may throw a non-Error object (e.g. the response body)
      // Try to detect rate limit / credit errors from the thrown object
      if (e && typeof e === 'object' && !(e instanceof Error)) {
        const status = e.status || e.statusCode;
        const errBody = e.error || e.body?.error || e;
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
          setMessages((prev) => prev.filter((m) => m.id !== assistantMessageId));
          return;
        }
      }

      console.error('[useStreamingChat] Error:', e);
      const finalError = e instanceof Error
        ? e
        : new Error(typeof e === 'string' ? e : (e?.message || 'An unexpected error occurred'));
      setError(finalError);

      // Remove the empty assistant message on error
      setMessages((prev) => prev.filter((m) => m.id !== assistantMessageId));
    } finally {
      abortControllerRef.current = null;
      setIsLoading(false);
    }
  }, [apiUrl, messages, oxyServices, activeRole, queryClient, thinkingMode, selectedModel, skillId, agentId]);

  const stop = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsLoading(false);
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return {
    messages,
    isLoading,
    error,
    append,
    stop,
    setMessages,
    conversationTitle,
    clearError,
  };
}
