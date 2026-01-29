import { useState, useCallback, useRef } from 'react';
import { fetch as expoFetch } from 'expo/fetch';
import * as Haptics from 'expo-haptics';
import { useOxy } from '@oxyhq/services';
import { useQueryClient } from '@tanstack/react-query';
import type { Message } from '@/lib/hooks/use-conversations';
import type { CreditsInfo } from '@/lib/hooks/use-credits';
import { collectDeviceInfo } from '@/lib/device-info';

export interface ToolInvocation {
  toolCallId: string;
  toolName: string;
  state: 'partial-call' | 'call' | 'result';
  args?: any;
  result?: any;
}

// Extract title from [TITLE]...[/TITLE] tags
function extractTitle(content: string): { content: string; title: string | null } {
  const titleMatch = content.match(/\[TITLE\](.*?)\[\/TITLE\]/);
  if (titleMatch) {
    return {
      content: content.replace(/\[TITLE\].*?\[\/TITLE\]/g, '').trim(),
      title: titleMatch[1].trim()
    };
  }
  return { content, title: null };
}

export function useStreamingChat(apiUrl: string, activeRole?: any, conversationId?: string, thinkingMode?: boolean, selectedModel?: string) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [conversationTitle, setConversationTitle] = useState<string | null>(null);
  const { activeSessionId } = useOxy();
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

      if (activeSessionId) {
        headers['x-session-id'] = activeSessionId;
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

      const response = await expoFetch(apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          messages: messagesToSend,
          stream: true,
          ...(conversationId && { conversationId }),
          ...(thinkingMode && { thinkingMode: true }),
          ...(selectedModel && { model: selectedModel }),
        }),
        signal: abortControllerRef.current.signal,
      });

      if (!response.ok) {
        let errorMessage = `Server error (${response.status})`;
        try {
          const errorData = await response.json();
          errorMessage = errorData.error || errorData.details || errorMessage;
        } catch {
          // If can't parse error as JSON, use status text
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

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          // Check if we received any content
          if (!fullContent && !error) {
            console.error('[useStreamingChat] Stream ended without content');
            setMessages((prev) => {
              const updated = [...prev];
              const lastMessage = updated[updated.length - 1];
              if (lastMessage.role === 'assistant' && !lastMessage.content) {
                updated[updated.length - 1] = {
                  ...lastMessage,
                  content: '⚠️ No response received from AI. Please try again.',
                };
              }
              return updated;
            });
            setError(new Error('No response received from AI'));
          } else if (fullContent) {
            // Extract title from final content
            const { content, title } = extractTitle(fullContent);
            if (title) {
              setConversationTitle(title);
            }
            // Update message with cleaned content
            setMessages((prev) => {
              const updated = [...prev];
              const lastMessage = updated[updated.length - 1];
              if (lastMessage.role === 'assistant') {
                updated[updated.length - 1] = {
                  ...lastMessage,
                  content: content,
                };
              }
              return updated;
            });
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
                  if (lastMessage.role === 'assistant') {
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

                // Always update immediately for smooth streaming
                setMessages((prev) => {
                  const updated = [...prev];
                  const lastMessage = updated[updated.length - 1];
                  if (lastMessage.role === 'assistant') {
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
                queryClient.setQueryData<CreditsInfo>(['credits'], (old) => {
                  if (!old) return old;
                  return { ...old, credits: parsed.usage.credits_remaining };
                });
              }

              // Note: Tool calls in OpenAI format come in delta.tool_calls
              // But for the main app, tools are executed server-side
              // so we don't need to handle them here

              // Legacy tool call handling (if backend sends old format)
              if (parsed.type === 'tool-call') {
                setMessages((prev) => {
                  const updated = [...prev];
                  const lastMessage = updated[updated.length - 1];
                  if (lastMessage.role === 'assistant') {
                    const toolInvocations = [...(lastMessage.toolInvocations || [])];
                    const existingIndex = toolInvocations.findIndex(
                      (t) => t.toolCallId === parsed.toolCallId
                    );

                    const newInvocation: ToolInvocation = {
                      toolCallId: parsed.toolCallId,
                      toolName: parsed.toolName,
                      state: 'call',
                      args: parsed.args,
                    };

                    if (existingIndex >= 0) {
                      toolInvocations[existingIndex] = newInvocation;
                    } else {
                      toolInvocations.push(newInvocation);
                    }

                    updated[updated.length - 1] = {
                      ...lastMessage,
                      toolInvocations,
                    };
                  }
                  return updated;
                });
              }

              // Handle tool results
              if (parsed.type === 'tool-result') {
                setMessages((prev) => {
                  const updated = [...prev];
                  const lastMessage = updated[updated.length - 1];
                  if (lastMessage.role === 'assistant') {
                    const toolInvocations = [...(lastMessage.toolInvocations || [])];
                    const existingIndex = toolInvocations.findIndex(
                      (t) => t.toolCallId === parsed.toolCallId
                    );

                    if (existingIndex >= 0) {
                      toolInvocations[existingIndex] = {
                        ...toolInvocations[existingIndex],
                        state: 'result',
                        result: parsed.result,
                      };
                    }

                    updated[updated.length - 1] = {
                      ...lastMessage,
                      toolInvocations,
                    };
                  }
                  return updated;
                });
              }

              // Handle credit updates - update React Query cache
              if (parsed.type === 'credit-update') {
                queryClient.setQueryData<CreditsInfo>(['credits'], (old) => {
                  if (!old) return old;
                  return { ...old, credits: parsed.credits };
                });
              }

              // Handle error events from server
              if (parsed.type === 'error') {
                console.error('[useStreamingChat] Server error:', parsed.error);

                // Update the assistant message with error information
                setMessages((prev) => {
                  const updated = [...prev];
                  const lastMessage = updated[updated.length - 1];
                  if (lastMessage.role === 'assistant' && !lastMessage.content) {
                    // If assistant message is empty, show error in it
                    updated[updated.length - 1] = {
                      ...lastMessage,
                      content: `⚠️ Error: ${parsed.error}`,
                    };
                  }
                  return updated;
                });

                // Set error state and stop loading
                setError(new Error(parsed.error));
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
    } catch (e) {
      // Ignore abort errors (user cancelled)
      if (e instanceof Error && e.name === 'AbortError') {
        return;
      }
      console.error('[useStreamingChat] Error:', e);
      setError(e as Error);

      // Remove the empty assistant message on error
      setMessages((prev) => prev.filter((m) => m.id !== assistantMessageId));
    } finally {
      abortControllerRef.current = null;
      setIsLoading(false);
    }
  }, [apiUrl, messages, activeSessionId, activeRole, queryClient, thinkingMode, selectedModel]);

  const stop = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsLoading(false);
  }, []);

  return {
    messages,
    isLoading,
    error,
    append,
    stop,
    setMessages,
    conversationTitle,
  };
}
