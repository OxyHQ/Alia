import { afterEach, describe, expect, it } from 'vitest';

import { conversationBreaks, daySeparators } from '../thread-separators';

/**
 * Whether the line lands where the READER's midnight is.
 *
 * Every case here runs in a stated timezone, because a separator derived from
 * the UTC calendar passes any test written in UTC and is wrong for most of the
 * planet for part of every day. The two used are the extremes of the offset
 * range — Kiritimati is UTC+14 and Niue is UTC-11 — so one instant genuinely
 * falls on different calendar days in them, and a UTC-based implementation
 * cannot satisfy both.
 */

const ORIGINAL_TZ = process.env.TZ;

/** Run one case in a timezone, then put the process back. */
function inTimezone<T>(timezone: string, body: () => T): T {
  process.env.TZ = timezone;
  try {
    return body();
  } finally {
    process.env.TZ = ORIGINAL_TZ;
  }
}

afterEach(() => {
  process.env.TZ = ORIGINAL_TZ;
});

function message(id: string, createdAt?: string) {
  return createdAt === undefined ? { id } : { id, createdAt };
}

describe('day separators', () => {
  it('draws none between two messages on the same local day', () => {
    inTimezone('Europe/Madrid', () => {
      const separators = daySeparators(
        [
          message('a', '2026-03-04T08:00:00Z'),
          message('b', '2026-03-04T20:00:00Z'),
        ],
        new Date('2026-03-04T21:00:00Z'),
        'en-GB',
      );

      expect(separators).toEqual([]);
    });
  });

  it('draws one where the pair straddles local midnight', () => {
    inTimezone('Europe/Madrid', () => {
      // 23:40 and 00:10 Madrid time, half an hour apart.
      const separators = daySeparators(
        [
          message('a', '2026-03-04T22:40:00Z'),
          message('b', '2026-03-04T23:10:00Z'),
        ],
        new Date('2026-03-05T10:00:00Z'),
        'en-GB',
      );

      expect(separators).toEqual([{ messageId: 'b', label: { kind: 'today' } }]);
    });
  });

  /**
   * The two ways a UTC calendar gets this wrong, one test each, so neither
   * direction can be right by accident. Both are ninety-minute gaps.
   */

  it('draws a line inside ONE UTC day, where the reader has crossed midnight', () => {
    // Kiritimati is UTC+14, so its midnight falls at 10:00 UTC: these two
    // instants are 4 March 23:00 and 5 March 00:30 there, while UTC sees a
    // single afternoon. A UTC implementation draws nothing here.
    inTimezone('Pacific/Kiritimati', () => {
      expect(
        daySeparators(
          [message('a', '2026-03-04T09:00:00Z'), message('b', '2026-03-04T10:30:00Z')],
          new Date('2026-03-05T00:00:00Z'),
          'en-GB',
        ),
      ).toEqual([{ messageId: 'b', label: { kind: 'today' } }]);
    });
  });

  it('draws none ACROSS UTC midnight, where the reader has not crossed theirs', () => {
    // Niue is UTC-11: these two are 4 March 12:00 and 13:30 there, one lunchtime,
    // while UTC changes date between them. A UTC implementation draws a line
    // through the middle of an afternoon.
    inTimezone('Pacific/Niue', () => {
      expect(
        daySeparators(
          [message('a', '2026-03-04T23:00:00Z'), message('b', '2026-03-05T00:30:00Z')],
          new Date('2026-03-05T02:00:00Z'),
          'en-GB',
        ),
      ).toEqual([]);
    });
  });

  it('names the days it can name, and dates the ones it cannot', () => {
    inTimezone('Europe/Madrid', () => {
      const separators = daySeparators(
        [
          message('a', '2026-02-27T12:00:00Z'),
          message('b', '2026-03-02T12:00:00Z'),
          message('c', '2026-03-03T12:00:00Z'),
          message('d', '2026-03-04T12:00:00Z'),
        ],
        new Date('2026-03-04T13:00:00Z'),
        'en-GB',
      );

      expect(separators).toEqual([
        { messageId: 'b', label: { kind: 'date', text: 'Mon 2 Mar' } },
        { messageId: 'c', label: { kind: 'yesterday' } },
        { messageId: 'd', label: { kind: 'today' } },
      ]);
    });
  });

  it('carries the year only on a day outside the current one', () => {
    inTimezone('Europe/Madrid', () => {
      // Two days in the year that is running: no year, it would be on every line.
      expect(
        daySeparators(
          [message('a', '2026-01-01T12:00:00Z'), message('b', '2026-01-02T12:00:00Z')],
          new Date('2026-03-04T13:00:00Z'),
          'en-GB',
        )[0]?.label,
      ).toEqual({ kind: 'date', text: 'Fri 2 Jan' });

      // A day in the year before it: the year, because a thread that spans two
      // of them otherwise says "31 Dec" about a date nobody can place. The comma
      // is ICU's — en-GB punctuates the two patterns differently, and asserting
      // the string a person reads is the point of asserting it at all.
      expect(
        daySeparators(
          [message('a', '2025-12-30T12:00:00Z'), message('b', '2025-12-31T12:00:00Z')],
          new Date('2026-03-04T13:00:00Z'),
          'en-GB',
        )[0]?.label,
      ).toEqual({ kind: 'date', text: 'Wed, 31 Dec 2025' });
    });
  });

  it('draws nothing above the first message, whatever day it is', () => {
    inTimezone('Europe/Madrid', () => {
      expect(
        daySeparators([message('a', '2020-01-01T12:00:00Z')], new Date('2026-03-04T13:00:00Z'), 'en-GB'),
      ).toEqual([]);
    });
  });

  it('skips a message with no usable timestamp instead of dating it now', () => {
    inTimezone('Europe/Madrid', () => {
      // The middle two are what an in-flight turn looks like before the round
      // trip: no `createdAt` at all, and — from a bad write — one that is not a
      // date. Neither may invent a boundary, and neither may hide the real one.
      const separators = daySeparators(
        [
          message('a', '2026-03-03T12:00:00Z'),
          message('pending'),
          message('broken', 'not a date'),
          message('b', '2026-03-04T12:00:00Z'),
        ],
        new Date('2026-03-04T13:00:00Z'),
        'en-GB',
      );

      expect(separators).toEqual([{ messageId: 'b', label: { kind: 'today' } }]);
    });
  });

  it('counts days by the calendar, so a DST shift does not relabel yesterday', () => {
    // Spain springs forward at 02:00 on 29 March 2026: that local day is 23
    // hours long, and the one before it, measured in milliseconds, is 23 hours
    // "ago" plus a bit — which a millisecond division rounds to today.
    inTimezone('Europe/Madrid', () => {
      const [separator] = daySeparators(
        [
          message('a', '2026-03-27T12:00:00Z'),
          message('b', '2026-03-28T22:00:00Z'),
        ],
        // 29 March, 12:00 local.
        new Date('2026-03-29T10:00:00Z'),
        'en-GB',
      );

      // 28 March 23:00 local — the day before the shift.
      expect(separator).toEqual({ messageId: 'b', label: { kind: 'yesterday' } });
    });
  });
});

