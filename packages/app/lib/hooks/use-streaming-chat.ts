import { useState, useCallback, useRef, useEffect } from 'react';
import { useAgentRowPreview } from './use-agent-row-preview';
import { fetch as expoFetch } from 'expo/fetch';
import * as Haptics from 'expo-haptics';
import { useOxy } from '@oxy.so/services';
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
import i18n from '@/lib/i18n';
import type { Conversation } from '@/lib/hooks/use-conversations';
import { buildOutboundMessages } from '@/lib/chat-message-history';
import { hasUsableStreamOutput, type StreamOutputEvidence } from '@/lib/chat/stream-outcome';
import { createSseFrameReader } from '@/lib/chat/sse-frame-reader';

import type { ToolInvocation } from '@/lib/types/messages';
import { readAliaMeta, type FailedTurn } from '@/components/chat/turn-failure';
import { errorMessage as getErrorMessage, errorStatus, errorCode, errorName } from '../errors/error-utils';
export type { ToolInvocation };
export type { FailedTurn };

/**
 * How a send ended.
 *
 *  - `sent`: the turn got an answer, or at least real output. It may STILL
 *    carry a `failedTurn` — a stream that produced output and then a
 *    synthetic tail keeps the output and shows the tail as an error.
 *  - `errored`: no answer, and the person's turn is KEPT in the thread with
 *    `failedTurn` attached, retry and all. The caller has nothing to restore.
 *  - `failed`: the turn was rolled back to what the list was before the send,
 *    so the caller hands the text back to the composer. Only the usage-limit
 *    errors end this way now: they open a dialog of their own, and a retry
 *    would be the wrong offer next to "upgrade" or "wait".
 *  - `aborted`: the person stopped it; partial output is theirs to keep.
 */
export type SendOutcome = 'sent' | 'errored' | 'failed' | 'aborted';

export interface SendOptions {
  /** `null` explicitly withholds MCP tools; omission preserves legacy callers. */
  mcpServerId?: string | null;
  /**
   * The skills chosen for THIS message, by name.
   *
   * Per turn rather than per session: the previous design set one skill id
   * globally when a skill's page was opened, applied it to every conversation,
   * and had nothing that could clear it. Omitted means the person chose none —
   * Alia can still load an installed skill on its own from the index in its
   * system prompt, which is what the format is for.
   */
  skillNames?: string[];
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


export function useStreamingChat(apiUrl: string, conversationId?: string, reasoningEffort?: EffortLevel | null, selectedModel?: string, agentId?: string | null) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const previewAgentRow = useAgentRowPreview();
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
  /**
   * The turn that got no answer, drawn in the thread with an error and a
   * retry — or `null`. See `components/chat/turn-failure.ts` for why a
   * failure is kept rather than rolled back, and what the server persisted
   * (nothing) that makes a plain re-send safe.
   */
  const [failedTurn, setFailedTurn] = useState<FailedTurn | null>(null);
  /** What a retry re-sends: the same content and attachments, the same options. */
  const retryRef = useRef<{ message: Omit<Message, 'id'>; options?: SendOptions; userMessageId: string } | null>(null);
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

  /**
   * A different conversation is a different thread: a failure from the last
   * one must not be drawn under a message in this one.
   */
  useEffect(() => {
    setFailedTurn(null);
    retryRef.current = null;
  }, [conversationId]);

