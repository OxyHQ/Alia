// Web shim for `react-native-screens` (native-only navigation primitives).
// An empty module is not enough: consumers use *named* imports, which are
// link-time errors in dev's raw ESM serving (Rollup builds only warn).
// `sonner-native`'s toaster wraps its iOS overlay in FullWindowOverlay; on web
// rendering straight through is the correct behavior.
export function FullWindowOverlay({ children }) {
  return children;
}
