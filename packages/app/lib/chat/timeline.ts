import type { Message } from '@/lib/hooks/use-conversations';

/**
 * The chat timeline as data: which rows are mounted, which just arrived, and
 * which facts about the list a streamed token can and cannot change.
 *
 * Everything here is pure. `lib/hooks/use-timeline-window.ts` holds the state
 * and talks to the thread; `components/chat-interface.tsx` draws the rows.
 *
 * ## Why a paged window and not virtualization
 *
 * Bloom's `AiChatThread` is a plain `ScrollView` on native and the document on
 * web, with no virtualization and no `scrollToIndex` (#608, gap 3 in
 * `docs/bloom-adoption.mdx`). A spacer-based virtualizer on top of it would
 * swap estimated heights for measured ones ABOVE the reader, and the thread
 * only compensates growth it asked for — so every estimate that was wrong
 * would move the text being read. What the thread does anchor exactly is a
 * page landing above after `onStartReached`, and that is the one move this
 * window makes: it mounts the newest rows, and reveals older ones a page at a
 * time when the reader comes near the top, through the same anchored growth
 * history paging already uses. Rows are only ever dropped from the top while
 * the reader is at the bottom, where nothing above them is on screen.
 */

/** How many rows a thread opens with, counted from the newest. */
export const INITIAL_ROWS = 40;
/** How many older rows each approach to the top reveals. */
export const PAGE_ROWS = 30;
/** Rows kept above a cursor-jump target, so it does not land on the window's edge. */
export const FOCUS_MARGIN = 5;
/**
 * How far past its opening size the window may grow before it is folded back.
 * Folding is only done at the bottom with no turn in flight, so a reader who
 * went up a long way does not keep every row they passed mounted forever.
 */
export const COLLAPSE_AFTER = INITIAL_ROWS + 2 * PAGE_ROWS;

/**
 * Where the mounted range starts.
 *
 *  - `tail`: the newest `INITIAL_ROWS`. Only held until the rows are known;
 *    the hook pins it to a row as soon as there are rows, so rows appended by
 *    a turn grow the window instead of sliding it.
 *  - `top`: from the first row loaded. Set when the reader has reached the top
 *    and asked for history, so the page that lands is shown.
 *  - `row`: from this row, by id — ids survive rows being added on either side.
 */
export type TimelineAnchor = { kind: 'tail' } | { kind: 'top' } | { kind: 'row'; id: string };

export const TAIL: TimelineAnchor = Object.freeze({ kind: 'tail' });
export const TOP: TimelineAnchor = Object.freeze({ kind: 'top' });

/** The index of the first mounted row. */
export function resolveStart(
  anchor: TimelineAnchor,
  ids: readonly string[],
  focusIndex = -1,
): number {
  let start: number;
  if (anchor.kind === 'top') start = 0;
  else if (anchor.kind === 'row') {
    const index = ids.indexOf(anchor.id);
    // A row that is gone (a refetched history, a replaced conversation) falls
    // back to the newest page rather than to everything.
    start = index === -1 ? tailStart(ids.length) : index;
  } else start = tailStart(ids.length);
  // A jump's target is always mounted, with a few rows of context above it.
  if (focusIndex !== -1) start = Math.min(start, Math.max(0, focusIndex - FOCUS_MARGIN));
  return start;
}

function tailStart(count: number): number {
  return Math.max(0, count - INITIAL_ROWS);
}

/** The anchor that keeps exactly the rows mounted now, from the row at `start`. */
export function pinAnchor(ids: readonly string[], start: number): TimelineAnchor {
  if (start <= 0 || ids.length === 0) return TOP;
  return { kind: 'row', id: ids[start] };
}

/**
 * The reader came near the top: one more page of the rows already loaded, or,
 * with none left above, `null` — the thread's own history is what comes next.
 */
export function revealAbove(ids: readonly string[], start: number): TimelineAnchor | null {
  if (start <= 0) return null;
  return pinAnchor(ids, Math.max(0, start - PAGE_ROWS));
}

