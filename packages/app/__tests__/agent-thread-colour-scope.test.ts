import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The colour scope must not also lay the screen out.
 *
 * `BloomColorScope` renders its own wrapper unless told not to, and the two
 * platforms disagree about what that wrapper is. Native gives it
 * `{flex: 1}`; **web gives it a bare `<div style={vars}>` with no flex**, which
 * collapses to its content height inside a flex column and lifts the whole
 * conversation to the top of the panel.
 *
 * That shipped for an afternoon. The wrapper tinted everything correctly the
 * whole time — every colour I measured was right — so nothing that looked at
 * colour could see it, and only an agent WITH a colour showed it at all, since
 * `undefined` renders no wrapper.
 *
 * So the shape is asserted: `asChild`, over a child that carries `flex-1`.
 * Measured in Chromium at an 800px viewport, and this is what the numbers are:
 *
 *   | wrapper                | greeting top | composer top |
 *   |------------------------|--------------|--------------|
 *   | `asChild` + `flex-1`   | 360          | 732          |
 *   | no `asChild`           | 84           | 180          |
 *   | `asChild`, no `flex-1` | 84           | 180          |
 *
 * A browser is the only place those are visible, so what CI can hold is the
 * shape that produces them. It is narrow on purpose: a restructure that trips
 * it should be read, not silenced.
 */

const SOURCE = readFileSync(
  fileURLToPath(new URL('../app/(app)/[username].tsx', import.meta.url)),
  'utf8',
);

/** The `<BloomColorScope …>` opening tag and the element that follows it. */
function scopeAndChild(text: string): string {
  const start = text.indexOf('<BloomColorScope');
  if (start === -1) throw new Error('no <BloomColorScope> in the agent thread screen');
  const childEnd = text.indexOf('>', text.indexOf('<', text.indexOf('>', start) + 1));
  if (childEnd === -1) throw new Error('the <BloomColorScope> has no child element');
  return text.slice(start, childEnd + 1);
}

describe('the agent thread’s colour scope', () => {
  const opening = scopeAndChild(SOURCE);

  it('is read at all', () => {
    // The guard against asserting over an empty string: every check below would
    // pass on one, and would keep passing after the element was renamed away.
    expect(opening).toContain('colorPreset');
    expect(SOURCE.length).toBeGreaterThan(1000);
  });

  it('renders no wrapper of its own', () => {
    expect(opening).toContain('asChild');
  });

  it('hands `asChild` an element that fills the panel', () => {
    expect(opening).toMatch(/className="[^"]*\bflex-1\b/);
  });

  /**
   * Break the scope element ONLY.
   *
   * Two earlier attempts at these controls broke something else: an exact class
   * string that stopped matching when `bg-background` joined the list, and then
   * a loose one that hit the FIRST `flex-1` in the file — which belongs to the
   * loading state twenty lines up, not to the scope. Both left the subject
   * untouched while reporting they had changed it.
   */
  function withBrokenScope(edit: (opening: string) => string): string {
    const opening = scopeAndChild(SOURCE);
    return SOURCE.replace(opening, edit(opening));
  }

  it.each([
    ['without asChild', withBrokenScope((o) => o.replace(' asChild', ''))],
    ['without flex-1', withBrokenScope((o) => o.replace(/\bflex-1\s*/, ''))],
  ])('would catch a scope %s', (_label, broken) => {
    // Both controls, because the two spellings of this bug produce the same
    // collapsed screen and either one alone would leave the other unguarded.
    expect(broken).not.toBe(SOURCE);

    const brokenOpening = scopeAndChild(broken);
    const sound = brokenOpening.includes('asChild')
      && /className="[^"]*\bflex-1\b/.test(brokenOpening);

    expect(sound).toBe(false);
  });
});
