import type { Message } from '@/types/chat';

/**
 * The history of a thread: everything said before the stretch on screen.
 *
 * ## A thread is many conversations, and the screen only holds one
 *
 * `/@pepe` shows one continuous history, but underneath it is a run of ordinary
 * conversations sharing an `agentId`, and the chat screen is streaming into the
 * most recent one. `GET /agents/thread/:username/messages` is what crosses
 * those seams; this module turns its pages into the list that goes above the
 * live messages, and says where the joins are.
 *
 * Everything here is pure. The scrolling, the fetching and the anchoring live
 * in `lib/hooks/use-thread-history.ts` and `lib/hooks/use-scroll-to-bottom.ts`.
 */

/**
 * A message as the thread endpoint sends it.
 *
 * Two fields more than an ordinary message, and neither is decorative:
 * `conversationId` is the only thing a client can draw a seam from — there is
 * no table of breaks — and `cursor` addresses this exact message, which is what
 * makes both paging and jumping to a search hit possible.
 *
 * `id` is OPTIONAL on the wire, because it is the CLIENT's id and a message
 * written by the server never had one.
 */
export interface WireThreadMessage extends Omit<Message, 'id'> {
  id?: string;
  conversationId: string;
  cursor: string;
}

/** One page of history, oldest-first, with the cursor for the page above it. */
export interface ThreadPage {
  messages: readonly WireThreadMessage[];
  /** `null` when nothing older remains. Never inferred from a page's length. */
  nextCursor: string | null;
}

/** A history message, once it is sure to have an id to be keyed and voted by. */
export interface ThreadMessage extends Message {
  conversationId: string;
  cursor: string;
}

/**
 * The pages, flattened into the messages that go ABOVE the live conversation.
 *
 * Two orderings meet here and they run opposite ways: pages arrive newest-first
 * (each one is the window before the last), while the messages inside a page
 * are oldest-first. So the pages are walked backwards and their contents
 * forwards, which is what puts the whole thing in reading order.
 *
 * **The active stretch is dropped.** Its messages are already on screen, held
 * by the streaming hook, and they are the only ones that can still change —
 * keeping the endpoint's copy too would show every one of them twice and freeze
 * the duplicate at the state it was fetched in. Dropping them here is also what
 * makes starting a new stretch work for free: the messages of the conversation
 * that was active a moment ago stop matching, so they reappear as history
 * without a second request.
 *
 * The cursor stands in for a missing id. A server-written message has no client
 * id, `id` is what the list keys on and what the vote URL carries, and a cursor
 * is unique to one message by construction.
 */
export function threadHistory(
  pages: readonly ThreadPage[],
  activeConversationId: string,
): ThreadMessage[] {
  const history: ThreadMessage[] = [];
  for (let page = pages.length - 1; page >= 0; page -= 1) {
    for (const message of pages[page].messages) {
      if (message.conversationId === activeConversationId) continue;
      history.push({ ...message, id: message.id ?? message.cursor });
    }
  }
  return history;
}

/**
 * Which messages BEGIN a new conversation, keyed by id.
 *
 * A seam is deduced from the data — the conversation a message belongs to
 * changed — and never from elapsed time. "More than N hours passed" is the
 * tempting version and it lies the day somebody returns a week later to finish
 * the same thought: the model is still being given that conversation, so the
 * screen would draw a break where the context has none.
 *
 * The topmost loaded message never carries one, deliberately: whether a break
 * sits above it is a fact about the page that has not been loaded yet. It
 * appears when that page arrives, which is the only moment it is known.
 *
 * The live messages are one stretch, so at most one seam concerns them — above
 * the first — and it is drawn only when there is history above to be separated
 * from.
 */
export function threadSeamIds(
  history: readonly ThreadMessage[],
  live: readonly { id: string }[],
  activeConversationId: string,
): Set<string> {
  const seams = new Set<string>();
  let previous: string | null = null;
  for (const message of history) {
    if (previous !== null && message.conversationId !== previous) seams.add(message.id);
    previous = message.conversationId;
  }
  const firstLive = live[0];
  if (firstLive !== undefined && previous !== null && previous !== activeConversationId) {
    seams.add(firstLive.id);
  }
  return seams;
}
