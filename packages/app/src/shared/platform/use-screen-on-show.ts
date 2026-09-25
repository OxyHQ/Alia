import { useIsFocused } from 'expo-router';
import { Platform } from 'react-native';

/**
 * Whether the screen this is called from is the one on show.
 *
 * On iOS and Android the stack keeps a covered screen mounted, so this is the
 * route's focus. On web the app's navigator renders only the focused page
 * (`FocusedPage` in `app/(app)/_layout.tsx`), so a page that is mounted is on
 * show — and the router's own answer there is not usable: it reads `false`
 * for the first renders of a page that is on show. Measured through the
 * visual baseline: pausing the ambient field on it held the welcome field's
 * loops back, and the frames after the entrance moved (Δ10 at t=9000ms).
 */
export function useScreenOnShow(): boolean {
  const isFocused = useIsFocused();
  return Platform.OS === 'web' || isFocused;
}
