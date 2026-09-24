import { describe, expect, it } from 'vitest';
import { RepeatDetector, repeatedToolCallKey } from '../repeat-detector.js';

describe('RepeatDetector', () => {
  it('normalizes arguments and ignores a bare tool name', () => {
    expect(repeatedToolCallKey('browser', '  search   alia\n')).toBe('browser:search alia');
    expect(repeatedToolCallKey('browser', 'browser')).toBeNull();
    expect(repeatedToolCallKey('browser', undefined)).toBeNull();
  });

  it('warns once and hard-stops repeated calls', () => {
    const detector = new RepeatDetector({ warningAt: 2, stopAt: 4 });
    expect(detector.record('turn', 'browser:search alia')).toEqual({ count: 1, warning: false, stop: false });
    expect(detector.record('turn', 'browser:search alia')).toEqual({ count: 2, warning: true, stop: false });
    expect(detector.record('turn', 'browser:search alia')).toEqual({ count: 3, warning: false, stop: false });
    expect(detector.record('turn', 'browser:search alia')).toEqual({ count: 4, warning: false, stop: true });
  });

  it('forgets a settled turn', () => {
    const detector = new RepeatDetector();
    detector.record('turn', 'browser:refresh');
    detector.settle('turn');
    expect(detector.record('turn', 'browser:refresh').count).toBe(1);
  });
});
