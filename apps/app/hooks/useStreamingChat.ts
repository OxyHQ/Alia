import { useState, useCallback } from 'react';
import { fetch as expoFetch } from 'expo/fetch';
import * as Haptics from 'expo-haptics';
import { useAuthStore } from '@/lib/stores/auth-store';
import { useCreditsStore } from '@/lib/stores/credits-store';

export interface ToolInvocation {
  toolCallId: string;
  toolName: string;
  state: 'partial-call' | 'call' | 'result';
  args?: any;
  result?: any;
}

export interface Message {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  toolInvocations?: ToolInvocation[];
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

export function useStreamingChat(apiUrl: string, activeRole?: any) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [conversationTitle, setConversationTitle] = useState<string | null>(null);
  const token = useAuthStore((state) => state.token);
  const updateCredits = useCreditsStore((state) => state.updateCredits);

  const append = useCallback(async (message: Message) => {
    setIsLoading(true);
    setError(null);

    // Add user message
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
      // Build headers with optional auth token
      const headers: HeadersInit = {
        'Content-Type': 'application/json',
      };

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
      const messagesToSend = systemMessage
        ? [
            { role: 'system', content: systemMessage },
            ...messages,
            userMessage,
          ].map((m) => ({
            role: m.role,
            content: m.content,
          }))
        : [...messages, userMessage].map((m) => ({
            role: m.role,
            content: m.content,
          }));

      const response = await expoFetch(apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          messages: messagesToSend,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      if (!response.body) {
        throw new Error('No response body');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullContent = '';
      let charCount = 0;

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
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
              console.log('[SSE Event]', parsed.type, parsed);

              // Handle text deltas
              if (parsed.type === 'text-delta' && parsed.text) {
                fullContent += parsed.text;

                // Subtle haptic feedback every 15 characters
                charCount += parsed.text.length;
                if (charCount >= 15) {
                  charCount = 0;
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
                }

                setMessages((prev) => {
                  const updated = [...prev];
                  const lastMessage = updated[updated.length - 1];
                  if (lastMessage.role === 'assistant') {
                    updated[updated.length - 1] = {
                      ...lastMessage,
                      content: lastMessage.content + parsed.text,
                    };
                  }
                  return updated;
                });
              }

              // Handle tool calls
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

              // Handle credit updates
              if (parsed.type === 'credit-update') {
                console.log('[Credit Update]', parsed);
                updateCredits(parsed.credits);
              }
            } catch (e) {
              // Ignore parse errors
            }
          }
        }
      }
    } catch (e) {
      console.error('[useStreamingChat] Error:', e);
      setError(e as Error);

      // Remove the empty assistant message on error
      setMessages((prev) => prev.filter((m) => m.id !== assistantMessageId));
    } finally {
      setIsLoading(false);
    }
  }, [apiUrl, messages, token, activeRole]);

  const stop = useCallback(() => {
    // TODO: Implement abort controller
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
