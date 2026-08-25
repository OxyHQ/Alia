import { describe, expect, it, vi } from 'vitest';

/**
 * Bloom's `theme` entry is a barrel that reaches `react-native` — which has no
 * Node build — through directory imports Node's ESM resolver refuses. The preset
 * registry is a standalone module in the SAME install, so it is loaded from
 * there: what runs here is Bloom's own table, which is the entire point of
 * asserting against it. Same reason and same shape as
 * `components/ui/__tests__/agent-glyph.test.tsx`.
 */
vi.mock('@oxyhq/bloom/theme', async () => {
  const { createRequire } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  const require = createRequire(import.meta.url);
  const entry = pathToFileURL(require.resolve('@oxyhq/bloom'));
  return require(new URL('theme/color-presets.js', entry).pathname);
});

import { APP_COLOR_PRESETS } from '@oxyhq/bloom/theme';

import { agentColorPreset } from '../agent-color';

/**
 * The one place that decides whether an agent's colour names a real preset.
 *
 * It has two consumers that must never disagree: the glyph, which paints the
 * preset's seed, and the thread's `BloomColorScope`, which adopts its whole
 * recipe. They disagreeing about the same value is not a hypothetical — the
 * glyph once validated the key with `parseRgb`, which refuses a word, and every
 * coloured agent rendered grey while the rest of the app thought it had a
 * colour.
 *
 * Asserted against Bloom's own table rather than a list restated here, because
 * a list is the other way the two could drift apart.
 */
describe('an agent colour', () => {
  it('resolves a key Bloom actually has', () => {
    expect(agentColorPreset('violet')).toBe('violet');
    expect(agentColorPreset('mint')).toBe('mint');
    // Not vacuous: these have to be in the table for the assertions to mean
    // anything, and a Bloom that withdrew them should fail here loudly.
    expect(APP_COLOR_PRESETS).toHaveProperty('violet');
    expect(APP_COLOR_PRESETS).toHaveProperty('mint');
  });

  it('resolves every key Bloom offers, so the two never disagree about one', () => {
    const names = Object.keys(APP_COLOR_PRESETS);

    expect(names.length).toBeGreaterThan(10);
    expect(names.filter((name) => agentColorPreset(name) === undefined)).toEqual([]);
  });

  it.each([
    // Oxy resolved the account but it has no colour.
    ['null', null],
    // The identity lookup failed open and resolved nothing at all.
    ['undefined', undefined],
    // A preset withdrawn from a later Bloom, still sitting in the column.
    ['a key that no longer exists', 'ultramarine-neon'],
    // A hex, which is what somebody reaches for when they forget it is a KEY.
    ['a hex', '#7c3aed'],
    // The empty string a form can write.
    ['an empty string', ''],
  ])('gives nothing for %s, which callers read as "inherit"', (_label, value) => {
    expect(agentColorPreset(value)).toBeUndefined();
  });

  it('never hands back a key by trusting the caller', () => {
    // `Object.prototype` members answer `in` on a plain object. A preset table
    // reached with `constructor` or `toString` must not read as a colour.
    expect(agentColorPreset('constructor')).toBeUndefined();
    expect(agentColorPreset('toString')).toBeUndefined();
  });
});
