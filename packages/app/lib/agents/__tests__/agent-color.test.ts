import { describe, expect, it, vi } from 'vitest';

/**
 * Bloom's `theme` entry is a barrel that reaches `react-native` — which has no
 * Node build — through directory imports Node's ESM resolver refuses. The preset
 * registry and the colour utilities are standalone modules in the SAME install,
 * so they are loaded from there: what runs here is Bloom's own table and Bloom's
 * own `parseRgb`, which is the entire point of asserting against them.
 */
vi.mock('@oxyhq/bloom/theme', async () => {
  const { createRequire } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  const require = createRequire(import.meta.url);
  const entry = pathToFileURL(require.resolve('@oxyhq/bloom'));
  const from = (module: string) => require(new URL(`theme/${module}.js`, entry).pathname);
  return { ...from('color-utils'), ...from('color-presets') };
});

import { APP_COLOR_PRESETS } from '@oxyhq/bloom/theme';

import { AGENT_SWATCHES } from '@/lib/constants/agent-colors';
import { agentColorPreset, agentTint } from '../agent-color';

/** The theme's own, which every unresolved colour falls back to. */
const MUTED = 'rgb(113 113 122)';
const THEME = { mutedForeground: MUTED };

/**
 * The one place that decides whether an agent's colour names a real preset.
 *
 * It has two consumers that must never disagree: `agentTint`, which paints the
 * mark with the preset's seed, and the thread's `BloomColorScope`, which adopts
 * its whole recipe. They disagreeing about the same value is not a hypothetical
 * — the mark once validated the key with `parseRgb`, which refuses a word, and
 * every coloured agent rendered grey while the rest of the app thought it had a
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

/**
 * What an agent's mark is actually painted with.
 *
 * The mark itself takes a colour and nothing else — it is the same component
 * Alia's welcome draws — so this function is the whole of an agent's end of it,
 * and every surface that shows an agent goes through it. Two of them resolving
 * the same agent differently is the failure it exists to prevent.
 *
 * Both failures pinned here are silent. Not resolving the preset paints every
 * agent in the theme's grey, which looks exactly like the honest fallback. And
 * passing an unresolved value through is worse: an SVG `fill` that SVG cannot
 * parse renders BLACK, which looks like a design choice.
 */
describe('the colour an agent is painted in', () => {
  it('resolves the Bloom preset key Oxy stores into the colour it seeds', () => {
    const { hex } = APP_COLOR_PRESETS.violet;

    expect(agentTint('violet', THEME)).toBe(hex);
    // Not vacuous: the assertion above would hold on the fallback if the preset
    // happened to seed the theme's own colour.
    expect(hex).not.toBe(MUTED);
  });

  it('paints a literal colour too, for anything that wrote one to that column', () => {
    expect(agentTint('#7c3aed', THEME)).toBe('#7c3aed');
  });

  it('accepts the rgb form Bloom itself emits, not only hex', () => {
    expect(agentTint('rgb(255 0 0)', THEME)).toBe('rgb(255 0 0)');
  });

  it.each([
    // Oxy resolved the account but it has no colour set.
    ['null', null],
    // Oxy resolved nothing at all: the identity lookup failed open.
    ['undefined', undefined],
    // A word that is neither a preset nor a colour. Untrusted, and the reason
    // for checking at all: passed through, it would paint black.
    ['a word that is neither', 'sunset'],
    // The empty string a form can write into the column.
    ['an empty string', ''],
  ])('falls back to the theme when the colour is %s', (_label, color) => {
    expect(agentTint(color, THEME)).toBe(MUTED);
  });
});

/**
 * Every colour the picker offers paints a real one.
 *
 * The static gate `scripts/check-agent-colour-vocabulary.mjs` holds the two
 * declarations of this vocabulary equal and proves each key is one Oxy will
 * STORE. It cannot answer this half: whether the key RESOLVES. Those are two
 * different Bloom exports — the gate reads `FREE_COLOR_NAMES`, and this resolves
 * through `APP_COLOR_PRESETS`, a map built from different entries — so a key
 * present in one and absent from the other is a swatch that saves correctly and
 * draws in the theme's grey.
 *
 * That is not a hypothetical pairing of exports. It is the failure this already
 * had: every agent grey, every half self-consistent, nothing red.
 */
describe('the colours the editor offers', () => {
  it('paints each one, rather than falling back', () => {
    // The floor. An empty or unreadable list makes the loop below assert
    // nothing at all.
    expect(AGENT_SWATCHES.length).toBeGreaterThan(1);

    for (const swatch of AGENT_SWATCHES) {
      const painted = agentTint(swatch, THEME);
      expect(painted, `${swatch} does not resolve, so its swatch is the theme's grey`).not.toBe(
        MUTED,
      );
      expect(painted, `${swatch} resolves to no colour at all`).toBe(
        APP_COLOR_PRESETS[swatch].hex,
      );
    }
  });

  it('gives no two of them the same colour', () => {
    // Otherwise the picker shows two swatches a person cannot tell apart, and
    // the assertion above holds for a list that is one colour repeated.
    const painted = AGENT_SWATCHES.map((swatch) => agentTint(swatch, THEME));

    expect(new Set(painted).size).toBe(AGENT_SWATCHES.length);
  });
});
