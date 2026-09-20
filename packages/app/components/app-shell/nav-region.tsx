import React from 'react';
import { Platform, View, type ViewProps } from 'react-native';
import { useAiChatShell } from '@oxy.so/bloom/ai-chat';

import { ShellNavProvider } from '@/components/app-shell/shell-nav';

/**
 * `inert`, the only one of these that a keyboard obeys.
 *
 * `aria-hidden` removes a subtree from the accessibility tree and nothing else:
 * every button under it keeps its tab stop, so a screen reader stops announcing
 * the nav while Tab still walks straight into it. `pointerEvents="none"` — what
 * `AiChatShell` sets on its own drawer wrapper — is about the mouse. Neither
 * closes the hole #532 is about, which is that the rows are REACHABLE.
 *
 * `inert` is the one attribute that says all of it at once: not focusable, not
 * reachable by tab, not in the AT tree, not clickable, and not findable by the
 * browser's own find-in-page. react-native-web forwards it (it is listed in
 * `forwardedProps/index.js` beside the `aria-*` set), so this is a plain prop
 * and not a ref poked after render.
 *
 * `tabIndex: -1` rides along, and it is NOT a substitute: on a container it only
 * takes the container itself out of the tab order, never its descendants. It is
 * here for the wrapper's own sake and because a browser too old for `inert`
 * still honours it.
 */
const WEB_INERT = { inert: true, tabIndex: -1 } as unknown as ViewProps;

/**
 * The navigation region: Alia's sidebar, gated for #532, with the shell's own
 * navigation published to everything inside it.
 *
 * ## The gate
 *
 * Below `lg` the nav is `AiChatShell`'s push drawer, and a closed push drawer
 * is not gone — it is a mounted subtree parked 272px to the left behind an
 * opacity of zero. The shell marks its own wrapper `aria-hidden` and
 * `pointerEvents="none"`, which covers the AT tree and the pointer; what no
 * host-agnostic wrapper can cover is the host's tab stops, because the tab
 * stops belong to the rows Alia put in there. So a person on the Library page
 * at 390px could Tab, once, into a navigation they could not see and could not
 * be told about — which is exactly the fault #532 named, and exactly the fault
 * the expo-router `Drawer` had before it.
 *
 * `navPresented` is the signal to gate on, and it is the signal Bloom 3.3.0
 * added FOR this: true from `lg` up, where the nav is a column that is always
 * there, and below it only while the drawer is open. It flips at the moment the
 * open is dispatched, not when the animation ends, so the drawer sliding in is
 * already reachable by the time focus could get to it and nothing here depends
 * on a duration.
 *
 * The guard is written as `shell !== null && !shell.navPresented` rather than
 * `!shell?.navPresented`: with no shell there is no drawer, so there is nothing
 * to hide, and defaulting to hidden would silently delete the sidebar from
 * assistive tech in any context that forgot the shell.
 *
 * ## The provider
 *
 * Folded into the same component on purpose. The sidebar's own collapse control
 * has to close the drawer at narrow widths, so the nav region needs the nav —
 * and a region that is gated on `navPresented` and a provider that publishes
 * `navPresented` are the same idea twice. Separating them would mean two
 * wrappers that must always be used together, which is a rule nothing enforces.
 */
export function NavRegion({ children }: { children: React.ReactNode }) {
  const shell = useAiChatShell();
  const hidden = shell !== null && !shell.navPresented;

  return (
    <View
      style={{ flex: 1 }}
      aria-hidden={hidden}
      importantForAccessibility={hidden ? 'no-hide-descendants' : 'auto'}
      accessibilityElementsHidden={hidden}
      {...(Platform.OS === 'web' && hidden ? WEB_INERT : null)}
    >
      <ShellNavProvider>{children}</ShellNavProvider>
    </View>
  );
}
