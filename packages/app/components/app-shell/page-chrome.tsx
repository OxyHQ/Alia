import { useTranslation } from '@/lib/hooks/use-translation';
import { useAiChatShell } from '@oxy.so/bloom/ai-chat';
import { ButtonGroup, ButtonGroupItem } from '@oxy.so/bloom/button-group';
import { RiMenuLine } from '@oxy.so/bloom/icons/RiMenuLine';
import { PageHeader } from '@oxy.so/bloom/page-header';
import type React from 'react';

/**
 * What a page says about its own header, and the ONLY way it says it.
 *
 * A page declares it with expo-router's own `<Stack.Screen options={…} />`,
 * using React Navigation's standard option names, and `screenLayout` in
 * `app/(app)/_layout.tsx` reads them back and draws Bloom's `PageHeader`:
 *
 *   title              the heading (falls back to the section's name)
 *   headerBackVisible  `true` draws the back capsule
 *   headerRight        the page's actions, a function returning nodes
 *
 * Why this and not a context or a `PageFrame` each page renders: the router
 * already carries per-screen options from the screen to the layout that wraps
 * it (`screenLayout` receives them), it re-renders only the layout when they
 * change (the screen sits in a `StaticContainer`), and it needs nothing a page
 * does not already import. The layout keeps owning the frame, so no page draws
 * a container, a background or a corner.
 */
export interface PageHeaderOptions {
  title?: string;
  headerBackVisible?: boolean;
  headerRight?: (props: { canGoBack: boolean; tintColor?: string }) => React.ReactNode;
}

export interface ShellPageHeaderProps {
  title?: string;
  /** Draws the back capsule when set. */
  onBack?: () => void;
  /** The page's own actions, grouped by the page into `ButtonGroup` islands. */
  actions?: React.ReactNode;
}

/**
 * Bloom's `PageHeader`, fitted to the shell.
 *
 * On a phone it carries what `AiChatMobileHeader` carried: the menu button
 * that opens the nav drawer (only below `lg`, where the nav is a drawer) and,
 * below `xl`, the button that opens the panel drawer. From `xl` up it is the
 * page's title, back and actions alone.
 *
 * `inline`, not sticky, with no scrim and no safe area: it is a row at the top
 * of the layout's container, which already pads the top inset, and nothing
 * scrolls under it — so there is no edge to fade and no offset to read.
 */
export function ShellPageHeader({ title, onBack, actions }: ShellPageHeaderProps) {
  const { t } = useTranslation();
  const shell = useAiChatShell();
  const showMenu = shell !== null && shell.navCollapsed && shell.hasNav;
  const showPanel = shell !== null && shell.compact && shell.hasPanel;

  return (
    <PageHeader
      title={title}
      onBack={onBack}
      backLabel={t('common.back')}
      leading={
        showMenu ? (
          <ButtonGroup accessibilityLabel={shell.labels.openNavigation}>
            <ButtonGroupItem
              iconOnly
              leadingIcon={RiMenuLine}
              accessibilityLabel={shell.labels.openNavigation}
              onPress={shell.openNav}
            />
          </ButtonGroup>
        ) : undefined
      }
      actions={
        actions != null || showPanel ? (
          <>
            {actions}
            {showPanel ? (
              <ButtonGroup accessibilityLabel={shell.labels.openPanel(shell.panelLabel)}>
                <ButtonGroupItem
                  iconOnly
                  leadingIcon={shell.panelIcon}
                  accessibilityLabel={shell.labels.openPanel(shell.panelLabel)}
                  onPress={shell.openPanel}
                />
              </ButtonGroup>
            ) : null}
          </>
        ) : undefined
      }
      scrim="none"
      sticky={false}
      safeArea={false}
    />
  );
}
