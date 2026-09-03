import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useOxy } from '@oxyhq/services';
import type { ChatMessage, ToolInvocation } from '../types';
import { getTextFromContent } from '../lib/content-utils';
import { resolveModelId } from '../lib/catalogue';
import { PREFERRED_CHAT_MODEL_ID } from '../lib/config';
import { streamAliaChat } from '../lib/chat-transport';
import type { AliaChatStreamEvent } from '../lib/chat-stream';

const API_URL = process.env.EXPO_PUBLIC_ALIA_API_URL ?? 'https://api.alia.onl';

export interface UseAliaChatOptions {
  /** Alia API base URL (default: EXPO_PUBLIC_ALIA_API_URL or https://api.alia.onl) */
  apiUrl?: string;
  /** Alia model or routing profile to use. */
  model?: string;
  /** App context injected as system message so Alia knows which app the user is in. */
  clientContext?: string;
  /**
   * Optional assertion for callers that already hold the surrounding
   * OxyProvider's active token. A different token is refused; the SDK never
   * writes this value to an Authorization header itself.
   */
  accessToken?: string;
}

export interface UseAliaChatReturn {
  messages: ChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  send: (text: string) => void;
  isStreaming: boolean;
  stop: () => void;
  clear: () => void;
  error: string | null;
}

interface ActiveRequest {
  readonly key: symbol;
  readonly controller: AbortController;
}

interface PendingUpdates {
  readonly assistantId: string;
  content: string;
  reasoning: string;
  tools: ToolInvocation[];
  timer: ReturnType<typeof setTimeout> | null;
}

function generateId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `msg-${crypto.randomUUID()}`;
  }
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === 'AbortError');
}

function abortError(): Error {
  const error = new Error('The Alia request was aborted.');
  error.name = 'AbortError';
  return error;
}

function waitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * SSE streaming chat hook for Alia.
 *
 * The SDK deliberately stays on `/v1/chat/completions`: unlike the product
 * origin, this raw-source package is embedded by apps whose browser origins are
 * not all on Alia's narrow CORS allowlist. The endpoint is still Alia's product
 * handler during its recorded compatibility window.
 */
