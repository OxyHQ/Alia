import { describe, expect, it } from 'vitest';
import { formatBytes, parentPath, viewportPoint } from '@/features/agents/model/computer';

describe('viewportPoint', () => {
  it('maps a press on the drawn screenshot to the 1280×800 page', () => {
    expect(viewportPoint({ x: 160, y: 100 }, { width: 640, height: 400 })).toEqual({
      x: 320,
      y: 200,
    });
    expect(viewportPoint({ x: 0, y: 0 }, { width: 320, height: 200 })).toEqual({ x: 0, y: 0 });
  });

  it('clamps an edge press onto the page', () => {
    expect(viewportPoint({ x: 640, y: 400 }, { width: 640, height: 400 })).toEqual({
      x: 1279,
      y: 799,
    });
    expect(viewportPoint({ x: -5, y: 9999 }, { width: 640, height: 400 })).toEqual({
      x: 0,
      y: 799,
    });
  });

  it('answers nothing before the image has a size', () => {
    expect(viewportPoint({ x: 1, y: 1 }, { width: 0, height: 0 })).toBeNull();
  });
});

describe('parentPath', () => {
  it('walks up inside /workspace and stops there', () => {
    expect(parentPath('/workspace/downloads/a')).toBe('/workspace/downloads');
    expect(parentPath('/workspace/downloads')).toBe('/workspace');
    expect(parentPath('/workspace')).toBeNull();
    expect(parentPath('/etc')).toBeNull();
  });
});

describe('formatBytes', () => {
  it('reads like a file size', () => {
    expect(formatBytes(12)).toBe('12 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
