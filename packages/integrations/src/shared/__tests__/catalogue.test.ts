/**
 * The bots say the product's words, not an identifier.
 *
 * Every payload below is a verbatim slice of what `https://api.alia.onl`
 * served on 2026-08-19 — the shapes, the `display_name` values still carrying
 * the alias names, and the four `chat_visible` entries. A fixture invented from
 * the types would agree with the parser by construction and measure nothing.
 */

import { describe, expect, it } from 'vitest';
import {
  labelForPreference,
  offeredModes,
  parseCatalogue,
  parseModes,
  presentation,
} from '../catalogue';

/** `GET /catalogue`, trimmed to the fields this module reads. */
const CATALOGUE = {
  object: 'list',
  data: [
    {
      id: 'profile:lite',
      display_name: 'Alia Lite',
      description: 'Fast responses for simple tasks',
      emoji: '⚡',
      chat_visible: true,
      object: 'routing_profile',
      availability: { status: 'available' },
      pricing: { credit_multiplier: 0.5 },
    },
    {
      id: 'profile:v1',
      display_name: 'Alia V1',
      description: 'Balanced performance for everyday tasks',
      emoji: '🤖',
      chat_visible: true,
      object: 'routing_profile',
      availability: { status: 'available' },
      pricing: { credit_multiplier: 1 },
    },
    {
      id: 'profile:v1-pro',
      display_name: 'Codea Pro',
      description: 'Advanced coding assistance',
      emoji: '💻',
      chat_visible: true,
      object: 'routing_profile',
      availability: { status: 'available' },
      pricing: { credit_multiplier: 2 },
    },
    {
      id: 'profile:v1-codea',
      display_name: 'Codea',
      description: 'Coding assistant',
      emoji: '💻',
      chat_visible: false,
      object: 'routing_profile',
      availability: { status: 'available' },
      pricing: { credit_multiplier: 1 },
    },
  ],
};

/** `GET /catalogue/modes`, verbatim for the three modes these entries reach. */
const MODES = {
  object: 'list',
  data: [
    {
      id: 'mode:automatic',
      object: 'product_mode',
      label: 'Automatic',
      description: 'Alia picks how to answer.',
      routing: { kind: 'default' },
      deep_research: false,
    },
    {
      id: 'mode:fast',
      object: 'product_mode',
      label: 'Fast',
      description: 'Quick answers to straightforward questions.',
      routing: { kind: 'profile', profile_id: 'profile:lite' },
      deep_research: false,
    },
    {
      id: 'mode:balanced',
      object: 'product_mode',
      label: 'Balanced',
      description: 'The everyday default: quick enough, capable enough.',
      routing: { kind: 'profile', profile_id: 'profile:v1' },
      deep_research: false,
    },
    {
      id: 'mode:deep-research',
      object: 'product_mode',
      label: 'Deep research',
      description: 'Multi-step research across sources, answered with citations.',
      routing: { kind: 'default' },
      deep_research: true,
    },
  ],
};

const entries = parseCatalogue(CATALOGUE);
const modes = parseModes(MODES);

describe('parsing', () => {
  it('reads every entry and every mode', () => {
    expect(entries).toHaveLength(4);
    expect(modes).toHaveLength(4);
  });

  it('throws rather than reading an unreadable response as an empty one', () => {
    expect(() => parseCatalogue({ object: 'list' })).toThrow();
    expect(() => parseModes({ object: 'list' })).toThrow();
    // Every entry unparseable is a shape break, not an empty catalogue.
    expect(() => parseCatalogue({ object: 'list', data: [{ id: 7 }] })).toThrow();
  });

  it('drops an entry whose object is neither known value', () => {
    const parsed = parseCatalogue({
      object: 'list',
      data: [CATALOGUE.data[0], { id: 'x', display_name: 'X', object: 'something_new' }],
    });
    expect(parsed.map((entry) => entry.id)).toEqual(['profile:lite']);
  });

  it('reads an empty list as an empty list', () => {
    expect(parseCatalogue({ object: 'list', data: [] })).toEqual([]);
  });
});

describe('presentation', () => {
  it("uses the product's word for a profile a mode selects", () => {
    const lite = entries.find((entry) => entry.id === 'profile:lite');
    expect(lite?.displayName).toBe('Alia Lite');
    expect(presentation(lite ?? entries[0], modes).label).toBe('Fast');
  });

  it("falls back to the catalogue's own name for a profile no mode selects", () => {
    const pro = entries.find((entry) => entry.id === 'profile:v1-pro');
    expect(presentation(pro ?? entries[0], modes).label).toBe('Codea Pro');
  });
});

describe('offeredModes', () => {
  const offered = offeredModes(entries, modes);

  it('offers only what the catalogue marks chat-visible', () => {
    expect(offered.map((mode) => mode.id)).toEqual([
      'profile:lite',
      'profile:v1',
      'profile:v1-pro',
    ]);
  });

  it('never puts an alias display name in front of a person', () => {
    // The negative control the whole change exists for: `Alia Lite` and
    // `Alia V1` are in the payload above and must not reach a label.
    expect(offered.map((mode) => mode.label)).toEqual(['Fast', 'Balanced', 'Codea Pro']);
  });
});

describe('labelForPreference', () => {
  it('calls no stored preference by the automatic mode, which is what it is', () => {
    expect(labelForPreference(undefined, entries, modes)).toBe('Automatic');
    expect(labelForPreference(null, entries, modes)).toBe('Automatic');
    expect(labelForPreference('', entries, modes)).toBe('Automatic');
  });

  it('does not mistake deep research for the automatic mode', () => {
    // Both carry `routing.kind === 'default'`; only one sets the flag.
    const deepResearchOnly = modes.filter((mode) => mode.deepResearch || mode.id === 'mode:fast');
    expect(labelForPreference(undefined, entries, deepResearchOnly)).toBeNull();
  });

  it("uses the product's word for a stored profile", () => {
    expect(labelForPreference('profile:lite', entries, modes)).toBe('Fast');
  });

  it('reports no word for a legacy identifier rather than inventing one', () => {
    // A preference saved before `GET /v1/models` closed. It still routes on the
    // server; the product simply has no word for it, and reporting `Fast` here
    // would claim a routing this request does not make.
    expect(labelForPreference('alia-v1-pro-max', entries, modes)).toBeNull();
  });
});
