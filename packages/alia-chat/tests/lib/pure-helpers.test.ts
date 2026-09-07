import { describe, expect, it } from 'vitest';

import { getImagesFromContent, getTextFromContent } from '../../src/lib/content-utils';
import { getResearchActiveLabel, getToolActiveLabel, getToolLabel } from '../../src/lib/tool-registry';
import { errorMessage, formatFileSize } from '../../src/lib/utils';

/**
 * The SDK's pure helpers.
 *
 * ## Why these, and why now
 *
 * `@alia.onl/sdk` publishes to npm as RAW SOURCE, so every consumer compiles
 * these files with their own bundler — there is no build step here that would
 * catch a mistake first. Its four existing test files reach `useAliaChat`,
 * `chat-stream` and `chat-transport` and nothing else; `content-utils`,
 * `tool-registry` and `utils` are exported from the package root
 * (`src/index.ts`) and had no coverage at all.
 *
 * These are small functions, which is exactly why they are worth pinning: they
 * are called on every message and every attachment, they fail by returning a
 * plausible-looking wrong string rather than by throwing, and nobody reads them
 * again once they work in the common case.
 *
 * `formatFileSize` was one such failure, and its cases below are written from
 * the defect rather than from the happy path.
 */

describe('getTextFromContent', () => {
  it('returns a plain string as-is', () => {
    expect(getTextFromContent('hello')).toBe('hello');
    expect(getTextFromContent('')).toBe('');
  });

  it('joins the text parts of a multi-part message, in order', () => {
    expect(
      getTextFromContent([
        { type: 'text', text: 'one ' },
        { type: 'image_url', image_url: { url: 'https://example.invalid/a.png' } },
        { type: 'text', text: 'two' },
      ]),
    ).toBe('one two');
  });

  it('treats a text part with no text as empty rather than as "undefined"', () => {
    expect(getTextFromContent([{ type: 'text' }, { type: 'text', text: 'x' }])).toBe('x');
  });

  it('answers empty for absent content', () => {
    expect(getTextFromContent(null)).toBe('');
    expect(getTextFromContent(undefined)).toBe('');
    expect(getTextFromContent([])).toBe('');
  });
});

describe('getImagesFromContent', () => {
  it('collects the image urls, in order', () => {
    expect(
      getImagesFromContent([
        { type: 'image_url', image_url: { url: 'a' } },
        { type: 'text', text: 'between' },
        { type: 'image_url', image_url: { url: 'b' } },
      ]),
    ).toEqual(['a', 'b']);
  });

  it('skips an image part with no url rather than emitting undefined', () => {
    // These reach an `<Image source={{ uri }} />`, where `undefined` is a
    // broken image rather than an error anyone sees.
    expect(
      getImagesFromContent([
        { type: 'image_url' },
        { type: 'image_url', image_url: {} },
        { type: 'image_url', image_url: { url: 'good' } },
      ]),
    ).toEqual(['good']);
  });

  it('answers empty for a string or absent content', () => {
    expect(getImagesFromContent('just text')).toEqual([]);
    expect(getImagesFromContent(null)).toEqual([]);
  });
});

describe('the tool registry', () => {
  it('labels a known tool and falls back to the raw name', () => {
    expect(getToolLabel('webSearch')).toBe('Searching the web');
    expect(getToolLabel('somethingNewTheServerAdded')).toBe('somethingNewTheServerAdded');
  });

  it('adds the ellipsis only for a tool it knows', () => {
    // The active label drives a spinner caption. Returning `'undefined...'` for
    // an unknown tool would put that on screen.
    expect(getToolActiveLabel('webSearch')).toBe('Searching the web...');
    expect(getToolActiveLabel('unknownTool')).toBeUndefined();
  });

  it('is not fooled by a prototype-shaped tool name', () => {
    /**
     * The tool name comes off the wire, and these are plain object literals —
     * so `TOOL_REGISTRY['constructor']` is `Object.prototype`'s, a function
     * rather than a miss.
     *
     * The two tool lookups survived this before the guard existed, but only
     * because `?.label` on a function is `undefined`, which is luck.
     * `getResearchActiveLabel` had no such accident and returned the
     * `Object` constructor itself for `phase = 'constructor'` — straight into a
     * caption. All three go through `Object.hasOwn` now. The API states the
     * same rule for its own lookups (`prototype-keyed-lookups.test.ts`).
     */
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      expect(getToolLabel(name), name).toBe(name);
      expect(getToolActiveLabel(name), name).toBeUndefined();
    }
  });

  it('labels the research phases it knows, and nothing else', () => {
    expect(getResearchActiveLabel('searching')).toBe('Searching sources...');
    expect(getResearchActiveLabel('constructor')).toBeUndefined();
    expect(getResearchActiveLabel('not-a-phase')).toBeUndefined();
  });
});

describe('formatFileSize', () => {
  it('picks the right unit across the ordinary range', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(1)).toBe('1 B');
    expect(formatFileSize(999)).toBe('999 B');
    expect(formatFileSize(1024)).toBe('1 KB');
    expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(formatFileSize(1024 * 1024)).toBe('1 MB');
    expect(formatFileSize(1024 * 1024 * 1024)).toBe('1 GB');
  });

  it('does not run off the end of the unit table', () => {
    // A terabyte read `1 undefined`: the index is `Math.floor(log(bytes)/log(1024))`,
    // which is unbounded, and the table stopped at GB.
    expect(formatFileSize(1024 ** 4)).toBe('1 TB');
    expect(formatFileSize(1024 ** 5)).toBe('1024 TB');
    expect(formatFileSize(Number.MAX_SAFE_INTEGER)).toMatch(/ TB$/);
  });

  it('does not run off the START of the unit table either', () => {
    // `attachment.size` is a number from the platform and can be fractional.
    // Below one byte, `log(bytes)` is negative, so the index was `-1` and the
    // unit was `undefined` again. Clamped to index 0, a fractional size now
    // reads in bytes.
    expect(formatFileSize(0.5)).toBe('0.5 B');
    expect(formatFileSize(0.0001)).toBe('0 B');
  });

  it('answers something readable for a size that is not a size', () => {
    // `Math.log` of a negative is NaN, and `sizes[NaN]` is undefined — so these
    // rendered as `NaN undefined` next to the file name.
    for (const value of [-1, -1024, NaN, Infinity, -Infinity]) {
      expect(formatFileSize(value), String(value)).toBe('0 B');
    }
  });
});

describe('errorMessage', () => {
  it('reads an Error', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('reads a message off a plain object, which is what fetch rejections are', () => {
    expect(errorMessage({ message: 'from the server' })).toBe('from the server');
  });

  it('passes a thrown string through', () => {
    expect(errorMessage('a bare string')).toBe('a bare string');
  });

  it('falls back rather than rendering "undefined" or "[object Object]"', () => {
    expect(errorMessage(null)).toBe('Something went wrong');
    expect(errorMessage(undefined)).toBe('Something went wrong');
    expect(errorMessage({})).toBe('Something went wrong');
    expect(errorMessage(42, 'custom fallback')).toBe('custom fallback');
  });
});
