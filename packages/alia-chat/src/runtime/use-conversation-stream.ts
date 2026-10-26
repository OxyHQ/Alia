import { ASK_USER_QUESTION_TOOL } from '../tools';
import { useOxy } from '@oxy.so/services/ui/client';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLabels } from '../lib/labels';
import { useAppAssertionHeaders } from './app-assertion';
import { type AliaArtifact, useAliaRuntime } from './config';
import {
  errorCode,
  errorMessage as getErrorMessage,
  errorName,
  errorStatus,
  readErrorResponseBody,
} from './error-utils';
import { agentMessageId, buildOutboundMessages, isAgentMessageOf } from './message-history';
import { aliaQueryKeys } from './query-keys';
import { createRandomUuid } from './random-uuid';
import { createChatTurnControl } from './chat-turn-control';
import { awaitTurnPreparation } from './turn-preparation';
import { type AliaHostTools, HostOutcomeQueue, hostRequest } from './host-tools';
import { API_ROUTES } from './routes';
import { createSseFrameReader } from './sse-frame-reader';
import {
  type ConsultEvent,
  lockedFeatureOf,
  parseConsultEvent,
  parseHostAction,
} from './stream-events';
import { hasUsableStreamOutput, type StreamOutputEvidence } from './stream-outcome';
import { failureDetail, readAliaMeta, type FailedTurn } from './turn-failure';
import type {
  AgentRun,
  Conversation,
  ConversationsInfiniteData,
  Message,
  SendOptions,
  ToolInvocation,
} from './types';
import { UsageLimitError } from './usage-limit-error';

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

