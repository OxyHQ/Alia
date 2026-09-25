import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_ROOT } from '@/shared/testing/app-root';

/**
 * On Android, `autoFocus` inside a dialog focused the field but left the
 * keyboard down: the input method refused a request made before the dialog's
 * window had focus (#608, Pixel 8a — Rename, New folder). The hook asks again
 * until the keyboard is up.
 */

const rn = vi.hoisted(() => ({ os: 'android', visible: false }));

vi.mock('react-native', () => ({
  Platform: { get OS() { return rn.os; } },
  Keyboard: { isVisible: () => rn.visible },
}));

import { useKeyboardOnOpen } from '../use-keyboard-on-open';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer;
/** A field `autoFocus` has already focused: React Native skips `focus()` on it. */
let focused = true;
const focus = vi.fn(() => {
  focused = true;
});
const blur = vi.fn(() => {
  focused = false;
});

function mount(open: boolean) {
  function Harness() {
    const ref = useKeyboardOnOpen(open);
    ref.current = { focus, blur, isFocused: () => focused } as never;
    return null;
  }
  act(() => {
    renderer = create(<Harness />);
  });
}

describe('useKeyboardOnOpen', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    focus.mockClear();
    blur.mockClear();
    focused = true;
    rn.os = 'android';
    rn.visible = false;
  });
  afterEach(() => {
    act(() => renderer.unmount());
    vi.useRealTimers();
  });

  it('lets go of the focused field and focuses it again until the keyboard is up, then stops', () => {
    mount(true);
    act(() => void vi.advanceTimersByTime(500));
    expect(blur).toHaveBeenCalledTimes(2);
    expect(focus).toHaveBeenCalledTimes(2);
    expect(blur.mock.invocationCallOrder[0]).toBeLessThan(focus.mock.invocationCallOrder[0]!);
    rn.visible = true;
    act(() => void vi.advanceTimersByTime(2_000));
    expect(focus).toHaveBeenCalledTimes(2);
  });

  it('gives up after about a second', () => {
    mount(true);
    act(() => void vi.advanceTimersByTime(5_000));
    expect(focus).toHaveBeenCalledTimes(4);
  });

  it('does nothing while closed, or where autoFocus is enough', () => {
    mount(false);
    act(() => void vi.advanceTimersByTime(1_000));
    act(() => renderer.unmount());
    rn.os = 'ios';
    mount(true);
    act(() => void vi.advanceTimersByTime(1_000));
    expect(focus).not.toHaveBeenCalled();
  });

  it('is what the rename, folder and project dialogs open with', () => {
    const read = (path: string) => readFileSync(join(APP_ROOT, path), 'utf8');
    const menus = read('src/shell/sidebar-menus.tsx');
    expect(menus).toMatch(/inputRef=\{titleInput\}/);
    expect(menus).toMatch(/inputRef=\{folderInput\}/);
    expect(read('src/features/projects/ui/project-edit-dialog.tsx')).toMatch(/inputRef=\{nameInput\}/);
  });
});