  const append = useCallback(async (
    message: Omit<Message, 'id'>,
    options?: SendOptions,
  ): Promise<SendOutcome> => {
    setIsLoading(true);
    setError(null);
    // A new send answers the old failure, whether it is the retry or a fresh
    // message: either way the card comes down.
    setFailedTurn(null);
    retryRef.current = null;

    // Everything the send is about to change, so a turn that produces no real
    // output can be undone in one step: the user message, the assistant
    // placeholder, and any history editMessage truncated just before this call.
    const snapshot = messagesRef.current;

    // Only content the model actually produced counts. The server answers a
    // dead provider, a mid-stream break or a global timeout with HTTP 200 and a
    // stand-in message flagged `alia_meta.synthetic` — that is a failed send
    // wearing a reply's clothes.
    const outputEvidence: StreamOutputEvidence = {
      realOutputChars: 0,
      agentOutputChars: 0,
      durableArtifactCount: 0,
      toolInvocationCount: 0,
    };

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
    const settleError = (): SendOutcome => {
      if (!hasUsableStreamOutput(outputEvidence)) return rollback();
      settleAssistant('failed');
      return 'sent';
    };

    /**
     * The server's stand-in for an answer it could not get, if one arrived.
     *
     * Its content is NEVER appended: "all models are busy" rendered under
     * Alia's mark is Alia declining, and it is the one thing this must not
     * read as. The flag is remembered here and answered when the stream ends.
     */
    let syntheticTail: { retryable: boolean } | null = null;

    /**
     * Keep the person's turn, and hang the failure on it.
     *
     * With no real output the empty assistant placeholder comes out — an
     * empty bubble under a thinking indicator would say an answer is still
     * coming — and the user message stays where it was sent, with the error
     * drawn under it. With real output, everything stays and the error is
     * drawn under the answer as its tail. Either way what a retry needs is
     * parked in `retryRef`, and the whole thing is one state update.
     */
    const keepFailedTurn = (retryable: boolean, detail?: string): SendOutcome => {
      const partial = hasUsableStreamOutput(outputEvidence);
      pendingContentRef.current = '';
      pendingReasoningRef.current = '';
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      if (partial) {
        settleAssistant('failed');
      } else {
        // The updater form, on purpose: the user row and the placeholder went
        // in through plain `setMessages` calls that may not have rendered yet
        // when a very fast failure lands, so `messagesRef` can still hold the
        // pre-send snapshot here. `prev` is always the queue's own truth.
        setMessagesAndRef((prev) => prev.filter((m) => m.id !== assistantMessage.id));
      }
      retryRef.current = { message, options, userMessageId: userMessage.id };
      setFailedTurn({
        userMessageId: userMessage.id,
        anchorMessageId: partial ? assistantMessage.id : userMessage.id,
        retryable,
        partial,
        detail,
      });
      return partial ? 'sent' : 'errored';
    };

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
    // The sidebar's row for this agent, immediately — this is the half that
    // makes sending feel like a chat list rather than a form.
    previewAgentRow(agentId, typeof message.content === 'string' ? message.content : '');

    // Create assistant message placeholder. `isStreaming` is the turn's own
    // lifecycle stamp: the thought panel reads "still running" from it rather
    // than from whether the message has text yet, and `settleAssistant` below
    // clears it however the stream ends.
    const assistantMessage: Message = {
      id: (Date.now() + 1).toString(),
      role: 'assistant',
      content: '',
      toolInvocations: [],
      createdAt: new Date().toISOString(),
      isStreaming: true,
    };
    setMessages((prev) => [...prev, assistantMessage]);

    /**
     * End the assistant message's turn, once.
     *
     * Only a message still marked streaming is touched: the error paths settle
     * it as `failed` before returning, and the `finally` that runs after them
     * must not re-settle it as completed or cancelled. Through the updater,
     * so it lands after every batched content flush queued before it.
     */
    const settleAssistant = (outcome: NonNullable<Message['turnOutcome']>): void => {
      setMessages((prev) => prev.map((m) =>
        m.id === assistantMessage.id && m.isStreaming === true
          ? { ...m, isStreaming: false, turnOutcome: outcome }
          : m,
      ));
    };

    /** The request's own controller: `finally` asks it whether the person stopped the turn. */
    let controller: AbortController | null = null;

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
      controller = new AbortController();
      abortControllerRef.current = controller;

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
          ...(options?.skillNames?.length ? { skillIds: options.skillNames } : {}),
          ...(agentId && { agentId }),
          ...(agentMode && { agentMode: true }),
          ...(deepResearchMode && { deepResearch: true }),
          ...(options?.mcpServerId === undefined
            ? {}
            : { mcpServerId: options.mcpServerId }),
        }),
        signal: controller.signal,
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
      /**
       * Frame reassembly lives in `lib/chat/sse-frame-reader.ts`.
       *
       * It used to be loose variables here, and that is how the bug happened:
       * `buffer` was declared outside the read loop and survived a chunk
       * boundary, but the current event name was declared INSIDE it and reset
       * on every `reader.read()`. A frame is `event: X\ndata: {…}\n\n`, so any
       * frame split between those two lines lost its name, fell through to the
       * OpenAI-shaped branch below, found no `choices[0]`, and was dropped in
       * silence — most often for the largest payloads, which are the ones that
       * do not fit in one read: `alia.title`, `alia.tool_result`,
       * `alia.plan_preview`, `alia.approval_request`, `alia.agent_session`.
       *
       * Two pieces of state that must both outlive a chunk are fields of one
       * object now, and its test feeds a stream split at every byte offset —
       * which is not something a test of this hook could do.
       */
      const sse = createSseFrameReader();
      let lastHapticAt = 0;

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          // Flush any remaining batched content before checking
          flushPendingUpdates();

