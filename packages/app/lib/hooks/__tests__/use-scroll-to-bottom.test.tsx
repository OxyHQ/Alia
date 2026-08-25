import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { NativeScrollEvent, NativeSyntheticEvent, ScrollView } from 'react-native';

import { useScrollToBottom } from '@/lib/hooks/use-scroll-to-bottom';

/**
 * Sticky-bottom scrolling, as the owner described it: the view follows the text
 * while you are at the end, and stops the moment you scroll up a little.
 *
 * The geometry here is the geometry MEASURED in Chromium against a DOM built to
 * match what `react-native-web` renders for this screen — a 400px viewport over
 * a 1344px thread, so the end is `contentOffset.y === 944`, and a streamed
 * answer growing the last message takes the content to 1618 without changing
 * the message count. Feeding the hook the real numbers is what makes these
 * assertions about the shipped behaviour rather than about a tidy invention.
 */

const VIEWPORT = 400;
const SEEDED_CONTENT = 1344;
const END = SEEDED_CONTENT - VIEWPORT; // 944

function mount(initialHistory?: {
  hasMore: boolean;
  isLoading: boolean;
  load: () => void;
}) {
  const scrollToEnd = vi.fn();
  const scrollToY = vi.fn();
  // A stand-in for the ScrollView: the two methods the hook calls, one per end
  // of the thread — `scrollToEnd` follows the newest message, `scrollTo`
  // restores a reader that history was inserted above.
  const ref = { current: { scrollToEnd, scrollTo: scrollToY } as unknown as ScrollView };
  const seen: ReturnType<typeof useScrollToBottom>[] = [];

  type History = NonNullable<Parameters<typeof useScrollToBottom>[1]>;

  function Probe({ history }: { history?: History }) {
    seen.push(useScrollToBottom(ref, history));
    return null;
  }

  let renderer: ReactTestRenderer | null = null;
  act(() => {
    renderer = create(<Probe history={initialHistory} />);
  });

  /** The paging state changed — a page started arriving, or stopped. */
  const setHistory = (history?: History) =>
    act(() => {
      renderer?.update(<Probe history={history} />);
    });

  const latest = () => seen[seen.length - 1];

  /** A scroll event from a viewport of `VIEWPORT` over `contentHeight` of content. */
  const scrollTo = (y: number, contentHeight: number) =>
    act(() => {
      // The hook reads three fields off `nativeEvent`; the event carries many
      // more that no branch here consults.
      const event = {
        nativeEvent: {
          contentOffset: { y },
          contentSize: { height: contentHeight },
          layoutMeasurement: { height: VIEWPORT },
        },
      } as NativeSyntheticEvent<NativeScrollEvent>;
      latest().onScroll(event);
    });

  /**
   * Content grew, which is the ONLY signal a streamed answer gives: tokens are
   * appended to the last message, so the message count never moves.
   */
  const grow = () =>
    act(() => {
      latest().onContentSizeChange();
    });

  return { scrollToEnd, scrollToY, scrollTo, grow, latest, setHistory };
}