/** Fold a window that grew back to its opening size, or `null` if it has not grown enough. */
export function collapseToTail(ids: readonly string[], start: number): TimelineAnchor | null {
  if (ids.length - start <= COLLAPSE_AFTER) return null;
  return pinAnchor(ids, tailStart(ids.length));
}

/**
 * The facts about a message the timeline's derived data is built from — the
 * day separators, the seams, the turn timings, which answer is the last of
 * Alia's — and nothing a token changes.
 */
type Shape = Pick<Message, 'id' | 'role' | 'createdAt' | 'agentInfo'>;

function sameShape(a: Shape, b: Shape): boolean {
  return (
    a === b ||
    (a.id === b.id && a.role === b.role && a.createdAt === b.createdAt && a.agentInfo?.id === b.agentInfo?.id)
  );
}

/**
 * Whether two versions of the list differ only in what their messages SAY.
 *
 * A streamed token replaces the last message object and the array around it,
 * so identity alone says "changed" twenty times a second. This compares the
 * fields the derived data reads; the per-element check is a pointer comparison
 * for every message but the one being written, which is why it costs next to
 * nothing where recomputing the derivations cost a pass over the whole thread.
 */
export function sameTimelineShape(previous: readonly Shape[], next: readonly Shape[]): boolean {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;
  for (let i = 0; i < next.length; i += 1) {
    if (!sameShape(previous[i], next[i])) return false;
  }
  return true;
}

/**
 * The ids that ARRIVED in this render — the rows that may animate in.
 *
 * Not "every id the last render did not have". Three things change the list
 * without anything arriving, and each would otherwise replay every message as
 * if it had just been said:
 *
 *  - the first render of a screen: everything on it is already there;
 *  - switching conversation in place: the list is REPLACED, so nothing it
 *    shares with the last one is the tell;
 *  - a conversation's messages landing after its load: the list fills from
 *    empty in one batch, where a send adds a question and the answer's
 *    placeholder — never more than two.
 */
export function arrivedIds(
  previous: readonly string[] | null,
  previousLoading: boolean,
  next: readonly { id: string }[],
): ReadonlySet<string> {
  if (previous === null || previousLoading) return EMPTY_IDS;
  const known = new Set(previous);
  const arrived = next.filter((m) => !known.has(m.id));
  if (arrived.length === 0) return EMPTY_IDS;
  const replaced = previous.length > 0 && arrived.length === next.length;
  const loaded = previous.length === 0 && arrived.length > 2;
  if (replaced || loaded) return EMPTY_IDS;
  return new Set(arrived.map((m) => m.id));
}

const EMPTY_IDS: ReadonlySet<string> = new Set();

/**
 * Where the reader was in a conversation, kept for the session so returning to
 * it lands there instead of at whatever the scroller last held.
 *
 * `probeId` is a row that was mounted when this was saved. The position is only
 * restored once that row is on screen again, because until then the list may
 * still be the previous conversation's — the streaming hook swaps its messages
 * in an effect, a render after the conversation id changes.
 */
export interface TimelinePosition {
  anchor: TimelineAnchor;
  /** px from the thread's top, in the frame `scrollToOffset` takes. */
  offset: number;
  atBottom: boolean;
  probeId: string;
}

/**
 * The session's saved positions, by conversation. Never persisted: a reload
 * opens at the newest turn. Not partitioned by account either, because a
 * conversation id belongs to one account and an offset says nothing about what
 * the conversation contains.
 */
export class TimelinePositions {
  private readonly positions = new Map<string, TimelinePosition>();

  save(key: string, position: TimelinePosition): void {
    this.positions.set(key, position);
  }

  read(key: string): TimelinePosition | undefined {
    return this.positions.get(key);
  }

  clear(): void {
    this.positions.clear();
  }
}

export const timelinePositions = new TimelinePositions();
