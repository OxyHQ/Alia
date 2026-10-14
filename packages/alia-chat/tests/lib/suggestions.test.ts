import { describe, expect, it } from 'vitest';
import { composerCompletions } from '../../src/lib/suggestions';

const suggestion = (id: string, text: string) => ({ id, text });
const WELCOME = [suggestion('w1', 'Plan a trip'), suggestion('w2', 'Write a poem')];

describe('composerCompletions', () => {
  it('offers the welcome suggestions while the draft is short', () => {
    expect(composerCompletions(' a ', WELCOME, []).map((row) => row.suggestion)).toEqual(WELCOME);
  });

  it('switches to the matches from two characters, with the typed range', () => {
    const rows = composerCompletions('lis', WELCOME, [suggestion('m1', 'Trip to Lisbon')]);
    expect(rows).toEqual([
      { suggestion: suggestion('m1', 'Trip to Lisbon'), matchStart: 8, matchEnd: 11 },
    ]);
  });

  it('drops repeated texts and stops at six rows', () => {
    const matches = [
      suggestion('a', 'Same'),
      suggestion('b', 'same'),
      ...Array.from({ length: 8 }, (_, i) => suggestion(`m${i}`, `Match ${i}`)),
    ];
    const rows = composerCompletions('ma', [], matches);
    expect(rows).toHaveLength(6);
    expect(rows.filter((row) => row.suggestion.text.toLowerCase() === 'same')).toHaveLength(1);
  });

  it('keeps a match whose text does not contain the draft, unhighlighted', () => {
    const [row] = composerCompletions('xyz', [], [suggestion('m', 'Other')]);
    expect([row!.matchStart, row!.matchEnd]).toEqual([0, 0]);
  });

  it('offers nothing without data', () => {
    expect(composerCompletions('', undefined, undefined)).toEqual([]);
    expect(composerCompletions('abc', undefined, undefined)).toEqual([]);
  });
});