describe('new-conversation rules', () => {
  const THREAD = [
    message('a', '2026-03-04T09:00:00Z'),
    message('b', '2026-03-04T11:00:00Z'),
    message('c', '2026-03-04T15:00:00Z'),
  ];

  it('sits above the first message written after the break', () => {
    const { above, afterLast } = conversationBreaks(THREAD, ['2026-03-04T10:00:00Z']);

    expect([...above]).toEqual(['b']);
    expect(afterLast).toBe(false);
  });

  it('sits above a message written at the very instant of the break', () => {
    // The boundary itself, which an exclusive comparison would push onto the
    // NEXT message and quietly put the first message of the new conversation at
    // the end of the old one.
    expect([...conversationBreaks(THREAD, ['2026-03-04T11:00:00Z']).above]).toEqual(['b']);
  });

  it('sits at the end while nothing has been written under it yet', () => {
    // What a break looks like the moment it is made — and the only feedback the
    // person who pressed the button gets until they type.
    const { above, afterLast } = conversationBreaks(THREAD, ['2026-03-04T16:00:00Z']);

    expect([...above]).toEqual([]);
    expect(afterLast).toBe(true);
  });

  it('collapses two marks with nothing between them into one rule', () => {
    // The API keeps both, deliberately, because it cannot know what they are
    // for. Two identical rules on one message say nothing the first does not.
    const { above } = conversationBreaks(THREAD, [
      '2026-03-04T10:00:00Z',
      '2026-03-04T10:30:00Z',
    ]);

    expect([...above]).toEqual(['b']);
  });

  it('takes several real breaks in one thread', () => {
    const { above, afterLast } = conversationBreaks(THREAD, [
      '2026-03-04T10:00:00Z',
      '2026-03-04T12:00:00Z',
    ]);

    expect([...above].sort()).toEqual(['b', 'c']);
    expect(afterLast).toBe(false);
  });

  it('draws nothing at all when there are no breaks', () => {
    const { above, afterLast } = conversationBreaks(THREAD, []);

    expect(above.size).toBe(0);
    expect(afterLast).toBe(false);
  });

  it('ignores a break that is not an instant, rather than parking it at the end', () => {
    // `afterLast` would otherwise turn every unreadable value into a visible
    // rule below the thread — a line drawn BECAUSE something was unreadable.
    const { above, afterLast } = conversationBreaks(THREAD, ['not an instant']);

    expect(above.size).toBe(0);
    expect(afterLast).toBe(false);
  });

  it('skips a message it cannot place the break against', () => {
    // An in-flight turn carries no timestamp until it is stamped. It cannot be
    // compared, so the rule goes to the next message that can be — never to the
    // untimed one, which would put it in a place a reload moves.
    const { above } = conversationBreaks(
      [message('a', '2026-03-04T09:00:00Z'), message('pending'), message('c', '2026-03-04T15:00:00Z')],
      ['2026-03-04T10:00:00Z'],
    );

    expect([...above]).toEqual(['c']);
  });
});
