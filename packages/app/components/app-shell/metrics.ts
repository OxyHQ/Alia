import { useWindowDimensions } from 'react-native';

/**
 * Where the navigation stops being a column and becomes a drawer.
 *
 * 1024, because that is `AiChatShell`'s own `SIDEBAR_BREAKPOINT`, and the shell
 * decides this — not Alia. Below it the shell renders `mobileSidebar` as a push
 * drawer whatever anyone here would prefer, so a second opinion in this repo
 * would not be a preference, it would be a bug. `@oxy.so/bloom/ai-chat` does
 * not export the constant (it lives in `src/ai-chat/shared.ts`, which is not on
 * a public subpath), so it is restated — ONCE, here, so a Bloom bump that moves
 * it has one line to change and one comment to read.
 *
 * It is deliberately NOT `MD_BREAKPOINT`. Alia's `md:` still means 768
 * everywhere else and always did; what it may no longer be read as is "the
 * sidebar is on screen", because from 768 to 1023 it is not. An opener hidden
 * at `md:` leaves that whole band with a drawer and nothing that opens it —
 * which is #532 again, at a width the visual baseline photographs.
 */
export const NAV_BREAKPOINT = 1024;

/**
 * The nav column's width while it is in flow.
 *
 * The number the expo-router `Drawer` carried in `drawerStyle.width`, moved
 * here unchanged: the sidebar has never sized itself, and `AiChatShell` leaves
 * the column untouched unless the host names a width.
 */
export const NAV_PANEL_WIDTH = 255;

/**
 * The collapsed rail. 56 is `AiChatShell`'s own `collapsedSidebarWidth`
 * default AND what Alia's drawer collapsed to, to the pixel — an agreement
 * worth stating out loud, because it is the reason the rail survives the move
 * with nothing re-measured. The 50px New Chat circle still sits in it with
 * three pixels either side.
 */
export const NAV_RAIL_WIDTH = 56;

/**
 * Whether the nav is a column right now.
 *
 * The shell publishes this too (`!navCollapsed`), and anything INSIDE the shell
 * should read it from there — `useAppNav()`. This is for the one caller that
 * cannot: `app/(app)/_layout.tsx`, which has to decide what to hand the shell
 * before the shell exists to ask.
 */
export function useIsNavInFlow(): boolean {
  return useWindowDimensions().width >= NAV_BREAKPOINT;
}
