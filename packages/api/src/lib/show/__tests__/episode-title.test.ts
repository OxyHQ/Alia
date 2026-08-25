import { describe, expect, it } from 'vitest';
import { cleanTitle } from '../episode-title';

/**
 * Turning a model's reply into an episode name.
 *
 * Every case here is a shape a model really produces when asked for a title,
 * and every one of them would be STORED verbatim without this — on the row and
 * in the ingest that names the published episode.
 *
 * A live call cannot test any of it: which of these shapes comes back is a
 * property of whichever provider answered, so the assertion has to be on the
 * cleaner rather than on the call.
 */

describe('cleaning a proposed title', () => {
  it('keeps a title that is already one', () => {
    expect(cleanTitle('The trouble with photosynthesis')).toBe(
      'The trouble with photosynthesis',
    );
  });

  it('strips the quotes models wrap titles in', () => {
    expect(cleanTitle('"The trouble with photosynthesis"')).toBe(
      'The trouble with photosynthesis',
    );
    expect(cleanTitle("'The trouble with photosynthesis'")).toBe(
      'The trouble with photosynthesis',
    );
    // Curly quotes, which a model producing prose reaches for more often than
    // straight ones and which a naive `replace(/"/g)` misses entirely.
    expect(cleanTitle('“The trouble with photosynthesis”')).toBe(
      'The trouble with photosynthesis',
    );
    expect(cleanTitle('«La fotosíntesis, explicada»')).toBe('La fotosíntesis, explicada');
  });

  it('strips the label when the model answers the instruction as well as obeying it', () => {
    expect(cleanTitle('Title: How leaves eat light')).toBe('How leaves eat light');
    expect(cleanTitle('Episode title: How leaves eat light')).toBe('How leaves eat light');
    // Case-insensitive, because a model that shouts the label is common.
    expect(cleanTitle('TITLE: How leaves eat light')).toBe('How leaves eat light');
  });

  it('drops a trailing full stop but keeps a question or an exclamation', () => {
    // A title is not a sentence — but "Is anything real?" IS a title, and
    // stripping every terminal mark would maim it.
    expect(cleanTitle('How leaves eat light.')).toBe('How leaves eat light');
    expect(cleanTitle('How leaves eat light...')).toBe('How leaves eat light');
    expect(cleanTitle('Is anything real?')).toBe('Is anything real?');
    expect(cleanTitle('Nobody expected this!')).toBe('Nobody expected this!');
  });

  it('takes the first line when the model offers several', () => {
    expect(cleanTitle('How leaves eat light\nThe green machine\nSunlight, digested')).toBe(
      'How leaves eat light',
    );
  });

  it('refuses an explanation rather than truncating one', () => {
    // Truncating would store a mangled paragraph as somebody's episode name.
    // `null` lets the route fall back to the topic, which is at least the
    // person's own words.
    const essay = 'Here is a great title for your episode. '.repeat(20);
    expect(cleanTitle(essay)).toBeNull();
  });

  it('refuses an empty answer, in every way a model produces one', () => {
    expect(cleanTitle('')).toBeNull();
    expect(cleanTitle('   ')).toBeNull();
    expect(cleanTitle('\n\n')).toBeNull();
    // A reply that is nothing but the label, or nothing but quotes.
    expect(cleanTitle('Title:')).toBeNull();
    expect(cleanTitle('""')).toBeNull();
  });

  it('handles the label and the quotes together, which is the common case', () => {
    expect(cleanTitle('Title: "How leaves eat light."')).toBe('How leaves eat light');
  });

  it('accepts a title exactly at the column limit and refuses one past it', () => {
    // `show_episodes.title` and Syra's own field both cap at 200. A title one
    // character over would be refused by Syra AFTER the row was written here.
    expect(cleanTitle('a'.repeat(200))).toBe('a'.repeat(200));
    expect(cleanTitle('a'.repeat(201))).toBeNull();
  });
});