          // The server answered with a stand-in, or with nothing usable at
          // all: the turn stays, with the error under it. (With real output
          // AND a synthetic tail, this keeps the output and marks the tail.)
          if (syntheticTail !== null) {
            return keepFailedTurn(syntheticTail.retryable);
          }
          if (!hasUsableStreamOutput(outputEvidence)) {
            setError(new Error('No response received from AI'));
            return keepFailedTurn(true);
          }
          break;
        }

        // `{ stream: true }`: a multi-byte character split across two reads
        // decodes to U+FFFD without it.
        const chunk = decoder.decode(value, { stream: true });

        for (const frame of sse.push(chunk)) {
          const data = frame.data;
          const currentEventType = frame.event;

          // Skip [DONE] marker
          if (data === '[DONE]') { continue; }

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
                      outputEvidence.durableArtifactCount += 1;
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
                      outputEvidence.durableArtifactCount += 1;
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
                  continue;
                }
                case 'alia.agent': {
                  const am = parsed;
                  if (typeof am.content === 'string') {
                    outputEvidence.agentOutputChars += am.content.length;
                  }
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
                          isComplete: parsed.phase === 'complete',
                          // The final event carries the sources; every earlier
                          // one carries none, and a progress event after the
                          // final one must not erase them.
                          sources: parsed.sources ?? lastMessage.researchProgress?.sources,
                          totalSearches: parsed.totalSearches ?? lastMessage.researchProgress?.totalSearches,
                        },
                      };
                    }
                    return updated;
                  });
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
                  continue;
                }
                case 'alia.model_switch': {
                  if (parsed.model) {
                    useModelStore.getState().setSelectedModel(parsed.model);
                  }
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
                  continue;
                }
                case 'alia.agent_turn': {
                  if (parsed.turnId) {
                    const { useUIStore } = await import('@/lib/stores/ui-store');
                    useUIStore.getState().openAgentPanel(String(parsed.turnId), String(parsed.agentId ?? agentId ?? ''));
                  }
                  continue;
                }
                default:
                  // Unknown named event — skip
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

              // Generic SSE error — stop, and report it IN the thread: the
              // turn stays with the error under it, so nothing needs a toast.
              const msg = getErrorMessage(err) || 'Something went wrong. Please try again.';
              setError(new Error(msg));
              setIsLoading(false);
              if (abortControllerRef.current) {
                abortControllerRef.current.abort();
                abortControllerRef.current = null;
              }
              reader.cancel();
              return keepFailedTurn(err.retryable !== false, getErrorMessage(err) || undefined);
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
              const meta = readAliaMeta(parsed);
              if (meta.synthetic) {
                // Remembered, never rendered — see `syntheticTail`. The
                // server sends a stop chunk and [DONE] right after, and the
                // `done` branch turns this into the error under the turn.
                syntheticTail = { retryable: meta.retryable };
              } else {
                outputEvidence.realOutputChars += delta.content.length;

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
              for (const tc of delta.tool_calls) {
                const toolCallId = tc.id;
                const toolName = tc.function?.name;
                if (!toolCallId || !toolName) continue;
                outputEvidence.toolInvocationCount += 1;

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
                  outputEvidence.durableArtifactCount += 1;
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
                  outputEvidence.durableArtifactCount += 1;
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
              if (typeof am.content === 'string') {
                outputEvidence.agentOutputChars += am.content.length;
              }
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
              return keepFailedTurn(true, errMsg);
            }
          } catch (frameError: unknown) {
            /**
             * Malformed SSE fragments are expected mid-stream; the next
             * complete event supersedes them.
             *
             * A `UsageLimitError` is NOT one of those. It is thrown
             * deliberately from the `parsed.error` branch above so the outer
             * handler can show the upgrade dialog — and it was thrown from
             * inside this same `try`, so this `catch` ate it. An in-stream
             * `INSUFFICIENT_CREDITS`, `MODEL_NOT_IN_PLAN` or
             * `rate_limit_error` therefore did nothing at all: the loop kept
             * reading, the stream ended, and the user saw a reply that
             * simply stopped with no error and no way to act on it. (The
             * generic-error branch beside it escaped only because it uses
             * `return` rather than `throw`.)
             */
            // `instanceof` AND the name, matching the outer handler: Hermes
            // can break `instanceof` for Error subclasses, and a rethrow that
            // misses is the same silent swallow this fixes.
            if (frameError instanceof UsageLimitError || errorName(frameError) === 'UsageLimitError') {
              throw frameError;
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

      // Everything else — the network, a 5xx, a 401 — keeps the turn in the
      // thread with the error under it and a retry beside it. The message is
      // shown as the card's detail line, not as an answer.
      const finalError = e instanceof Error
        ? e
        : new Error(typeof e === 'string' ? e : (getErrorMessage(e) || 'An unexpected error occurred'));
      setError(finalError);
      return keepFailedTurn(true, finalError.message);
    } finally {
      // Flush any remaining batched content
      flushPendingUpdates();
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      abortControllerRef.current = null;
      // A turn that is still streaming here ended without an error path
      // settling it: on its own, or because `stop()` aborted the controller.
      // (The error paths abort it too, but they have settled it first.)
      settleAssistant(controller?.signal.aborted === true ? 'cancelled' : 'completed');
      setIsLoading(false);
      /*
       * The answer replaces your own line in the sidebar — after the flush, so
       * the last batched fragment is part of what it reads, and once per turn
       * rather than once per token.
       */
      const settled = messagesRef.current;
      const reply = settled[settled.length - 1];
      if (reply?.role === 'assistant' && typeof reply.content === 'string') {
        previewAgentRow(agentId, reply.content);
      }
    }
  }, [apiUrl, oxyServices, queryClient, conversationId, reasoningEffort, selectedModel, agentId, scheduleFlush, flushPendingUpdates, setMessagesAndRef, previewAgentRow]);

  const stop = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsLoading(false);
  }, []);

  const clearError = useCallback(() => setError(null), []);

  /**
   * Send the failed turn again: the same content and attachments, the same
   * options, through the same `append`.
   *
   * The thread is cut back to just before the failed user message first —
   * the same truncation an edit does — so the re-sent turn lands where the
   * failed one was rather than after it, and the history the server receives
   * holds the message once. It was never persisted (see `turn-failure.ts`),
   * so there is no second row to avoid on that side either. Cut from
   * `messagesRef` directly and set as an array, not through an updater, so
   * `append`'s snapshot sees the cut regardless of when React runs it.
   */
  const retryFailedTurn = useCallback(async (): Promise<SendOutcome> => {
    const retry = retryRef.current;
    if (retry === null) return 'failed';
    const current = messagesRef.current;
    const idx = current.findIndex((m) => m.id === retry.userMessageId);
    if (idx >= 0) setMessagesAndRef(current.slice(0, idx));
    return append(retry.message, retry.options);
  }, [append, setMessagesAndRef]);

  /** Take the error down without retrying — the thread was cleared, or the person moved on. */
  const clearFailedTurn = useCallback(() => {
    setFailedTurn(null);
    retryRef.current = null;
  }, []);

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
    failedTurn,
    retryFailedTurn,
    clearFailedTurn,
  };
}