describe('useScrollToBottom', () => {
  it('follows the text while the reader is at the end', () => {
    const { scrollToEnd, scrollTo, grow } = mount();

    scrollTo(END, SEEDED_CONTENT);
    grow();

    expect(scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it('lets go once the reader has scrolled up a little', () => {
    const { scrollToEnd, scrollTo, grow } = mount();

    scrollTo(END, SEEDED_CONTENT);
    scrollTo(END - 300, SEEDED_CONTENT); // the reader scrolls up 300px
    grow();

    // The owner's actual request: streaming must not drag them back down.
    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  it('follows again when the reader returns to the end', () => {
    const { scrollToEnd, scrollTo, grow } = mount();

    scrollTo(END - 300, SEEDED_CONTENT);
    grow();
    expect(scrollToEnd).not.toHaveBeenCalled();

    scrollTo(END, SEEDED_CONTENT);
    grow();
    expect(scrollToEnd).toHaveBeenCalledTimes(1);
  });

  /**
   * The trap this hook is built around. `scrollToEnd` emits `onScroll` exactly
   * as a finger does, so the follow's own scroll comes back through the handler
   * that decides whether to follow. Unanimated it lands ON the end and reports
   * at-bottom, so the follow survives its own side effect; an animated one would
   * report a position above the end first and switch itself off at the first
   * token.
   */
  it('survives the scroll event its own follow provokes', () => {
    const { scrollToEnd, scrollTo, grow } = mount();

    scrollTo(END, SEEDED_CONTENT);

    const streamed = 1618;
    grow();
    scrollTo(streamed - VIEWPORT, streamed); // where our own scrollToEnd landed

    const streamedMore = 1853;
    grow();
    scrollTo(streamedMore - VIEWPORT, streamedMore);
    grow();

    expect(scrollToEnd).toHaveBeenCalledTimes(3);
  });

  it('never animates a programmatic scroll', () => {
    const { scrollToEnd, scrollTo, grow, latest } = mount();

    scrollTo(END, SEEDED_CONTENT);
    grow();
    act(() => {
      latest().scrollToBottom();
    });

    expect(scrollToEnd).toHaveBeenCalledTimes(2);
    // Load-bearing: animation is what re-introduces the self-disabling scroll
    // above, and what tugs at sixty tokens a second.
    for (const call of scrollToEnd.mock.calls) {
      expect(call[0]).toEqual({ animated: false });
    }
  });

  it('opens a thread at its newest message', () => {
    const { scrollToEnd, grow } = mount();

    // No scroll has happened yet: the follow starts armed, so the first content
    // layout pins the view to the end.
    grow();

    expect(scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it('counts the last 50px as the end, so a near-miss still follows', () => {
    const { scrollToEnd, scrollTo, grow } = mount();

    scrollTo(END - 50, SEEDED_CONTENT);
    grow();
    expect(scrollToEnd).toHaveBeenCalledTimes(1);

    scrollTo(END - 51, SEEDED_CONTENT);
    grow();
    expect(scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it('reports at-bottom for the scroll-to-bottom button', () => {
    const { scrollTo, latest } = mount();

    expect(latest().isAtBottom).toBe(true);

    scrollTo(END - 300, SEEDED_CONTENT);
    expect(latest().isAtBottom).toBe(false);

    scrollTo(END, SEEDED_CONTENT);
    expect(latest().isAtBottom).toBe(true);
  });
});

describe('reading upwards, into the thread\'s older stretches', () => {
  /**
   * The other end of the thread. Older stretches are fetched as the reader
   * approaches the top, and everything they were reading shifts down by however
   * tall the batch turned out to be.
   *
   * The numbers are that geometry: the history on screen is 1000px tall, the
   * reader is 200px down — inside the 300px that asks for more — and the page
   * that arrives adds 800px above them.
   */
  const HISTORY = 1000;
  const NEAR_TOP = 200;
  const PAGE = 800;

  const paging = (over: Partial<{ hasMore: boolean; isLoading: boolean }> = {}) => {
    const load = vi.fn();
    return { load, history: { hasMore: true, isLoading: false, load, ...over } };
  };

  it('asks for the page above when the reader nears the top', () => {
    const { load, history } = paging();
    const { scrollTo } = mount(history);

    scrollTo(NEAR_TOP, SEEDED_CONTENT);

    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not ask from further down the thread', () => {
    const { load, history } = paging();
    const { scrollTo } = mount(history);

    scrollTo(301, SEEDED_CONTENT);

    expect(load).not.toHaveBeenCalled();
  });

  it('does not ask while a page is already coming', () => {
    // This fires on every scroll event, and a reader sitting at the top emits
    // them continuously. Without the guard one flick of the wrist asks for the
    // same page a dozen times.
    const { load, history } = paging({ isLoading: true });
    const { scrollTo } = mount(history);

    scrollTo(NEAR_TOP, SEEDED_CONTENT);
    scrollTo(NEAR_TOP - 10, SEEDED_CONTENT);

    expect(load).not.toHaveBeenCalled();
  });

  it('does not ask when nothing older remains', () => {
    const { load, history } = paging({ hasMore: false });
    const { scrollTo } = mount(history);

    scrollTo(NEAR_TOP, SEEDED_CONTENT);

    expect(load).not.toHaveBeenCalled();
  });

  it('asks for nothing at all on a screen with no thread behind it', () => {
    // `/c/:id` passes no paging, and every scroll event still comes through
    // here.
    const { scrollTo, scrollToY } = mount();

    scrollTo(NEAR_TOP, SEEDED_CONTENT);

    expect(scrollToY).not.toHaveBeenCalled();
  });

  it('moves the reader by exactly what landed above them', () => {
    const { history } = paging();
    const { scrollToY, scrollTo, latest } = mount(history);

    act(() => latest().historyEndsAt(HISTORY));
    scrollTo(NEAR_TOP, SEEDED_CONTENT);
    act(() => latest().historyEndsAt(HISTORY + PAGE));

    expect(scrollToY).toHaveBeenCalledWith({ y: NEAR_TOP + PAGE, animated: false });
  });

  it('leaves the view alone when the reader asked for nothing', () => {
    // Every measurement passes through here, including the first layout and
    // every re-layout that has nothing to do with paging. Only one the reader
    // provoked may move the view.
    const { scrollToY, scrollTo, latest } = mount();

    scrollTo(NEAR_TOP, SEEDED_CONTENT);
    act(() => latest().historyEndsAt(HISTORY));
    act(() => latest().historyEndsAt(HISTORY + PAGE));

    expect(scrollToY).not.toHaveBeenCalled();
  });

  it('ignores a re-layout that reports the same history height', () => {
    // The composer growing, or a window resize, reaches this with the request
    // still in flight. Nothing was inserted, so nothing moves, and the anchor
    // waits for the page it was taken for.
    const { history } = paging();
    const { scrollToY, scrollTo, latest } = mount(history);

    act(() => latest().historyEndsAt(HISTORY));
    scrollTo(NEAR_TOP, SEEDED_CONTENT);
    act(() => latest().historyEndsAt(HISTORY));
    expect(scrollToY).not.toHaveBeenCalled();

    act(() => latest().historyEndsAt(HISTORY + PAGE));
    expect(scrollToY).toHaveBeenCalledWith({ y: NEAR_TOP + PAGE, animated: false });
  });

  it('keeps correcting as the page settles, rather than believing the first measurement', () => {
    /**
     * MEASURED, not supposed: in Chromium a page of fifty messages reports its
     * height several times as the rows lay out. Correcting once — to the first
     * of those — left the reader 4045px from where they had been and near the
     * top again, which pulled in a third page nobody asked for.
     *
     * So the correction is absolute and re-applied: each measurement supersedes
     * the last, and the final one is the one that counts.
     */
    const { history } = paging();
    const { scrollToY, scrollTo, latest } = mount(history);

    act(() => latest().historyEndsAt(HISTORY));
    scrollTo(NEAR_TOP, SEEDED_CONTENT);
    act(() => latest().historyEndsAt(HISTORY + 200));
    act(() => latest().historyEndsAt(HISTORY + PAGE));

    expect(scrollToY).toHaveBeenLastCalledWith({ y: NEAR_TOP + PAGE, animated: false });
  });

  it('lets go the moment the reader scrolls somewhere themselves', () => {
    // Their position is theirs now. Anything that lands later must not drag
    // them back to where they were before they moved.
    const { history } = paging();
    const { scrollToY, scrollTo, latest } = mount(history);

    act(() => latest().historyEndsAt(HISTORY));
    scrollTo(NEAR_TOP, SEEDED_CONTENT);
    act(() => latest().historyEndsAt(HISTORY + PAGE));
    scrollTo(NEAR_TOP + PAGE + 500, SEEDED_CONTENT + PAGE); // the reader scrolls down
    act(() => latest().historyEndsAt(HISTORY + PAGE + 300));

    expect(scrollToY).toHaveBeenCalledTimes(1);
  });

  it('does not mistake its own scroll for the reader moving', () => {
    // Every restore comes back through `onScroll` exactly as a finger does. Read
    // as the reader, it would disarm the anchor at the first installment, which
    // is the failure the re-application above exists to prevent.
    const { history } = paging();
    const { scrollToY, scrollTo, latest } = mount(history);

    act(() => latest().historyEndsAt(HISTORY));
    scrollTo(NEAR_TOP, SEEDED_CONTENT);
    act(() => latest().historyEndsAt(HISTORY + 200));
    scrollTo(NEAR_TOP + 200, SEEDED_CONTENT + 200); // where that restore landed
    act(() => latest().historyEndsAt(HISTORY + PAGE));

    expect(scrollToY).toHaveBeenLastCalledWith({ y: NEAR_TOP + PAGE, animated: false });
  });

  it('does not pull the whole thread in, one page after another', () => {
    /**
     * The runaway, and it is not hypothetical: with the restore removed and
     * Chromium's own scroll anchoring turned off, opening this thread and
     * scrolling to the top fetched three pages instead of one.
     *
     * Two things stop it. The reader ends up where they were, which is no
     * longer near the top; and while a page is still settling — which is what
     * an armed anchor means — no scroll event may ask for another, because the
     * position those events report is mid-flight.
     */
    const { load, history } = paging();
    const { scrollTo, scrollToY, latest, setHistory } = mount(history);

    act(() => latest().historyEndsAt(HISTORY));
    scrollTo(NEAR_TOP, SEEDED_CONTENT);
    setHistory({ ...history, isLoading: true });
    act(() => latest().historyEndsAt(HISTORY + 200));
    setHistory(history);
    /**
     * Wherever that first installment actually left them, read back off the
     * ScrollView rather than assumed: written as a number, this passes just as
     * happily with no restore at all, which is the failure it exists to catch.
     */
    const landed = scrollToY.mock.lastCall?.[0] as { y: number } | undefined;
    scrollTo(landed?.y ?? NEAR_TOP, SEEDED_CONTENT + 200);
    act(() => latest().historyEndsAt(HISTORY + PAGE));

    expect(load).toHaveBeenCalledTimes(1);
  });

  it('asks for nothing more while the page it has is still settling', () => {
    // The installments are not all big. A first measurement worth 50px leaves
    // the reader inside the 300 that asks — so "they are no longer near the
    // top" cannot be the only thing stopping the next request. An armed anchor
    // means a page is mid-flight, and every scroll event until it lands
    // reports a position that describes nothing yet.
    const { load, history } = paging();
    const { scrollTo, latest, setHistory } = mount(history);

    act(() => latest().historyEndsAt(HISTORY));
    scrollTo(NEAR_TOP, SEEDED_CONTENT);
    setHistory({ ...history, isLoading: true });
    act(() => latest().historyEndsAt(HISTORY + 50));
    setHistory(history);
    scrollTo(NEAR_TOP + 50, SEEDED_CONTENT + 50);

    expect(load).toHaveBeenCalledTimes(1);
  });

  it('asks again once the reader climbs back to the top', () => {
    const { load, history } = paging();
    const { scrollTo, latest, setHistory } = mount(history);

    act(() => latest().historyEndsAt(HISTORY));
    scrollTo(NEAR_TOP, SEEDED_CONTENT);
    setHistory({ ...history, isLoading: true });
    act(() => latest().historyEndsAt(HISTORY + PAGE));
    setHistory(history);
    // The reader scrolls up again, which is what releases the anchor and asks.
    scrollTo(NEAR_TOP, SEEDED_CONTENT + PAGE);

    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not touch the follow-the-newest half', () => {
    // Loading history must not re-pin the view to the end: that is the exact
    // move the reader scrolled up to get away from.
    const { history } = paging();
    const { scrollToEnd, scrollTo, grow, latest } = mount(history);

    act(() => latest().historyEndsAt(HISTORY));
    scrollTo(NEAR_TOP, SEEDED_CONTENT);
    act(() => latest().historyEndsAt(HISTORY + PAGE));
    grow();

    expect(scrollToEnd).not.toHaveBeenCalled();
  });
});
