import { useAppNav } from '@/components/app-shell/nav-context';
import { MenuIcon } from '@/components/ui/icons/menu-icon';
import { useTranslation } from '@/lib/hooks/use-translation';
import { useColorScheme } from '@/lib/useColorScheme';
import { cn } from '@/lib/utils';
import { Button } from '@oxy.so/bloom/button';

/**
 * The one control that opens the navigation at narrow widths.
 *
 * Below `lg` the nav is a push drawer with nothing on screen to open it: a
 * top-level page such as Library rendered its own header with no opener at all,
 * so at 390px the only way back to chat was the swipe gesture nobody is told
 * about (#532). The chat header and the settings header each carried their own
 * copy of this button; this is the shared one, so every top-level page shows
 * the same labelled control in the same place.
 *
 * ## Why `lg:hidden` and not `md:hidden`
 *
 * It was `md:hidden` — 768 — for as long as the drawer was expo-router's,
 * because the drawer became `permanent` at 768 and the sidebar's own collapse
 * control took over there. `AiChatShell` draws the line at 1024 instead
 * (`components/app-shell/metrics.ts` says why that number is not ours to
 * choose), so between 768 and 1023 the nav is a drawer. Left at `md:hidden`,
 * that whole band would have a drawer and nothing that opens it — the same
 * fault as #532, at a width the visual baseline photographs. The opener's
 * breakpoint and the shell's breakpoint have to be the same number, and the
 * shell's is the one that is real.
 *
 * ## Why it no longer calls the navigator
 *
 * `navigation.toggleDrawer()` belonged to the expo-router `Drawer`, and there
 * is no `Drawer`. `useAppNav()` is the shell's own open/close, published by
 * `ShellNavProvider`; `toggle` is composed there so that a second press means
 * the same thing everywhere.
 */
export function DrawerToggle({ className }: { className?: string }) {
  const { t } = useTranslation();
  const { colors } = useColorScheme();
  const nav = useAppNav();

  return (
    <Button
      variant="ghost"
      size="icon"
      onPress={nav.toggle}
      accessibilityRole="button"
      accessibilityLabel={
        nav.presented ? t('nav.closeNavigation') : t('nav.openNavigation')
      }
      aria-expanded={nav.presented}
      className={cn('h-9 w-9 rounded-full lg:hidden', className)}
      icon={
        <>
          <MenuIcon size={20} color={colors.mutedForeground} />
        </>
      }
    />
  );
}
