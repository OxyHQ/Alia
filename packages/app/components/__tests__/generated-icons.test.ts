import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ICONS } from '../../scripts/icons/manifest';
import { OUT_DIR, generate, kebab } from '../../scripts/icons/generate';

/**
 * `components/ui/icons` is generated, and this is what makes that true.
 *
 * The alternative to a gate here is trust: that whoever last touched the
 * manifest re-ran `bun run generate:icons`, and that nobody has since hand-fixed
 * a path in the output. Neither leaves a trace — a stale directory and a fresh
 * one look identical, and an edited path draws a slightly different glyph that
 * no type or test would otherwise notice.
 *
 * `generate()` computes without writing, so this compares the committed bytes to
 * what the sheet says they should be. A generator that wrote first could only
 * ever agree with itself.
 */
describe('the generated icon set is the sheet', () => {
  const expected = generate();
  const onDisk = readdirSync(OUT_DIR).sort();

  it('generates something to compare against', () => {
    // Positive control: an empty map would make every `toBe` below vacuous, and
    // an empty directory would agree with it.
    expect(expected.size).toBe(ICONS.length);
    expect(expected.size).toBeGreaterThan(0);
    expect(onDisk.length).toBeGreaterThan(0);
  });

  it('has exactly the files the manifest asks for, and no strays', () => {
    expect(onDisk).toEqual([...expected.keys()].sort());
  });

  it.each([...expected.keys()])('%s is byte-identical to a fresh run', (file) => {
    expect(readFileSync(join(OUT_DIR, file), 'utf8')).toBe(expected.get(file));
  });

  it('names one component per icon, and never two on one file', () => {
    // The manifest's `name` is what the file and the export are both derived
    // from, so a duplicate would mean one component silently replacing another.
    const files = ICONS.map((icon) => `${kebab(icon.name)}-icon.tsx`);
    expect(new Set(files).size).toBe(files.length);
    expect(new Set(ICONS.map((icon) => icon.id)).size).toBe(ICONS.length);
  });

  it('carries each symbol\'s own viewBox rather than one for all of them', () => {
    // The sheet mixes 16, 20 and 24-unit art. Normalising to one box crops the
    // larger glyphs, so the boxes must still differ after generation — and the
    // ones that must differ are named, so a set that happened to be uniform
    // could not pass by being uniform.
    const boxOf = (name: string) => {
      const source = expected.get(`${kebab(name)}-icon.tsx`);
      if (source === undefined) throw new Error(`no generated ${name}`);
      const box = /viewBox="([^"]+)"/.exec(source);
      if (box === null) throw new Error(`${name} has no viewBox`);
      return box[1];
    };
    expect(boxOf('ChevronDown')).toBe('0 0 16 16');
    expect(boxOf('Plus')).toBe('0 0 20 20');
    expect(boxOf('Microphone')).toBe('0 0 24 24');
  });

  it('takes its colour from the theme, never from the sheet', () => {
    // The sheet has at least one symbol with a brand colour baked in, and the
    // rule in this package is that colour comes from the scheme. Every emitted
    // paint slot is either the tint or an explicit `none`.
    for (const [file, source] of expected) {
      expect(source, file).toContain('color ?? colors.mutedForeground');
      expect(source, file).not.toMatch(/(fill|stroke)="#/);
    }
  });
});
