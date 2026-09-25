/**
 * `/__fixtures/:id` — the chat page, fed a generated conversation.
 *
 * Fixtures build only (`fixtures/entry.tsx`). It renders `ChatPageContent`, the
 * same public entry point `/c/:id` renders through `ConversationScreen`, with
 * the conversation from `fixtures/conversation.ts` in place of the one the API
 * would return. Everything under it — the shell, the thread, the composer, the
 * rows, the cards — is the production component tree, so the harness measures
 * whatever that tree currently is, before and after a refactor of it.
 *
 * The route name starts with `__`, which `(app)/_layout.tsx` already treats as
 * a chat route: it composes its own container, as the real chat pages do.
 *
 * The harness drives it through `window.__aliaFixture`:
 *
 *   - `opened[id]` — the moment the page, focused, had committed its thread
 *     and a frame had passed, as `performance.now()`; cleared on blur.
 *   - `threads[id].stream({ chunks, intervalMs })` — a simulated turn: a user
 *     message and an assistant reply streamed into the thread with the same
 *     update the real stream makes (`use-streaming-chat.ts` flushes every 50ms
 *     by replacing the last message), resolving when it has finished.
 *   - `navigate(id)` — switch to another fixture conversation the way the
 *     sidebar switches chats: `router.replace`. Not `pushState` + `popstate`:
 *     a history entry the router did not write has no state record, so its
 *     linking falls back to `resetRoot` with fresh route keys, and every
 *     screen, the root layout and `OxyProvider` included, remounts — a
 *     browser back/forward onto a foreign entry, not a chat switch.
 */
import { ChatPageContent } from '@/features/chat/ui/chat-page-content';
import { fixtureConversation, fixtureReply } from '../../../conversation';
import type { Message } from '@/features/chat/model/chat';
import { router, useFocusEffect, useLocalSearchParams, type Href } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';

interface StreamOptions {
  /** How many flushes the reply arrives in. */
  chunks?: number;
  /** Time between flushes, ms. The real stream's is 50. */
  intervalMs?: number;
}

interface FixtureThreadApi {
  stream: (options?: StreamOptions) => Promise<{ updates: number; elapsed: number }>;
}

interface FixtureWindow {
  __aliaFixture?: {
    opened: Record<string, number>;
    threads: Record<string, FixtureThreadApi>;
    navigate: (id: string) => void;
  };
}

function registry() {
  const w = window as unknown as FixtureWindow;
  w.__aliaFixture ??= {
    opened: {},
    threads: {},
    // Not a typed route: fixture routes live outside `app/`.
    navigate: (id) => router.replace(`/__fixtures/${encodeURIComponent(id)}` as Href),
  };
  return w.__aliaFixture;
}

export default function FixtureChatPage() {
  const { id = 'a-1000' } = useLocalSearchParams<{ id: string }>();
  const conversation = useMemo(() => fixtureConversation(id), [id]);
  const [messages, setMessages] = useState<Message[]>(conversation.messages);
  const [isLoading, setIsLoading] = useState(false);
  const turnRef = useRef(0);
  // The router may hand this instance a different id rather than mount a new one.
  const [shownId, setShownId] = useState(id);
  if (shownId !== id) {
    setShownId(id);
    setMessages(conversation.messages);
  }

  const stream = useCallback(
    ({ chunks = 60, intervalMs = 50 }: StreamOptions = {}) =>
      new Promise<{ updates: number; elapsed: number }>((resolve) => {
        const turn = (turnRef.current += 1);
        const reply = fixtureReply(`${id}:${turn}`);
        const now = new Date().toISOString();
        const replyId = `${id}-stream-${turn}`;
        setMessages((prev) => [
          ...prev,
          { id: `${id}-ask-${turn}`, role: 'user', content: 'Tell me more.', createdAt: now },
          { id: replyId, role: 'assistant', content: '', isStreaming: true, createdAt: now },
        ]);
        setIsLoading(true);
        const size = Math.ceil(reply.length / chunks);
        const started = performance.now();
        let sent = 0;
        const timer = setInterval(() => {
          const piece = reply.slice(sent * size, (sent + 1) * size);
          sent += 1;
          const done = sent >= chunks;
          setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.id === replyId) {
              updated[updated.length - 1] = {
                ...last,
                content: `${typeof last.content === 'string' ? last.content : ''}${piece}`,
                ...(done ? { isStreaming: false, turnOutcome: 'completed' as const } : {}),
              };
            }
            return updated;
          });
          if (done) {
            clearInterval(timer);
            setIsLoading(false);
            // Resolve once the last update has been drawn.
            requestAnimationFrame(() =>
              setTimeout(() => resolve({ updates: sent, elapsed: performance.now() - started })),
            );
          }
        }, intervalMs);
      }),
    [id],
  );

  // On focus rather than on mount: a screen the navigator kept mounted and
  // brought back is "opened" again, and must say so.
  useFocusEffect(
    useCallback(() => {
      const fixtures = registry();
      fixtures.threads[id] = { stream };
      // The first frame after the commit that drew the thread.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const frame = requestAnimationFrame(() => {
        timer = setTimeout(() => {
          fixtures.opened[id] = performance.now();
        });
      });
      return () => {
        cancelAnimationFrame(frame);
        clearTimeout(timer);
        delete fixtures.threads[id];
        delete fixtures.opened[id];
      };
    }, [id, stream]),
  );

  const onSubmit = useCallback(async () => false, []);
  const onStop = useCallback(() => {}, []);

  return (
    <ChatPageContent
      messages={messages}
      isLoading={isLoading}
      onSubmit={onSubmit}
      onStop={onStop}
      conversationLoading={false}
      conversationId={id}
      conversationTitle={conversation.title}
    />
  );
}
