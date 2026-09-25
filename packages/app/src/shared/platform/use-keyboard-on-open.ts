import { useEffect, useRef } from 'react';
import { Keyboard, Platform, type TextInput } from 'react-native';

/**
 * How often, and how many times, the field asks again: about a second in all,
 * and slower than the keyboard takes to report itself shown, so a request
 * already on its way is not taken back by the next one.
 */
const RETRY_MS = 250;
const MAX_TRIES = 4;

/**
 * The field a dialog opens on, with the keyboard up — on Android too.
 *
 * `autoFocus` focuses the field the moment it mounts, and on Android that is
 * before the dialog's own window (a `<Modal>`) has window focus: the focus
 * ring shows, but the input method refuses the request (`ImeTracker … onFailed
 * at PHASE_CLIENT_VIEW_SERVED`) and the keyboard stays down. Rename, New
 * folder and New project all did it, whichever menu they were opened from
 * (#608, Pixel 8a, `docs/native-validation.mdx`). React Native does not ask
 * again and Bloom's `Dialog` has no "shown" callback to ask from, so this asks
 * again itself until the keyboard is up, for about a second: it lets go of the
 * field and focuses it again, which on Android requests the keyboard anew
 * (a plain `focus()` on a field React Native thinks is focused is skipped).
 *
 * Keep `autoFocus` on the field: it is what focuses it on the web and iOS, and
 * what draws the focus ring at once here. Pass the returned ref as the field's
 * `inputRef`.
 */
export function useKeyboardOnOpen(open: boolean) {
  const ref = useRef<TextInput | null>(null);
  useEffect(() => {
    if (!open || Platform.OS !== 'android') return;
    let tries = 0;
    const timer = setInterval(() => {
      if (Keyboard.isVisible() || tries >= MAX_TRIES) {
        clearInterval(timer);
        return;
      }
      tries += 1;
      const field = ref.current;
      if (field === null) return;
      // React Native's `focus()` does nothing to a field it believes is
      // focused already — and `autoFocus` made it so — so let go first.
      if (field.isFocused()) field.blur();
      field.focus();
    }, RETRY_MS);
    return () => clearInterval(timer);
  }, [open]);
  return ref;
}
