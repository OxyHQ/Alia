import { describe, expect, it } from 'vitest';
import { RepeatDetector, repeatedToolCallKey } from '../repeat-detector.js';

describe('RepeatDetector', () => {
  it('normalizes arguments and ignores a bare tool name', () => {
    expect(repeatedToolCallKey('shell', '  bun   test\n')).toBe('shell:bun test');
    expect(repeatedToolCallKey('shell', 'shell')).toBeNull();
    expect(repeatedToolCallKey('shell', undefined)).toBeNull();
  });

  it('warns once and hard-stops repeated calls', () => {
    const detector = new RepeatDetector({ warningAt: 2, stopAt: 4 });
    expect(detector.record('turn', 'shell:bun test')).toEqual({ count: 1, warning: false, stop: false });
    expect(detector.record('turn', 'shell:bun test')).toEqual({ count: 2, warning: true, stop: false });
    expect(detector.record('turn', 'shell:bun test')).toEqual({ count: 3, warning: false, stop: false });
    expect(detector.record('turn', 'shell:bun test')).toEqual({ count: 4, warning: false, stop: true });
  });

  it('forgets a settled turn', () => {
    const detector = new RepeatDetector();
    detector.record('turn', 'browser:refresh');
    detector.settle('turn');
    expect(detector.record('turn', 'browser:refresh').count).toBe(1);
  });
});
