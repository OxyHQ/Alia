import { describe, expect, it } from 'vitest';
import { bubbleColors } from '../../src/lib/bubble-colors';

describe('bubbleColors', () => {
  it("mixes the agent's colour 24% toward black", () => {
    // Grok's example: #00C972 at 76% over black.
    expect(bubbleColors('#00C972')?.background).toBe('#009957');
    expect(bubbleColors('00C972')?.background).toBe('#009957');
  });

  it('puts white text on a deep colour', () => {
    expect(bubbleColors('#00C972')?.foreground).toBe('#ffffff');
    expect(bubbleColors('#3b3bd6')?.foreground).toBe('#ffffff');
  });

  it('puts dark text on a light colour, so a yellow agent stays readable', () => {
    expect(bubbleColors('#ffd838')?.foreground).toBe('#14110f');
    expect(bubbleColors('#f5f5f5')?.foreground).toBe('#14110f');
  });

  it('is nothing for what is not a #rrggbb colour', () => {
    expect(bubbleColors('')).toBeNull();
    expect(bubbleColors('orchid')).toBeNull();
    expect(bubbleColors('#fff')).toBeNull();
  });
});
