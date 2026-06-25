/**
 * Minimal cross-platform event shape for press/click handlers.
 *
 * Sidebar row actions receive either a web `MouseEvent`/synthetic event or an
 * RN `GestureResponderEvent`; the only member they use is `stopPropagation`.
 */
export interface StopPropagationEvent {
  stopPropagation?: () => void;
}