export function useAliaChat(options: UseAliaChatOptions = {}): UseAliaChatReturn {
  const {
    apiUrl = API_URL,
    model = PREFERRED_CHAT_MODEL_ID,
    clientContext,
    accessToken: accessTokenProp,
  } = options;
  const requestUrl = '/v1/chat/completions';

  const { oxyServices } = useOxy();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const activeRequestRef = useRef<ActiveRequest | null>(null);
  const pendingRef = useRef<PendingUpdates | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const updateAssistant = useCallback(
    (assistantId: string, updater: (message: ChatMessage) => Partial<ChatMessage>) => {
      if (!mountedRef.current) return;
      setMessages((previous) => {
        const index = previous.findIndex((message) => message.id === assistantId);
        if (index < 0 || previous[index]?.role !== 'assistant') return previous;
        const updated = [...previous];
        const current = updated[index];
        if (!current) return previous;
        updated[index] = { ...current, ...updater(current) };
        messagesRef.current = updated;
        return updated;
      });
    },
    [],
  );

  const removeEmptyAssistant = useCallback((assistantId: string) => {
    if (!mountedRef.current) return;
    setMessages((previous) => {
      const target = previous.find((message) => message.id === assistantId);
      if (
        target?.role !== 'assistant' ||
        getTextFromContent(target.content).trim().length > 0 ||
        (target.thinking?.trim().length ?? 0) > 0 ||
        (target.toolInvocations?.length ?? 0) > 0
      ) {
        return previous;
      }
      const updated = previous.filter((message) => message.id !== assistantId);
      messagesRef.current = updated;
      return updated;
    });
  }, []);

  const flushPendingUpdates = useCallback(
    (pending: PendingUpdates) => {
      const content = pending.content;
      const reasoning = pending.reasoning;
      const tools = [...pending.tools];
      if (!content && !reasoning && tools.length === 0) return;

      pending.content = '';
      pending.reasoning = '';
      updateAssistant(pending.assistantId, (last) => ({
        ...(content ? { content: getTextFromContent(last.content) + content } : {}),
        ...(reasoning ? { thinking: (last.thinking ?? '') + reasoning } : {}),
        ...(tools.length > 0 ? { toolInvocations: tools } : {}),
      }));
    },
    [updateAssistant],
  );

  const cancelPendingTimer = useCallback((pending: PendingUpdates) => {
    if (pending.timer !== null) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
  }, []);

  const scheduleFlush = useCallback(
    (pending: PendingUpdates) => {
      if (pending.timer !== null) return;
      pending.timer = setTimeout(() => {
        pending.timer = null;
        flushPendingUpdates(pending);
      }, 50);
    },
    [flushPendingUpdates],
  );

  const stop = useCallback(() => {
    const active = activeRequestRef.current;
    activeRequestRef.current = null;
    active?.controller.abort();

    const pending = pendingRef.current;
    if (pending !== null) {
      cancelPendingTimer(pending);
      flushPendingUpdates(pending);
      pendingRef.current = null;
    }
    if (mountedRef.current) setIsStreaming(false);
  }, [cancelPendingTimer, flushPendingUpdates]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeRequestRef.current?.controller.abort();
      activeRequestRef.current = null;
      const pending = pendingRef.current;
      if (pending !== null) cancelPendingTimer(pending);
      pendingRef.current = null;
    };
  }, [cancelPendingTimer]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      const activeToken = oxyServices.getAccessToken();
      if (accessTokenProp !== undefined && accessTokenProp !== activeToken) {
        setError('The supplied token is not the active Oxy session.');
        return;
      }

      // A new turn supersedes the previous one. Scope every later update to its
      // assistant id and request key so an abort racing with the replacement
      // cannot mutate the new placeholder or clear its streaming state.
      const previousRequest = activeRequestRef.current;
      activeRequestRef.current = null;
      previousRequest?.controller.abort();
      const previousPending = pendingRef.current;
      if (previousPending !== null) {
        cancelPendingTimer(previousPending);
        flushPendingUpdates(previousPending);
      }

      const userMessage: ChatMessage = {
        id: generateId(),
        role: 'user',
        content: trimmed,
        createdAt: Date.now(),
      };
      const assistantMessage: ChatMessage = {
        id: generateId(),
        role: 'assistant',
        content: '',
        toolInvocations: [],
        createdAt: Date.now(),
      };
      const history = messagesRef.current.filter(
        (message) =>
          message.role !== 'assistant' ||
          getTextFromContent(message.content).trim().length > 0 ||
          (message.thinking?.trim().length ?? 0) > 0 ||
          (message.toolInvocations?.length ?? 0) > 0,
      );
      setMessages((previous) => {
        const updated = [...previous, userMessage, assistantMessage];
        messagesRef.current = updated;
        return updated;
      });
      setError(null);
      setIsStreaming(true);

      const apiMessages: Array<{ role: string; content: string }> = [];
      if (clientContext) apiMessages.push({ role: 'system', content: clientContext });
      for (const message of history) {
        if (message.role === 'system') continue;
        apiMessages.push({ role: message.role, content: getTextFromContent(message.content) });
        for (const tool of message.toolInvocations ?? []) {
          if (tool.state === 'result' && tool.result !== undefined && tool.result !== null) {
            apiMessages.push({
              role: 'system',
              content: `[Tool result from ${tool.toolName}: ${JSON.stringify(tool.result).slice(0, 500)}]`,
            });
          }
        }
      }
      apiMessages.push({ role: 'user', content: trimmed });

      const pending: PendingUpdates = {
        assistantId: assistantMessage.id,
        content: '',
        reasoning: '',
        tools: [],
        timer: null,
      };
      pendingRef.current = pending;
      const controller = new AbortController();
      const request: ActiveRequest = { key: Symbol('alia-chat-request'), controller };
      activeRequestRef.current = request;
      const linked = oxyServices.createLinkedClient({ baseURL: apiUrl });

      const applyEvent = (event: AliaChatStreamEvent): void => {
        switch (event.kind) {
          case 'content':
            pending.content += event.content;
            scheduleFlush(pending);
            return;
          case 'reasoning':
            pending.reasoning += event.content;
            scheduleFlush(pending);
            return;
          case 'tool_call': {
            const invocation: ToolInvocation = {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              state: 'call',
              args: event.args,
            };
            const index = pending.tools.findIndex((tool) => tool.toolCallId === event.toolCallId);
            if (index < 0) pending.tools = [...pending.tools, invocation];
            else pending.tools[index] = invocation;
            flushPendingUpdates(pending);
            return;
          }
          case 'tool_result': {
            const index = pending.tools.findIndex((tool) => tool.toolCallId === event.toolCallId);
            const result: ToolInvocation = {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              state: 'result',
              result: event.output,
              ...(index < 0 ? {} : { args: pending.tools[index]?.args }),
            };
            if (index < 0) pending.tools = [...pending.tools, result];
            else pending.tools[index] = result;
            flushPendingUpdates(pending);
            return;
          }
          case 'research_progress':
            updateAssistant(pending.assistantId, (last) => ({
              researchProgress: {
                ...event.progress,
                subQuestions:
                  event.progress.subQuestions ?? last.researchProgress?.subQuestions,
              },
            }));
            return;
          case 'plan_preview':
            updateAssistant(pending.assistantId, () => ({
              pendingPlan: {
                planId: event.planId,
                steps: event.steps,
                approved: false,
                rejected: false,
              },
            }));
            return;
          case 'agent_answer':
            pending.content += event.content;
            updateAssistant(pending.assistantId, () => ({ agentInfo: event.agent }));
            scheduleFlush(pending);
            return;
        }
      };

      try {
        const effectiveModel = await waitWithAbort(
          resolveModelId(apiUrl, model, undefined, PREFERRED_CHAT_MODEL_ID),
          controller.signal,
        );
        await streamAliaChat(
          linked.client,
          { url: requestUrl, model: effectiveModel, messages: apiMessages },
          controller.signal,
          applyEvent,
        );
      } catch (caught: unknown) {
        cancelPendingTimer(pending);
        flushPendingUpdates(pending);
        if (isAbort(caught, controller.signal)) {
          removeEmptyAssistant(pending.assistantId);
        } else if (mountedRef.current) {
          const message = caught instanceof Error ? caught.message : 'Something went wrong.';
          setError(message);
          updateAssistant(pending.assistantId, (last) =>
            getTextFromContent(last.content).trim().length === 0
              ? { content: "I'm having trouble connecting right now. Please try again." }
              : {},
          );
        }
      } finally {
        cancelPendingTimer(pending);
        flushPendingUpdates(pending);
        linked.dispose();
        if (pendingRef.current === pending) pendingRef.current = null;
        if (activeRequestRef.current?.key === request.key) {
          activeRequestRef.current = null;
          if (mountedRef.current) setIsStreaming(false);
        }
      }
    },
    [
      accessTokenProp,
      apiUrl,
      cancelPendingTimer,
      clientContext,
      flushPendingUpdates,
      model,
      oxyServices,
      requestUrl,
      removeEmptyAssistant,
      scheduleFlush,
      updateAssistant,
    ],
  );

  const clear = useCallback(() => {
    stop();
    messagesRef.current = [];
    setMessages([]);
    setError(null);
  }, [stop]);

  return { messages, setMessages, send, isStreaming, stop, clear, error };
}
