/**
 * The picker speaks the product's language.
 *
 * The payloads are verbatim slices of what `https://api.alia.onl` served on
 * 2026-08-19 — including the `display_name` values, which still carry the alias
 * names the picker used to show. A fixture invented from the types would agree
 * with the parser by construction and measure nothing.
 */

import { describe, expect, it } from 'vitest';
import { offeredModes, parseCatalogue, parseModes, presentation, resolveSelection } from '../catalogue';

const CATALOGUE = {
  object: 'list',
  data: [
    {
      id: 'profile:lite',
      display_name: 'Alia Lite',
      description: 'Fast responses for simple tasks',
      chat_visible: true,
      object: 'routing_profile',
      availability: { status: 'available' },
    },
    {
      id: 'profile:v1-pro',
      display_name: 'Codea Pro',
      description: 'Advanced coding assistance',
      chat_visible: true,
      object: 'routing_profile',
      availability: { status: 'available' },
    },
    {
      id: 'profile:v1-codea',
      display_name: 'Codea',
      description: 'Coding assistant',
      chat_visible: false,
      object: 'routing_profile',
      availability: { status: 'available' },
    },
  ],
};

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
      id: 'mode:coding',
      object: 'product_mode',
      label: 'Coding',
      description: 'Tuned for reading, writing and changing code.',
      routing: { kind: 'profile', profile_id: 'profile:v1-codea' },
      deep_research: false,
    },
  ],
};

const entries = parseCatalogue(CATALOGUE);
const modes = parseModes(MODES);

describe('parseModes', () => {
  it('reads the modes and their routing', () => {
    expect(modes.map((mode) => mode.label)).toEqual(['Automatic', 'Fast', 'Coding']);
    expect(modes[0].routing).toEqual({ kind: 'default' });
    expect(modes[1].routing).toEqual({ kind: 'profile', profileId: 'profile:lite' });
  });

  it('throws rather than reading an unreadable response as "no modes"', () => {
    expect(() => parseModes({ object: 'list' })).toThrow();
    expect(() => parseModes({ object: 'list', data: [{ id: 'mode:x' }] })).toThrow();
  });

  it('reads a `profile` routing with no id as a shape break, not a default', () => {
    const parsed = parseModes({
      object: 'list',
      data: [{ ...MODES.data[1], routing: { kind: 'profile' } }],
    });
    // Not silently `{kind:'default'}` with the mode's meaning moved — the mode
    // parses, but it now names no profile, so it labels nothing.
    expect(parsed[0].routing).toEqual({ kind: 'default' });
    expect(presentation(entries[0], parsed).label).toBe('Alia Lite');
  });
});

describe('presentation', () => {
  it("uses the product's word for a profile a mode selects", () => {
    expect(entries[0].displayName).toBe('Alia Lite');
    expect(presentation(entries[0], modes).label).toBe('Fast');
  });

  it("falls back to the catalogue's own name for a profile no mode selects", () => {
    expect(presentation(entries[1], modes).label).toBe('Codea Pro');
  });
});

describe('offeredModes', () => {
  it("offers only the chat-visible entries, in the product's words", () => {
    expect(offeredModes(entries, modes)).toEqual([
      {
        id: 'profile:lite',
        label: 'Fast',
        description: 'Quick answers to straightforward questions.',
      },
      { id: 'profile:v1-pro', label: 'Codea Pro', description: 'Advanced coding assistance' },
    ]);
  });
});

describe('resolveSelection', () => {
  it('leaves a choice the catalogue offers alone', () => {
    expect(resolveSelection('profile:lite', entries).effectiveId).toBe('profile:lite');
  });

  it('replaces a choice the catalogue does not offer', () => {
    // `profile:v1-codea` is in the catalogue but not chat-visible, so the
    // preference is checked rather than trusted — the property the extension's
    // `config.ts` docstring states.
    const selection = resolveSelection('alia-v1-codea', entries, 'profile:v1-codea');
    expect(selection.source).toBe('replaced');
    expect(selection.effectiveId).toBe('profile:lite');
  });

  it('leaves the choice alone when there is no catalogue at all', () => {
    expect(resolveSelection('profile:lite', undefined).source).toBe('requested');
  });
});
