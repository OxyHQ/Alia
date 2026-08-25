import React from 'react';
import { act, create } from 'react-test-renderer';
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

function mount() {
  const scrollToEnd = vi.fn();
  // A stand-in for the ScrollView: `scrollToEnd` is the only method the hook
  // calls, and asserting on it is the whole point.
  const ref = { current: { scrollToEnd } as unknown as ScrollView };
  const seen: ReturnType<typeof useScrollToBottom>[] = [];

  function Probe() {
    seen.push(useScrollToBottom(ref));
    return null;
  }

  act(() => {
    create(<Probe />);
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

  return { scrollToEnd, scrollTo, grow, latest };
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
