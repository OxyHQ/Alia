import { Platform } from "react-native";

/**
 * Where keyboard focus goes back to when the execution panel closes.
 *
 * The panel is opened from a row in the conversation — a tool step, the
 * sources row, the reasoning trigger — and on the web the desktop rail is not
 * a dialog: nothing moves focus into it and nothing would move it back. So a
 * screen-reader or keyboard user who opened it and pressed Escape was left
 * with focus wherever the browser had put it, which after a click on a
 * `Pressable` is `body` in Safari. The opener is remembered here at open time
 * and focused again at close.
 *
 * One slot, module-level: there is one panel, and the store's own selection
 * already says which message it is about. A DOM element in the store would
 * also be a DOM element in a persisted store's state tree, which it must not
 * be.
 */
type Focusable = { focus: () => void };

let opener: Focusable | null = null;

function isFocusable(value: unknown): value is Focusable {
  return typeof value === "object" && value !== null && typeof (value as { focus?: unknown }).focus === "function";
}

/**
 * Remember what opened the panel. A caller with a ref to its own control
 * passes it; one without (a memoised row whose ref would be one more prop)
 * lets this read the element that is focused right now, which on the web is
 * the button that was just activated by keyboard, and the button or `body`
 * after a pointer press depending on the browser. Nothing is remembered on
 * native, where focus does not work this way.
 */
export function rememberOpener(candidate?: unknown): void {
  if (isFocusable(candidate)) {
    opener = candidate;
    return;
  }
  if (Platform.OS === "web" && typeof document !== "undefined" && isFocusable(document.activeElement)) {
    opener = document.activeElement;
    return;
  }
  opener = null;
}

/** Focus the remembered opener, once, and forget it. */
export function restoreOpenerFocus(): void {
  const target = opener;
  opener = null;
  if (target === null) return;
  try {
    target.focus();
  } catch {
    // An element that has since left the document cannot take focus; there
    // is nowhere better to send it.
  }
}