/** Shape of an error body thrown by the streaming fetch (rate-limit / credit info). */
interface ThrownErrorBody {
  code?: string;
  message?: string;
  retryable?: boolean;
  retryAfter?: number;
  /** Alia's run id, on a turn that failed after the stream began. */
  reference?: string;
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
  /** Alia's run id, on a turn that failed (before any output or part-way). */
  reference?: string;
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

/**
 * The artifact a tool result carries, if it carries one: a generated file, or
 * an `artifact` object a tool returned for its own panel.
 */
export function artifactOf(
  toolCallId: string,
  name: string | undefined,
  output: unknown,
): AliaArtifact | null {
  if (output === null || typeof output !== 'object') return null;
  // Structural per-tool output, read the way the tools write it.
  const result = output as Record<string, any>;
  if (name === 'generateFile') {
    const type = result.language ? 'code' : 'markdown';
    return {
      id: toolCallId,
      type,
      content:
        type === 'code'
          ? { language: result.language, code: result.content }
          : { content: result.content },
      title: result.filename || result.title || 'Generated file',
      timestamp: Date.now(),
    };
  }
  if (result.artifact) {
    const a = result.artifact;
    return {
      id: toolCallId,
      type: a.type || 'markdown',
      content: a.data || a.content || a,
      title: a.title || name || 'Artifact',
      timestamp: Date.now(),
    };
  }
  return null;
}

export interface UseConversationStreamOptions {
  /** The conversation the turns belong to; omitted, the server makes the turn's own. */
  conversationId?: string;
  /** The power level (or a device model) every turn is sent with. */
  model?: string;
  /** The agent this conversation is with — its lead — when it is not Alia. */
  agentId?: string | null;
  /**
   * The UI effects the host's client performs (`docs/agent-embedding.md` §2): declared with every
   * request, performed once when the stream asks, and their outcomes sent with the next request.
   */
  hostTools?: AliaHostTools;
  /**
   * What the host app is, for Alia to know where the person is ("Notes — viewing note #42").
   * Sent as the request's leading system message, which the server reads as client context.
   */
  clientContext?: string;
}

/** The words a message holds, as text: a consulted agent's reply is plain text as it streams. */
function messageWords(message: Message): string {
  return typeof message.content === 'string' ? message.content : '';
}

export function useConversationStream({
  conversationId,
  model,
  agentId,
  clientContext,
  hostTools,
}: UseConversationStreamOptions = {}) {
  const { apiUrl, streamFetch, host, app } = useAliaRuntime();
  /** Read at send time and when an action arrives: the host's declaration may change between turns. */
  const hostToolsRef = useRef(hostTools);
  hostToolsRef.current = hostTools;
  const appRef = useRef(app);
  appRef.current = app;
  /** This conversation's host actions: performed once, their outcomes held until a request carries them. */
  const hostOutcomesRef = useRef(new HostOutcomeQueue());
  const labels = useLabels();
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
  /** The run a delegated agent started for this conversation (`alia.agent_turn`), or `null`. */
  const [agentRun, setAgentRun] = useState<AgentRun | null>(null);
  /**
   * The turn that got no answer, drawn in the thread with an error and a
   * retry — or `null`. See `turn-failure.ts` for why a
   * failure is kept rather than rolled back, and what the server persisted
   * (nothing) that makes a plain re-send safe.
   */
  const [failedTurn, setFailedTurn] = useState<FailedTurn | null>(null);
  /** What a retry re-sends: the same content and attachments, the same options. */
  const retryRef = useRef<{
    message: Omit<Message, 'id'>;
    options?: SendOptions;
    userMessageId: string;
  } | null>(null);
  /**
   * The connector and skills each user turn was sent with, by its id, so an
   * edit or a regenerate sends it the way it was sent (#608 §6). A message
   * does not carry them and the server does not return them, so this is only
   * known for turns sent while this screen was open.
   */
  const turnOptionsRef = useRef(new Map<string, Pick<SendOptions, 'mcpServerId' | 'skillNames'>>());
  const { oxyServices, user } = useOxy();
  const appAssertionHeaders = useAppAssertionHeaders();
  const queryClient = useQueryClient();
  const abortControllerRef = useRef<AbortController | null>(null);
  const turnControlRef = useRef<ReturnType<typeof createChatTurnControl> | null>(null);

  // Batching refs: accumulate streaming text and flush at ~20fps instead of per-chunk
  const pendingContentRef = useRef('');
  const pendingReasoningRef = useRef('');
  /** A consulted agent's streamed words, by the id of the message they belong to. */
  const pendingAgentContentRef = useRef(new Map<string, string>());
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushPendingUpdates = useCallback(() => {
    const content = pendingContentRef.current;
    const reasoning = pendingReasoningRef.current;
    const agentContent = pendingAgentContentRef.current;
    if (!content && !reasoning && agentContent.size === 0) return;

    pendingContentRef.current = '';
    pendingReasoningRef.current = '';
    pendingAgentContentRef.current = new Map();

    setMessages((prev) => {
      const updated = prev.map((message) => {
        const words = agentContent.get(message.id);
        return words === undefined
          ? message
          : { ...message, content: messageWords(message) + words };
      });
      const lastMessage = updated[updated.length - 1];
      if (lastMessage?.role === 'assistant' && (content || reasoning)) {
        const changes: Partial<Message> = {};
        if (content) changes.content = lastMessage.content + content;
        if (reasoning) changes.thinking = (lastMessage.thinking || '') + reasoning;
        updated[updated.length - 1] = { ...lastMessage, ...changes };
      }
      return updated;
    });
  }, []);

  /** Drop everything still batched: the turn it belonged to is being undone. */
  const dropPendingUpdates = useCallback(() => {
    pendingContentRef.current = '';
    pendingReasoningRef.current = '';
    pendingAgentContentRef.current = new Map();
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
  }, []);

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current) return;
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null;
      flushPendingUpdates();
    }, 50);
  }, [flushPendingUpdates]);

  /** Whether this thread is on screen: a turn that outlives it ends without `onTurnEnd`. */
  const mountedRef = useRef(false);

  // Mounted, a turn that ends is announced (`onTurnEnd`); unmounting flushes and clears the timer.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
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
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Wrapper that eagerly syncs messagesRef before React re-renders,
  // so append() called in the same tick reads truncated history (e.g. editMessage).
  const setMessagesAndRef = useCallback((update: Message[] | ((prev: Message[]) => Message[])) => {
    if (typeof update === 'function') {
      setMessages((prev) => {
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
  const conversationRef = useRef(conversationId);
  useEffect(() => {
    setFailedTurn(null);
    retryRef.current = null;
    turnOptionsRef.current.clear();
    // Outcomes answer this conversation's calls. The first turn of a new chat gives it its id,
    // which is the same conversation; any other change is a different one.
    const was = conversationRef.current;
    conversationRef.current = conversationId;
    if (was !== undefined && was !== conversationId) {
      hostOutcomesRef.current.clear();
      // The reply still streaming belongs to the thread that was left: cut it, drop what it had
      // batched (it would land on this thread's last message) and let the screen be idle.
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      dropPendingUpdates();
      setIsLoading(false);
    }
  }, [conversationId, dropPendingUpdates]);

  /**
   * A different account is a different person: the thread on screen is not
   * theirs.
   *
   * The new-chat screen stays mounted across a sign-out or a switch, and in
   * ghost mode its thread exists nowhere but here — so without this the next
   * person to sit down saw the previous one's conversation, and a reply still
   * streaming kept writing into it. The stream is cut and the thread emptied.
   * Signing IN from signed-out keeps what is there: nobody else owned it.
   */
  const accountId = user?.id ?? null;
  const accountRef = useRef(accountId);
  useEffect(() => {
    const was = accountRef.current;
    accountRef.current = accountId;
    if (was === null || was === accountId) return;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    dropPendingUpdates();
    hostOutcomesRef.current.clear();
    setMessagesAndRef([]);
    setIsLoading(false);
    setError(null);
    setConversationTitle(null);
    setSuggestedNewConversation(null);
    setAgentRun(null);
    setFailedTurn(null);
    retryRef.current = null;
    turnOptionsRef.current.clear();
  }, [accountId, setMessagesAndRef, dropPendingUpdates]);

  const append = useCallback(
    async (message: Omit<Message, 'id'>, options?: SendOptions): Promise<SendOutcome> => {
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
        dropPendingUpdates();
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
      let syntheticTail: { retryable: boolean; detail?: string } | null = null;
      /** The reply's text as the model produced it: what the host previews when the turn settles. */
      let replyText = '';

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
        if (partial) {
          // The output is kept, so what is still batched is part of it: an
          // in-stream error frame can land inside one flush window, and dropping
          // the buffer drew the "interrupted" card under an empty bubble.
          flushPendingUpdates();
        } else {
          dropPendingUpdates();
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
      const userMessage: Message = {
        ...message,
        id: createRandomUuid(),
        createdAt: new Date().toISOString(),
        unsaved: true,
      };
      if (options !== undefined) {
        turnOptionsRef.current.set(userMessage.id, {
          mcpServerId: options.mcpServerId,
          skillNames: options.skillNames,
        });
      }
      // Build from the pre-send snapshot before any await. The optimistic user
      // row and assistant placeholder may reach messagesRef while device info is
      // collected; reading the ref afterwards used to send both plus userMessage
      // again, persisting user -> empty assistant -> duplicate user.
      const history = buildOutboundMessages(snapshot, userMessage);
      const messagesToSend = clientContext
        ? [{ id: 'client-context', role: 'system', content: clientContext }, ...history]
        : history;
      setMessages((prev) => [...prev, userMessage]);
      // The sidebar's row for this agent, immediately — this is the half that
      // makes sending feel like a chat list rather than a form.
      host.onTurnPreview?.(agentId, typeof message.content === 'string' ? message.content : '');

      // Create assistant message placeholder. `isStreaming` is the turn's own
      // lifecycle stamp: the thought panel reads "still running" from it rather
      // than from whether the message has text yet, and `settleAssistant` below
      // clears it however the stream ends.
      const assistantMessage: Message = {
        id: createRandomUuid(),
        role: 'assistant',
        content: '',
        toolInvocations: [],
        createdAt: new Date().toISOString(),
        isStreaming: true,
        unsaved: true,
      };
      setMessages((prev) => [...prev, assistantMessage]);
      /** How many agents the lead has consulted in this turn: the next one's `agentMessageId` index. */
      let agentAnswers = 0;
      const nextAgentMessageId = (): string => agentMessageId(assistantMessage.id, agentAnswers++);
      /** Each consultation of this turn, by `consultId`: the message its agent writes into. */
      const consults = new Map<string, string>();
      /** Whether `id` names a message this turn wrote: the question, the reply, an agent's answer. */
      const isThisTurn = (id: string): boolean =>
        id === userMessage.id ||
        id === assistantMessage.id ||
        isAgentMessageOf(id, assistantMessage.id);

      /**
       * End the assistant message's turn, once.
       *
       * Only a message still marked streaming is touched: the error paths settle
       * it as `failed` before returning, and the `finally` that runs after them
       * must not re-settle it as completed or cancelled. Through the updater,
       * so it lands after every batched content flush queued before it.
       */
      const settleAssistant = (outcome: NonNullable<Message['turnOutcome']>): void => {
        setMessages((prev) => {
          if (prev.find((m) => m.id === assistantMessage.id)?.isStreaming !== true) return prev;
          // A turn that completed is one the server has stored, under these ids.
          const stored = outcome === 'completed';
          return prev.map((m) => {
            // A consultation still open when the turn ends ends with it.
            const settles =
              m.id === assistantMessage.id ||
              (m.isStreaming === true && isAgentMessageOf(m.id, assistantMessage.id));
            let next = settles ? { ...m, isStreaming: false, turnOutcome: outcome } : m;
            if (stored && next.unsaved === true && isThisTurn(next.id)) {
              const { unsaved: _unsaved, ...rest } = next;
              next = rest;
            }
            return next;
          });
        });
      };

      /** What a consult frame does to the thread: the agent's own message, from start to end. */
      const applyConsult = (event: ConsultEvent): void => {
        if (event.type === 'start') {
          if (consults.has(event.consultId)) return;
          const id = nextAgentMessageId();
          consults.set(event.consultId, id);
          const agentMessage: Message = {
            id,
            unsaved: true,
            role: 'assistant',
            content: '',
            toolInvocations: [],
            createdAt: new Date().toISOString(),
            isStreaming: true,
            agentInfo: { ...event.agent },
          };
          // Above the lead's own reply, which is still being written under it.
          setMessages((prev) => {
            const at = prev.findIndex((m) => m.id === assistantMessage.id);
            return at < 0
              ? [...prev, agentMessage]
              : [...prev.slice(0, at), agentMessage, ...prev.slice(at)];
          });
          return;
        }
        const id = consults.get(event.consultId);
        if (id === undefined) return;
        if (event.type === 'delta') {
          if (event.content === '') return;
          outputEvidence.agentOutputChars += event.content.length;
          const map = pendingAgentContentRef.current;
          map.set(id, (map.get(id) ?? '') + event.content);
          scheduleFlush();
          return;
        }
        if (event.type === 'tool') {
          if (event.phase === 'call') outputEvidence.toolInvocationCount += 1;
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id !== id) return m;
              const invocations = [...(m.toolInvocations ?? [])];
              const at = invocations.findIndex((call) => call.toolCallId === event.toolCallId);
              const previous = at < 0 ? undefined : invocations[at];
              const invocation: ToolInvocation = {
                toolCallId: event.toolCallId,
                toolName: event.name,
                state: event.phase,
                args: event.input ?? previous?.args,
                ...(event.phase === 'result' ? { result: event.output } : {}),
              };
              if (at < 0) invocations.push(invocation);
              else invocations[at] = invocation;
              return { ...m, toolInvocations: invocations };
            }),
          );
          return;
        }
        // The end: what was streamed lands first, then the agent's final words, if it sent them.
        flushPendingUpdates();
        if (event.content !== undefined) outputEvidence.agentOutputChars += event.content.length;
        setMessages((prev) =>
          prev.map((m) =>
            m.id !== id
              ? m
              : {
                  ...m,
                  ...(event.content === undefined ? {} : { content: event.content }),
                  isStreaming: false,
                  turnOutcome: event.status === 'completed' ? 'completed' : 'failed',
                },
          ),
        );
      };

      /** The request's own controller: `finally` asks it whether the person stopped the turn. */
      let controller: AbortController | null = null;
      let linked: ReturnType<typeof oxyServices.createLinkedClient> | null = null;
      let turnControl: ReturnType<typeof createChatTurnControl> | null = null;
      /** Cut THIS turn's stream. Never the ref's: by now it may hold a later turn's controller. */
      const abortThisTurn = (): void => {
        controller?.abort();
        if (abortControllerRef.current === controller) abortControllerRef.current = null;
      };

      try {
        // Create the abort controller before the first await, so `stop()` and an account or
        // conversation change reach a turn that is still collecting device info.
        controller = new AbortController();
        abortControllerRef.current = controller;
        linked = oxyServices.createLinkedClient({ baseURL: apiUrl });
        const assertion = appAssertionHeaders();
        turnControl = createChatTurnControl(linked, assertion, conversationId, controller);
        turnControlRef.current = turnControl;

        // Attach both rejection handlers immediately; a slow host must not leave
        // an already rejected surface assertion unobserved or defeat detachment.
        const [appAssertion, deviceInfo] = await awaitTurnPreparation(
          Promise.all([assertion, host.deviceInfo ? host.deviceInfo() : undefined]),
          controller.signal,
        );
        if (controller.signal.aborted) return 'aborted';

        /**
         * Read at send time rather than closed over: the capability switches
         * live in a menu that stays open across a send, and a value captured
         * when the callback was built would send the state the composer had
         * before the person touched it.
         */
        const { deepResearch: deepResearchMode, webSearch } = host.turnRequest?.() ?? {};

        // The host's tools, and the outcomes of the actions it performed since the last request.
        const outcomes = hostOutcomesRef.current.pending();
        const hostMember = hostRequest(appRef.current, hostToolsRef.current, outcomes);

        // Authentication, the preflight refresh and the single 401 replay belong
        // to the linked Oxy client; this layer never reads or writes a bearer.
        // Which Oxy app this turn is in (ADR 0021): an agent Oxy confines to an app opens only there.
        if (controller.signal.aborted) return 'aborted';
        const response = await linked.client.requestAuthenticatedResponse({
          method: 'POST',
          url: API_ROUTES.chat,
          headers: {
            ...appAssertion,
            Accept: 'text/event-stream',
            'Content-Type': 'application/json',
            ...(deviceInfo === undefined ? {} : { 'X-Device-Info': JSON.stringify(deviceInfo) }),
          },
          body: JSON.stringify({
            turnId: turnControl.id,
            messages: messagesToSend,
            // The reply is stored under the id it is drawn under here, so a vote
            // or a read-aloud on it needs no reload to find it.
            assistantMessageId: assistantMessage.id,
            stream: true,
            ...(conversationId && { conversationId }),
            // Only sent when OFF. `true` is the server's default and every
            // request has behaved that way, so sending it would be noise.
            ...(webSearch === false && { webSearch: false }),
            // The power level (or a device model). Oxy picks the model of that
            // level; the client never names a hosted model.
            ...(model && { model }),
            ...(options?.skillNames?.length ? { skillIds: options.skillNames } : {}),
            ...(agentId && { agentId }),
            ...(deepResearchMode && { deepResearch: true }),
            ...(options?.mcpServerId === undefined ? {} : { mcpServerId: options.mcpServerId }),
            ...(hostMember === undefined ? {} : { host: hostMember }),
          }),
          signal: controller.signal,
          ...(streamFetch ? { fetch: streamFetch } : {}),
        });

        if (!response.ok) {
          const errorData = (await readErrorResponseBody(response)) as StreamErrorResponse | null;

          // An agent's feature gate refused the turn: the host shows its own upsell, and the
          // person's words go back to the composer for after.
          const lockedFeature = lockedFeatureOf(
            errorData?.error && typeof errorData.error === 'object' ? errorData.error : null,
          );
          if (errorCode(errorData?.error) === 'turn_cancelled') {
            flushPendingUpdates();
            settleAssistant('cancelled');
            abortThisTurn();
            return 'aborted';
          }
          if (lockedFeature !== null) {
            host.onFeatureLocked?.(lockedFeature);
            return rollback();
          }

          // Detect usage limit errors (429 rate limit, 402 insufficient credits, 403 model access)
          if (response.status === 429 || response.status === 402 || response.status === 403) {
            const errObj =
              errorData?.error && typeof errorData.error === 'object' ? errorData.error : null;
            const isModelAccess = response.status === 403 && errObj?.code === 'MODEL_NOT_IN_PLAN';
            const isCredits = response.status === 402 || errObj?.code === 'INSUFFICIENT_CREDITS';

            if (isModelAccess || isCredits || response.status === 429) {
              throw new UsageLimitError({
                type: isModelAccess ? 'model_access' : isCredits ? 'credits' : 'rate_limit',
                code:
                  errObj?.code ||
                  (isModelAccess
                    ? 'MODEL_NOT_IN_PLAN'
                    : isCredits
                      ? 'INSUFFICIENT_CREDITS'
                      : 'RATE_LIMIT_EXCEEDED'),
                message:
                  errObj?.message ||
                  (isModelAccess
                    ? 'Upgrade your plan to use this model.'
                    : isCredits
                      ? "You've run out of credits."
                      : "You've sent too many messages."),
                retryable: errObj?.retryable ?? (!isCredits && !isModelAccess),
                retryAfterSeconds: errObj?.retryAfter,
                suggestedAction:
                  errObj?.suggestedAction || (isCredits || isModelAccess ? 'upgrade' : 'wait'),
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
            throw new Error(labels.signInRequired);
          }

          // A turn that failed before any output, answered before the stream
          // opened (Alia's 503/500 with `code`, `retryable` and `reference`):
          // the same failed-turn card as the in-stream error frame — the app's
          // own line, with code and reference — never the server's English.
          const failed =
            errorData?.error && typeof errorData.error === 'object' ? errorData.error : null;
          if (
            failed &&
            (typeof failed.reference === 'string' ||
              (response.status >= 500 && typeof failed.code === 'string'))
          ) {
            setError(new Error(getErrorMessage(failed) || `Server error (${response.status})`));
            setIsLoading(false);
            return keepFailedTurn(
              failed.retryable !== false,
              failureDetail({
                code: typeof failed.code === 'string' ? failed.code : undefined,
                reference: typeof failed.reference === 'string' ? failed.reference : undefined,
              }),
            );
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
        // The server has the outcomes this request carried: they are its calls' results now.
        hostOutcomesRef.current.delivered(outcomes);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        /**
         * Frame reassembly lives in `sse-frame-reader.ts`.
         *
         * It used to be loose variables here, and that is how the bug happened:
         * `buffer` was declared outside the read loop and survived a chunk
         * boundary, but the current event name was declared INSIDE it and reset
         * on every `reader.read()`. A frame is `event: X\ndata: {…}\n\n`, so any
         * frame split between those two lines lost its name, fell through to the
         * OpenAI-shaped branch below, found no `choices[0]`, and was dropped in
         * silence — most often for the largest payloads, which are the ones that
         * do not fit in one read: `alia.title`, `alia.tool_result`,
         * `alia.plan_preview`, `alia.agent_start`, `alia.host_action`.
         *
         * Two pieces of state that must both outlive a chunk are fields of one
         * object now, and its test feeds a stream split at every byte offset —
         * which is not something a test of this hook could do.
         */
        const sse = createSseFrameReader();
        let lastOutputAt = 0;
        /** The server closed the turn: `[DONE]`, or a chunk that carries a finish reason. */
        let sawTerminal = false;

        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            // Flush any remaining batched content before checking
            flushPendingUpdates();

            // The server answered with a stand-in, or with nothing usable at
            // all: the turn stays, with the error under it. (With real output
            // AND a synthetic tail, this keeps the output and marks the tail.)
            if (syntheticTail !== null) {
              return keepFailedTurn(syntheticTail.retryable, syntheticTail.detail);
            }
            if (!hasUsableStreamOutput(outputEvidence)) {
              setError(new Error('No response received from AI'));
              return keepFailedTurn(true);
            }
            // The connection closed before the server said the turn was over:
            // what is on screen is a cut-off answer, not a finished one. Kept
            // as an interrupted tail with Retry, never settled as complete.
            if (!sawTerminal) {
              setError(new Error('The response ended before it was complete'));
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
            if (data === '[DONE]') {
              sawTerminal = true;
              continue;
            }

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
                            invocations[idx] = {
                              ...invocations[idx],
                              state: 'result',
                              result: output,
                            };
                          } else {
                            invocations.push({
                              toolCallId: tool_call_id,
                              toolName: name || 'unknown',
                              state: 'result',
                              result: output,
                            });
                          }
                          updated[updated.length - 1] = {
                            ...lastMessage,
                            toolInvocations: invocations,
                          };
                        }
                        return updated;
                      });
                      // The host hears of every finished tool (the memory document
                      // may have been rewritten) and of the artifact it produced.
                      host.onToolResult?.({ toolCallId: tool_call_id, name, output });
                      const artifact = artifactOf(tool_call_id, name, output);
                      if (artifact) {
                        outputEvidence.durableArtifactCount += 1;
                        host.onArtifact?.(artifact);
                      }
                    }
                    continue;
                  }
                  case 'alia.agent_start':
                  case 'alia.agent_delta':
                  case 'alia.agent_tool':
                  case 'alia.agent_end': {
                    const consult = parseConsultEvent(currentEventType, parsed);
                    if (consult !== null) applyConsult(consult);
                    continue;
                  }
                  case 'alia.host_action': {
                    // Performed here, by the client that declared it, once; its outcome rides
                    // the next request. The stream does not wait for it.
                    const action = parseHostAction(parsed);
                    if (action !== null) {
                      void hostOutcomesRef.current.dispatch(
                        action,
                        hostToolsRef.current,
                        appRef.current,
                      );
                    }
                    continue;
                  }
                  case 'alia.title': {
                    if (parsed.title && parsed.conversationId) {
                      queryClient.setQueryData(
                        aliaQueryKeys.conversations.detail(parsed.conversationId),
                        (old: Conversation | undefined) =>
                          old ? { ...old, title: parsed.title } : old,
                      );
                      queryClient.setQueriesData(
                        { queryKey: aliaQueryKeys.conversations.all },
                        (old: ConversationsInfiniteData | undefined) => {
                          if (!old?.pages) return old;
                          return {
                            ...old,
                            pages: old.pages.map((page) => ({
                              ...page,
                              conversations: page.conversations.map((c) =>
                                c.id === parsed.conversationId ? { ...c, title: parsed.title } : c,
                              ),
                            })),
                          };
                        },
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
                            subQuestions:
                              parsed.subQuestions || lastMessage.researchProgress?.subQuestions,
                            sourcesFound: parsed.sourcesFound,
                            currentQuery: parsed.currentQuery,
                            iteration: parsed.iteration,
                            isComplete: parsed.phase === 'complete',
                            // The final event carries the sources; every earlier
                            // one carries none, and a progress event after the
                            // final one must not erase them.
                            sources: parsed.sources ?? lastMessage.researchProgress?.sources,
                            totalSearches:
                              parsed.totalSearches ?? lastMessage.researchProgress?.totalSearches,
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
                          plan: {
                            planId: parsed.planId,
                            steps: parsed.steps || [],
                          },
                        };
                      }
                      return updated;
                    });
                    continue;
                  }
                  case 'alia.context': {
                    // What this turn put in the context window, for the usage card.
                    host.onContext?.(
                      typeof parsed.conversationId === 'string'
                        ? parsed.conversationId
                        : (conversationId ?? null),
                      parsed,
                    );
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
                      const run = {
                        turnId: String(parsed.turnId),
                        agentId: String(parsed.agentId ?? agentId ?? ''),
                      };
                      setAgentRun(run);
                      host.onAgentTurn?.({ ...run, conversationId: conversationId ?? null });
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
                if (errorCode(err) === 'turn_cancelled') {
                  flushPendingUpdates();
                  settleAssistant('cancelled');
                  abortThisTurn();
                  reader.cancel().catch(() => {});
                  return 'aborted';
                }
                // An agent's feature gate refused the turn before anything was spent: the host
                // shows its own upsell, and the person's words go back to the composer.
                const lockedFeature = lockedFeatureOf(err);
                if (lockedFeature !== null) {
                  setIsLoading(false);
                  abortThisTurn();
                  reader.cancel().catch(() => {});
                  host.onFeatureLocked?.(lockedFeature);
                  return settleError();
                }
                // Check for usage limit errors (rate limit, credits, model access)
                if (
                  errorCode(err) === 'MODEL_NOT_IN_PLAN' ||
                  errorCode(err) === 'INSUFFICIENT_CREDITS' ||
                  err.type === 'rate_limit_error'
                ) {
                  const isRateLimit = err.type === 'rate_limit_error';
                  throw new UsageLimitError({
                    type:
                      errorCode(err) === 'MODEL_NOT_IN_PLAN'
                        ? 'model_access'
                        : errorCode(err) === 'INSUFFICIENT_CREDITS'
                          ? 'credits'
                          : 'rate_limit',
                    code: String(errorCode(err) ?? ''),
                    message: getErrorMessage(err),
                    retryable: isRateLimit,
                    // A limit to wait out (the plan's usage window, the request
                    // rate) carries when to retry, which drives the dialog's
                    // countdown; running out of credits or a model's plan is an
                    // upgrade.
                    retryAfterSeconds:
                      isRateLimit && typeof err.retryAfter === 'number'
                        ? err.retryAfter
                        : undefined,
                    suggestedAction: isRateLimit ? 'wait' : 'upgrade',
                    limitType:
                      typeof err.details?.limitType === 'string'
                        ? err.details.limitType
                        : undefined,
                    current:
                      typeof err.details?.current === 'number' ? err.details.current : undefined,
                    limit: typeof err.details?.limit === 'number' ? err.details.limit : undefined,
                  });
                }

                // Generic SSE error — stop, and report it IN the thread: the
                // turn stays with the error under it, so nothing needs a toast.
                const msg = getErrorMessage(err) || 'Something went wrong. Please try again.';
                setError(new Error(msg));
                setIsLoading(false);
                abortThisTurn();
                reader.cancel().catch(() => {});
                // A turn that failed after it started carries a run reference:
                // its card says code and reference, never the server's English
                // prose. A refusal without one (a gate, a bad request) keeps its
                // message, which is the only thing that says what to change.
                const detail =
                  typeof err.reference === 'string'
                    ? failureDetail({
                        code: typeof err.code === 'string' ? err.code : undefined,
                        reference: err.reference,
                      })
                    : getErrorMessage(err) || undefined;
                return keepFailedTurn(err.retryable !== false, detail);
              }

              // Handle usage/credits info (comes at the end of stream).
              // New format: alia_usage (separate from OpenAI usage), fallback to legacy usage.
              //
              // Read BEFORE the choice guard: the server writes it on a chunk
              // with `choices: []`, which the guard skips — so it was never
              // read, and neither the balance nor the spending warning reached
              // the screen.
              const aliaUsage = parsed.alia_usage || parsed.usage;
              if (aliaUsage && aliaUsage.credits_remaining !== undefined) {
                host.onUsage?.(aliaUsage);
              }

              // Handle OpenAI-compatible format
              const choice = parsed.choices?.[0];
              if (!choice) continue;
              if (choice.finish_reason) sawTerminal = true;

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
                  const detail = failureDetail(meta);
                  syntheticTail = {
                    retryable: meta.retryable,
                    ...(detail === undefined ? {} : { detail }),
                  };
                } else {
                  outputEvidence.realOutputChars += delta.content.length;

                  // A tick for the host (a haptic), throttled by time — per-character
                  // counting fired dozens of native bridge calls per second on
                  // fast streams.
                  const now = Date.now();
                  if (now - lastOutputAt >= 150) {
                    lastOutputAt = now;
                    host.onOutput?.();
                  }

                  replyText += delta.content;
                  pendingContentRef.current += delta.content;
                  scheduleFlush();
                }
              }

              // Handle tool calls (OpenAI format: delta.tool_calls)
              if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
                for (const tc of delta.tool_calls) {
                  const toolCallId = tc.id;
                  const toolName = tc.function?.name;
                  if (!toolCallId || !toolName) continue;
                  outputEvidence.toolInvocationCount += 1;
                  // A question card is the turn's output, even with no sentence before it.
                  if (toolName === ASK_USER_QUESTION_TOOL) outputEvidence.durableArtifactCount += 1;

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
                      const invocation: ToolInvocation = {
                        toolCallId,
                        toolName,
                        state: 'call',
                        args,
                      };

                      if (idx >= 0) {
                        invocations[idx] = invocation;
                      } else {
                        invocations.push(invocation);
                      }

                      updated[updated.length - 1] = {
                        ...lastMessage,
                        toolInvocations: invocations,
                      };
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
                        invocations.push({
                          toolCallId: tool_call_id,
                          toolName: name || 'unknown',
                          state: 'result',
                          result: output,
                        });
                      }

                      updated[updated.length - 1] = {
                        ...lastMessage,
                        toolInvocations: invocations,
                      };
                    }
                    return updated;
                  });

                  host.onToolResult?.({ toolCallId: tool_call_id, name, output });
                  const artifact = artifactOf(tool_call_id, name, output);
                  if (artifact) {
                    outputEvidence.durableArtifactCount += 1;
                    host.onArtifact?.(artifact);
                  }
                }
              }

              // Handle error events from server
              if (parsed.type === 'error') {
                const errMsg =
                  typeof parsed.error === 'string'
                    ? parsed.error
                    : parsed.error?.message || JSON.stringify(parsed.error);
                setError(new Error(errMsg));
                setIsLoading(false);

                // Abort the stream
                abortThisTurn();

                // Break out of the streaming loop
                reader.cancel().catch(() => {});
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
              if (
                frameError instanceof UsageLimitError ||
                errorName(frameError) === 'UsageLimitError'
              ) {
                throw frameError;
              }
            }
          }
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

        // A streaming fetch may throw a non-Error object (e.g. the response body)
        // Try to detect rate limit / credit errors from the thrown object
        if (e && typeof e === 'object' && !(e instanceof Error)) {
          const thrown = e as {
            status?: number;
            error?: ThrownErrorBody;
            body?: { error?: ThrownErrorBody };
          };
          const status = thrown.status || errorStatus(e);
          const errBody: ThrownErrorBody | undefined =
            thrown.error || thrown.body?.error || (thrown as ThrownErrorBody);
          if (
            status === 429 ||
            status === 402 ||
            errBody?.code === 'RATE_LIMIT_EXCEEDED' ||
            errBody?.code === 'INSUFFICIENT_CREDITS'
          ) {
            const isCredits = status === 402 || errBody?.code === 'INSUFFICIENT_CREDITS';
            const usageError = new UsageLimitError({
              type: isCredits ? 'credits' : 'rate_limit',
              code: errBody?.code || (isCredits ? 'INSUFFICIENT_CREDITS' : 'RATE_LIMIT_EXCEEDED'),
              message:
                errBody?.message ||
                (isCredits ? "You've run out of credits." : "You've sent too many messages."),
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
        const finalError =
          e instanceof Error
            ? e
            : new Error(
                typeof e === 'string' ? e : getErrorMessage(e) || 'An unexpected error occurred',
              );
        setError(finalError);
        return keepFailedTurn(true, finalError.message);
      } finally {
        // Flush any remaining batched content
        flushPendingUpdates();
        if (flushTimerRef.current) {
          clearTimeout(flushTimerRef.current);
          flushTimerRef.current = null;
        }
        // Only the turn that still owns the ref clears it and the loading flag: after Stop and a new
        // send, this `finally` belongs to the old turn and must not idle the new one.
        const ownsTurn =
          abortControllerRef.current === null || abortControllerRef.current === controller;
        if (abortControllerRef.current === controller) abortControllerRef.current = null;
        if (turnControlRef.current === turnControl) turnControlRef.current = null;
        if (turnControl) await turnControl.finish();
        else linked?.dispose();
        // A turn that is still streaming here ended without an error path
        // settling it: on its own, or because `stop()` aborted the controller.
        // (The error paths abort it too, but they have settled it first.)
        settleAssistant(controller?.signal.aborted === true ? 'cancelled' : 'completed');
        if (ownsTurn) setIsLoading(false);
        /*
         * The answer replaces your own line in the sidebar — once per turn rather
         * than once per token. Read from what this turn received, not from the
         * rendered messages, which have not caught up with the last batched flush.
         */
        if (replyText !== '') host.onTurnPreview?.(agentId, replyText);
        // Every way a turn stops streaming — finished, stopped, failed — passes here once.
        if (mountedRef.current) host.onTurnEnd?.();
      }
    },
    [
      apiUrl,
      streamFetch,
      host,
      labels,
      oxyServices,
      appAssertionHeaders,
      queryClient,
      conversationId,
      model,
      agentId,
      clientContext,
      scheduleFlush,
      flushPendingUpdates,
      dropPendingUpdates,
      setMessagesAndRef,
    ],
  );

  const detach = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsLoading(false);
  }, []);

  const stop = useCallback(() => {
    const turn = turnControlRef.current;
    if (!turn) return;
    void turn.stop().catch((error: unknown) => {
      if (turnControlRef.current === turn && mountedRef.current) {
        setError(error instanceof Error ? error : new Error('Generation could not be stopped.'));
      }
    });
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

  /** Put the offer away. It wrote nothing, so there is nothing else to undo. */
  const dismissSuggestedNewConversation = useCallback(() => {
    setSuggestedNewConversation(null);
  }, []);

  /** The options a user turn was sent with, if it was sent from this screen. */
  const turnOptionsOf = useCallback(
    (userMessageId: string) => turnOptionsRef.current.get(userMessageId),
    [],
  );

  return {
    messages,
    isLoading,
    error,
    append,
    stop,
    detach,
    setMessages: setMessagesAndRef,
    conversationTitle,
    clearError,
    suggestedNewConversation,
    dismissSuggestedNewConversation,
    agentRun,
    failedTurn,
    retryFailedTurn,
    clearFailedTurn,
    turnOptionsOf,
  };
}
