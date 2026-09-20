import { describe, expect, it } from 'vitest';

import {
  composerBarState,
  composerWorkingLight,
  imeOwnsEnter,
  EXPAND_ABOVE,
  SINGLE_LINE_TRACK,
  type ComposerBarInput,
  type ComposerWorkingLightInput,
} from '../composer-state';

/**
 * The three answers the composer derives on every keystroke.
 *
 * They lived inside a 677-line component and could only be observed by
 * rendering it, which is why the shapes below — a bar that oscillates near a
 * line wrap, a light lit by nothing — were cheap to introduce and expensive to
 * notice. Here each one is a table.
 */

const bar = (over: Partial<ComposerBarInput> = {}): ComposerBarInput => ({
  isSimpleMode: true,
  isChatComposer: true,
  isFullscreen: false,
  isLargeScreen: true,
  value: '',
  attachmentCount: 0,
  collapsedHeight: SINGLE_LINE_TRACK,
  ...over,
});

const light = (
  over: Partial<ComposerWorkingLightInput> = {},
): ComposerWorkingLightInput => ({
  isLoading: false,
  isDictating: false,
  state: 'collapsed',
  isChatComposer: true,
  ...over,
});

describe('which shape the bar is in', () => {
  it('is one track tall for a short single-line draft', () => {
    expect(composerBarState(bar({ value: 'hola' }))).toBe('collapsed');
  });

  it('gives fullscreen the last word over everything the content says', () => {
    // Fullscreen is entered by pressing the maximize affordance. Nothing about
    // the draft may put the bar back into the other two states while it is up.
    expect(
      composerBarState(
        bar({ isFullscreen: true, value: 'a\nb', attachmentCount: 3, collapsedHeight: 200 }),
      ),
    ).toBe('fullscreen');
  });

  it('expands for a newline, for an attachment, and for text that overflows the track', () => {
    expect(composerBarState(bar({ value: 'one\ntwo' }))).toBe('expanded');
    expect(composerBarState(bar({ attachmentCount: 1 }))).toBe('expanded');
    expect(composerBarState(bar({ collapsedHeight: EXPAND_ABOVE + 1 }))).toBe('expanded');
  });

  it('does not expand AT the threshold, only above it', () => {
    // The boundary is where an oscillation would live, so it is stated rather
    // than left to whichever comparison happened to be typed.
    expect(composerBarState(bar({ collapsedHeight: EXPAND_ABOVE }))).toBe('collapsed');
  });

  it('keeps the chat composer expanded on a small screen whatever the draft says', () => {
    // Model, effort, mic and send cannot share a 44px track with the text on a
    // phone; letting them try clipped every one of them.
    expect(composerBarState(bar({ isLargeScreen: false }))).toBe('expanded');
    expect(composerBarState(bar({ isLargeScreen: false, value: '' }))).toBe('expanded');
  });

  it('leaves a generic input on one track on a small screen', () => {
    // The small-screen rule belongs to the chat composer's trailing cluster.
    // An input with no model control has nothing to make room for.
    expect(composerBarState(bar({ isChatComposer: false, isLargeScreen: false }))).toBe(
      'collapsed',
    );
  });

  it('never expands a bar whose content the caller supplied', () => {
    // With children, the measurements are of a layout this component does not
    // own, so it must not reshape itself around them.
    expect(
      composerBarState(bar({ isSimpleMode: false, value: 'a\nb', attachmentCount: 2 })),
    ).toBe('collapsed');
  });
});

describe('the working light', () => {
  it('is not drawn at all for an input with no stream to wait for', () => {
    // `null` rather than `{ active: false }`: the generic input has no
    // `onStop` and an `isLoading` nothing sets, so mounting an unlit band
    // would buy a layer that can never come on.
    expect(composerWorkingLight(light({ isChatComposer: false, isLoading: true }))).toBeNull();
  });

  it('is not drawn in fullscreen, where it would trace the window', () => {
    expect(composerWorkingLight(light({ state: 'fullscreen', isLoading: true }))).toBeNull();
  });

  it('is drawn unlit while idle, so the fade has something to animate', () => {
    // Bloom's `ComposerLoader` crossfades over 450ms. Unmounting it when the
    // stream ends would cut that to a single frame.
    expect(composerWorkingLight(light())).toEqual({ active: false });
  });

  it('is lit for exactly as long as a turn is in flight', () => {
    expect(composerWorkingLight(light({ isLoading: true }))).toEqual({ active: true });
  });

  it('goes dark while the recorder is listening', () => {
    // During dictation the bar is `dictation-bar.tsx`'s three controls, not the
    // composer — a band around those reports on something the person is not
    // looking at.
    expect(composerWorkingLight(light({ isLoading: true, isDictating: true }))).toEqual({
      active: false,
    });
  });

  it('is still drawn while dictating, so returning to the draft does not pop', () => {
    expect(composerWorkingLight(light({ isDictating: true }))).not.toBeNull();
  });
});

describe('whose Enter it is', () => {
  it('belongs to the input method mid-composition on web', () => {
    // The first Enter of a Japanese, Chinese or Korean sentence accepts the
    // candidate. Sending on it posted half a sentence and left the confirmed
    // word in the empty composer behind it.
    expect(imeOwnsEnter({ isWeb: true, isComposing: true })).toBe(true);
  });

  it('belongs to the composer otherwise', () => {
    expect(imeOwnsEnter({ isWeb: true, isComposing: false })).toBe(false);
  });

  it('is never the input method on native, which reports no such state', () => {
    // `isComposing` is a DOM `KeyboardEvent` field. Reading it off a native
    // key event would be reading a property that is always undefined, so the
    // platform is asked first.
    expect(imeOwnsEnter({ isWeb: false, isComposing: true })).toBe(false);
  });
});
