/**
 * Where a thread changes day, and which day it changed to.
 *
 * This is the DERIVED boundary, and the only one drawn from a timestamp: the
 * clock passed midnight, and nobody decided it. A thread's other boundary — "a
 * new conversation starts here" — is a seam between two conversations, read
 * from which one each message belongs to, so it is not computed here and never
 * from elapsed time. "N hours passed, draw a line" lies the day somebody comes
 * back a week later to continue the same idea.
 *
 * ## The timezone is the client's, and that is the whole difficulty
 *
 * `createdAt` arrives as an ISO instant, which names no day: 23:40 on the 4th
 * in Madrid and 22:40 on the 4th in London are the same instant, and 12:00 UTC
 * is the 1st in Niue and the 2nd in Kiritimati. A separator computed from the
 * UTC calendar is therefore wrong for most of the planet for part of every day,
 * and wrong in the way nobody reports: the line lands an hour off, or a
 * conversation that ran through local midnight shows none at all.
 *
 * So the day of an instant is read through `Date`'s LOCAL accessors, which is
 * the device's own timezone — the one the person reading the thread is in.
 *
 * ## A message with no timestamp draws no line
 *
 * Everything the server sends carries `createdAt`; a message the client has
 * only just appended may not, if it has not made the round trip. Those are
 * skipped rather than assumed to be today, because assuming would draw a line
 * that a reload then removes — and a separator that appears and disappears is
 * worse than one that arrives a moment late.
 */

/** What a separator says. `today` and `yesterday` are named so the caller can translate them. */
export type DaySeparatorLabel =
  | { readonly kind: 'today' }
  | { readonly kind: 'yesterday' }
  | { readonly kind: 'date'; readonly text: string };

export interface DaySeparator {
  /** The id of the message this separator sits directly above. */
  readonly messageId: string;
  readonly label: DaySeparatorLabel;
}

/** The two fields a separator is derived from. */
interface DatedMessage {
  readonly id: string;
  readonly createdAt?: string;
}

/** The local calendar day of an instant, as a key that compares equal only within one day. */
function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** The instant a value names, or `null` if it names none. */
function instant(value: string | undefined): Date | null {
  if (value === undefined) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * How many local days back `date` is from `now`.
 *
 * Counted between local CALENDAR days rather than by subtracting milliseconds:
 * a day is not 24 hours on the two days a year a timezone shifts, and an hour
 * of error on those days would relabel "yesterday" as a date.
 */
function daysBefore(date: Date, now: Date): number {
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const startOfNow = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((startOfNow.getTime() - startOfDate.getTime()) / 86_400_000);
}

function labelFor(date: Date, now: Date, locale: string): DaySeparatorLabel {
  const back = daysBefore(date, now);
  if (back === 0) return { kind: 'today' };
  if (back === 1) return { kind: 'yesterday' };
  return {
    kind: 'date',
    text: new Intl.DateTimeFormat(locale, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      // Only when it is not this year. A year on every line is noise; a year on
      // none of them is a thread that silently spans two.
      ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
    }).format(date),
  };
}

/**
 * The separators a message list needs, in order.
 *
 * One per CHANGE of local day, so two messages on the same day produce none and
 * a pair that straddles local midnight produces one. There is no separator above
 * the first message: it would say "today" on top of every conversation anyone is
 * currently having, which is a label for a boundary that is not there.
 */
export function daySeparators(
  messages: readonly DatedMessage[],
  now: Date,
  locale: string,
): DaySeparator[] {
  const separators: DaySeparator[] = [];
  let previousKey: string | null = null;

  for (const message of messages) {
    const date = instant(message.createdAt);
    if (date === null) continue;

    const key = localDayKey(date);
    if (previousKey !== null && key !== previousKey) {
      separators.push({ messageId: message.id, label: labelFor(date, now, locale) });
    }
    previousKey = key;
  }

  return separators;
}
