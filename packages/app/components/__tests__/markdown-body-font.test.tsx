/**
 * The chat's markdown body face.
 *
 * This is the one surface in the app that can inherit a family from nothing,
 * because both mechanisms one would reach for are unavailable:
 *
 *  - `react-native-markdown-display` is driven by RN STYLE OBJECTS and supports
 *    no `className`, so NativeWind's `--font-sans` never reaches the `<Text>`
 *    elements it renders.
 *  - Bloom's app-wide native default is a `Text.defaultProps` mutation, and
 *    React 19 DROPS `defaultProps` under the automatic JSX runtime Expo compiles
 *    to.
 *
 * The first case measures that React behaviour directly instead of trusting it,
 * so if a future React restores `defaultProps` this file says so rather than
 * silently preserving a stale workaround.
 *
 * The rest is a SOURCE scan, deliberately. Asserting the rendered family would
 * mean mocking `react-native` — which is what the sibling suite has to do to get
 * past RN's Flow-typed `index.js` — and a mocked `Platform.OS` would make the
 * assertion measure the mock rather than the app. What actually needs guarding
 * is that the prop is still PASSED at both call sites and still DERIVED from
 * Bloom's token: deleting either is invisible to `tsc`, because the prop is
 * optional by design (omitting it is correct on web).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import React from 'react';
import { jsx } from 'react/jsx-runtime';
import { describe, expect, it } from 'vitest';

const COMPONENTS = path.resolve(__dirname, '..');

/** Source with comment lines dropped, so a census cannot match its own rationale. */
function code(file: string): string {
  return readFileSync(path.join(COMPONENTS, file), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

describe('React 19 drops defaultProps, which is the reason for all of this', () => {
  function Probe() {
    return null;
  }
  (Probe as unknown as { defaultProps: unknown }).defaultProps = {
    style: { fontFamily: 'Probe' },
  };

  it('honours defaultProps through createElement', () => {
    expect(React.createElement(Probe, {}).props).toEqual({
      style: { fontFamily: 'Probe' },
    });
  });

  it('IGNORES defaultProps through the automatic runtime Expo compiles to', () => {
    // The moment this flips, Bloom's `Text.defaultProps` mutation starts
    // working and the prop threading below can be deleted.
    expect(jsx(Probe, {}).props).toEqual({});
  });
});

describe('the body family is derived from Bloom, not written out', () => {
  const markdown = code('ui/markdown.tsx');

  it('reads Bloom’s own sans token', () => {
    expect(markdown).toContain("from \"@oxyhq/bloom/fonts\"");
    expect(markdown).toMatch(/fontFamilies\.sans\.split\(','\)\[0\]\.trim\(\)/);
  });

  it('never spells the family by hand', () => {
    // A literal here would survive Bloom changing its face, which is the whole
    // point of taking it from the token.
    expect(markdown).not.toContain('BlomusModernus');
  });

  it('leaves web undefined, so the cascade still owns it there', () => {
    expect(markdown).toMatch(/Platform\.OS === 'web' \? undefined :/);
  });
});

describe('every AliaMarkdown call site hands the family over', () => {
  // Anchored on the JSX tag: a call site that renders AliaMarkdown without the
  // prop compiles fine and draws the system face on device.
  const CALL_SITES = ['ui/markdown.tsx', 'ui/reasoning.tsx'] as const;

  it.each(CALL_SITES)('%s passes fontFamily', (file) => {
    const src = code(file);
    const tags = src.match(/<AliaMarkdown[^>]*\/>/g);
    // Positive control: if the tag stops matching, this test would pass while
    // measuring nothing.
    expect(tags, `no <AliaMarkdown …/> found in ${file}`).toBeTruthy();
    for (const tag of tags ?? []) {
      expect(tag).toContain('fontFamily={MARKDOWN_BODY_FONT}');
    }
  });

  it('finds every call site the repo has, so the list above cannot go stale', () => {
    const all = code('ui/markdown.tsx') + code('ui/reasoning.tsx');
    const count = (all.match(/<AliaMarkdown/g) ?? []).length;
    expect(count).toBe(2);
  });
});
