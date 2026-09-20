import React from 'react';
import { useAiChatShell } from '@oxy.so/bloom/ai-chat';

import { AppNavProvider, type AppNav } from '@/components/app-shell/nav-context';
import { useIsNavInFlow } from '@/components/app-shell/metrics';

/**
 * The one place Alia reads `AiChatShell`'s published state, and republishes it
 * under its own name.
 *
 * Rendered inside the shell — in the workspace and in each nav slot — because
 * `useAiChatShell()` returns `null` anywhere else, and `_layout.tsx` is
 * anywhere else: it is the component that RENDERS the shell, so it sits above
 * its own context.
 *
 * `toggle` is composed here rather than taken from the shell because the shell
 * does not offer one: it has `openNav` and `closeNav` and a `navPresented` to
 * decide between them, which is precisely a toggle and precisely the thing a
 * hamburger asks for. Doing it here means every opener agrees on what a second
 * press means.
 */
export function ShellNavProvider({ children }: { children: React.ReactNode }) {
  const shell = useAiChatShell();
  /**
   * The width, for the case where there is no shell to ask.
   *
   * Only `app/(biglayout)` and the tests get here, and neither has a drawer, so
   * this reads `true` at desktop widths and the openers stay hidden — the same
   * answer the fallback in `nav-context.tsx` gives, arrived at from the window
   * rather than from nothing. The hook is called unconditionally because hooks
   * are, not because the value is usually wanted.
   */
  const inFlowFromWindow = useIsNavInFlow();

  const value = React.useMemo<AppNav | null>(() => {
    if (shell === null) return null;
    // `navCollapsed` is the shell's name for "below `lg`", which is the same
    // fact as "not in flow" read from the other end.
    const inFlow = !shell.navCollapsed;
    const presented = shell.navPresented;
    return {
      inFlow,
      presented,
      open: shell.openNav,
      close: shell.closeNav,
      toggle: () => (presented ? shell.closeNav() : shell.openNav()),
    };
  }, [shell]);

  const fallback = React.useMemo<AppNav>(
    () => ({
      inFlow: inFlowFromWindow,
      presented: inFlowFromWindow,
      open: () => undefined,
      close: () => undefined,
      toggle: () => undefined,
    }),
    [inFlowFromWindow],
  );

  return <AppNavProvider value={value ?? fallback}>{children}</AppNavProvider>;
}
