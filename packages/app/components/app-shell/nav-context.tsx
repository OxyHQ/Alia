import React from 'react';

/**
 * The navigation, as everything that is not the shell sees it.
 *
 * ## Why Alia has its own name for Bloom's state
 *
 * `useAiChatShell()` already publishes all of this, and one honest reading of
 * this file is "a context that forwards a context". It exists for two reasons,
 * and both are load-bearing.
 *
 * The first is the import graph. `DrawerToggle` is rendered by six screens and
 * by the settings header; `ChatHeader` re-renders ~20x/s while a reply streams.
 * Having each of them reach for `@oxy.so/bloom/ai-chat` pulls the whole
 * ai-chat barrel — the code panel, the gallery, the message parts, reanimated
 * and svg underneath them — into every one of those modules and into every
 * test that mounts one. The shell imports it once; the leaves import three
 * lines of React.
 *
 * The second is that "open the navigation" is a stable thing to ask for and
 * `AiChatShell` is not the only possible answer. It replaced
 * `navigation.toggleDrawer()`, which was the previous answer and was wired
 * straight into seven call sites; when the drawer went, all seven broke at
 * once. This is the seam that means the next one costs one file.
 */
export interface AppNav {
  /**
   * The nav is a column in the layout rather than a drawer — from 1024 up.
   * A control that only makes sense over a drawer (a hamburger) is hidden
   * here; a control that only makes sense over a column (the rail collapse)
   * is shown.
   */
  inFlow: boolean;
  /**
   * The nav is on screen AT ALL: in flow, or a drawer that is open.
   *
   * This is the #532 signal. A closed drawer is mounted and translated
   * offscreen, not removed, so "not presented" is exactly the state in which
   * its rows must stop being focusable and stop being read aloud.
   */
  presented: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
}

/**
 * What a component gets with no shell above it.
 *
 * Not a throw, and the reason is that Alia's tests mount screens on their own —
 * `library.tsx` with four mocks and no navigator anywhere — and a screen that
 * cannot render outside its layout is a screen nothing can test. So the
 * fallback says the truthful thing for a subtree that is not in a shell: there
 * is no drawer here, nothing is presented, and asking to open one does nothing.
 *
 * The risk this carries is that a REAL screen silently loses its opener if the
 * provider ever stops being rendered, which would be #532 wearing a disguise.
 * That is why `app/(app)/__tests__/library-drawer-toggle.test.tsx` pins the
 * provider being wired in `_layout.tsx` as well as the toggle behaving inside
 * one — the fallback is allowed to be quiet only because something else is
 * loud.
 */
const NO_NAV: AppNav = Object.freeze({
  inFlow: false,
  presented: false,
  open: () => undefined,
  close: () => undefined,
  toggle: () => undefined,
});

const AppNavContext = React.createContext<AppNav>(NO_NAV);

export const AppNavProvider = AppNavContext.Provider;

/** The enclosing shell's navigation. See {@link AppNav}. */
export function useAppNav(): AppNav {
  return React.useContext(AppNavContext);
}
