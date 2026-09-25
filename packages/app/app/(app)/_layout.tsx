import {
  ShellPageHeader,
  type PageHeaderOptions,
} from '@/shell/page-chrome';
import { CommandPalette } from '@/shell/command-palette';
import { AppErrorBoundary } from '@/shell/error-boundary';
import { restoreOpenerFocus } from '@/features/chat/ui/execution/focus-return';
import { KeyboardShortcutsDialog } from '@/shell/keyboard-shortcuts-dialog';
import { useWorkspacePanelChrome, WorkspacePanel } from '@/shell/workspace-panel';
import { AliaSettingsProvider } from '@/features/settings/ui/alia-settings';
import { Sidebar } from '@/shell/sidebar';
import { useLocalRuntime } from '@/features/local-models/runtime/use-local-runtime';
import { useNotificationSetup } from '@/features/notifications/runtime/use-notification-setup';
import { useWelcomeSuggestions } from '@/features/chat/runtime/use-suggestions';
import i18n from '@/shared/i18n';
import { useComposerDraftStore } from '@/features/chat/runtime/composer-draft-store';
import { offlineConversations } from '@/features/chat/runtime/use-conversations';
import { useAccountLifecycle } from '@/shell/account-lifecycle';
import { useFavoritesStore } from '@/features/projects/runtime/favorites-store';
import { useFoldersStore } from '@/features/projects/runtime/folders-store';
import { usePinnedStore } from '@/features/projects/runtime/pinned-store';
import { useProjectsStore } from '@/features/projects/runtime/projects-store';
import { useUIStore } from '@/features/chat/runtime/ui-store';
import { AiChatContainer, AiChatShell } from '@oxy.so/bloom/ai-chat';
import { OverlayInertBoundary, PortalOutlet, PortalProvider } from '@oxy.so/bloom/portal';
import { useOxy } from '@oxy.so/services';
import { useScrollRestoration } from '@oxy.so/bloom/scroll';
import { Navigator, Stack, usePathname, useRouter, type Href } from 'expo-router';
import React, { useEffect, useMemo } from 'react';
import { Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/** Routes that compose their own `AiChatContainer` (theirs holds the composer). */
const CHAT_ROUTES = new Set(['index', 'c/[id]/index', '[username]']);

/**
 * A chat route — or a local visual fixture (`__*.tsx`, never committed), which
 * mounts a chat screen and composes its own container the same way.
 */
const isChatRoute = (name: string) => CHAT_ROUTES.has(name) || name.startsWith('__');

/** The crumb each page's section gets. */
const PAGE_TITLES: Record<string, string> = {
  library: 'sidebar.library',
  tasks: 'sidebar.tasks',
  automations: 'sidebar.automations',
  skills: 'sidebar.skills',
  shows: 'sidebar.shows',
  agents: 'sidebar.agents',
  notifications: 'sidebar.notifications',
};

export default function AppLayout() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const loadProjects = useProjectsStore((state) => state.loadProjects);
  const loadFolders = useFoldersStore((state) => state.loadFolders);
  const loadFavorites = useFavoritesStore((state) => state.loadFavorites);
  const loadPinned = usePinnedStore((state) => state.loadPinned);
  const rightPanel = useUIStore((state) => state.rightPanel);
  const setRightPanel = useUIStore((state) => state.setRightPanel);
  const rightPanelWidth = useUIStore((state) => state.rightPanelWidth);
  const panelChrome = useWorkspacePanelChrome();

  // Prefetch welcome suggestions so they're ready before any chat screen mounts
  useWelcomeSuggestions();

  // Push notification registration, tap handling, and real-time subscription
  useNotificationSetup();

  /**
   * Offer this device's own models to the account, if the person turned that on.
   *
   * Mounted here and only here: it holds ONE socket that answers provider
   * requests for a local model, and a second copy would be a second socket
   * announcing the same runtime.
   */
  useLocalRuntime();

  // Load projects, folders, favorites, and pinned for the signed-in account,
  // and again whenever it changes. Each store namespaces its storage by this
  // id and discards a load that resolves after the id moved on, so switching
  // profiles never shows one account's collections under another (#547).
  const { user } = useOxy();
  const userId = user?.id ?? null;
  useEffect(() => {
    loadProjects(userId);
    loadFolders(userId);
    loadFavorites(userId);
    loadPinned(userId);
    // Composer drafts too: another account's half-written message and files
    // are not this one's (`src/features/chat/runtime/composer-draft-store.ts`).
    useComposerDraftStore.getState().bindAccount(userId);
    // And the offline copy of the conversations (`use-conversations.ts`).
    offlineConversations.bind(userId);
  }, [userId, loadProjects, loadFolders, loadFavorites, loadPinned]);

  // Everything else the previous account left in memory, on a sign-out or a
  // switch (`src/shell/account-lifecycle.ts`).
  useAccountLifecycle(userId);

  /**
   * The template's two sidebars: the in-flow panel from `lg` up, and the drawer
   * copy (`mobile`, plain surface) below it. The shell keeps the closed drawer
   * out of the tab order and the screen-reader tree (#532).
   */
  const sidebar = useMemo(() => <Sidebar />, []);
  const mobileSidebar = useMemo(() => <Sidebar mobile />, []);

  /** Names the veil that closes the nav drawer, and the shell's own controls. */
  const shellLabels = useMemo(
    () => ({
      openNavigation: i18n.t('nav.openNavigation'),
      closeNavigation: i18n.t('nav.closeNavigation'),
    }),
    [],
  );

  // The router owns routes; Bloom owns the frame. The status bar's inset is
  // taken once, around the whole shell (below), so no page adds its own.
  const screenOptions = {
    headerShown: false,
    contentStyle: { backgroundColor: 'transparent' },
  };

  /**
   * Every page stands on the layout's surface: Bloom's `AiChatContainer`, with
   * Bloom's `PageHeader` as its header and no breadcrumb. A page draws no
   * background and no corner of its own. The chat routes compose the same
   * container themselves, because theirs carries the composer.
   *
   * The header is the PAGE's: it declares its title, its back and its actions
   * with `<Stack.Screen options={…} />` (see `src/shell/page-chrome.tsx`),
   * and this reads them back. A page that declares nothing gets its section's
   * name.
   */
  const screenLayout = ({ route, options, children }: ScreenLayoutProps) => {
    if (isChatRoute(route.name)) return children;
    const section = route.name.split('/')[0];
    const title =
      options.title ??
      (PAGE_TITLES[section] ? i18n.t(PAGE_TITLES[section]) : undefined);
    const onBack = options.headerBackVisible
      ? () => {
          // Straight into a detail page there is nothing behind it; its
          // section is the way back rather than a press that does nothing.
          if (router.canGoBack()) router.back();
          else router.replace(`/${section}` as Href);
        }
      : undefined;
    return (
      <AiChatContainer
        header={
          <ShellPageHeader
            title={title}
            onBack={onBack}
            actions={options.headerRight?.({ canGoBack: onBack !== undefined })}
          />
        }
      >
        {children}
      </AiChatContainer>
    );
  };

  const shell = (
    <AiChatShell
      // The page scrolls the document, as every Oxy web app does.
      scroll="document"
      sidebar={sidebar}
      mobileSidebar={mobileSidebar}
      labels={shellLabels}
      defaultPanelWidth={rightPanelWidth}
      // The panel exists only while something has opened it: the agent at
      // work (its tools, the files it writes, a run) or the chat's menu.
      // Closed, the conversation has the whole width.
      panelOpen={rightPanel !== null}
      onPanelOpenChange={(open) => {
        if (open || rightPanel === null) return;
        setRightPanel(null);
        if (rightPanel === 'thought') restoreOpenerFocus();
      }}
      panelLabel={panelChrome.label}
      panelIcon={panelChrome.icon}
      panel={rightPanel === null ? undefined : (width) => <WorkspacePanel width={width} />}
    >
      {Platform.OS === 'web' ? (
        // The page flows in the document, which is what scrolls on web;
        // native-stack's web scene is absolutely positioned and would
        // pin it to one screen.
        <Navigator screenOptions={screenOptions}>
          <Navigator.Screen name="c/[id]/index" options={{ title: i18n.t('nav.chat') }} />
          <FocusedPage layout={screenLayout} />
        </Navigator>
      ) : (
        <Stack screenOptions={screenOptions} screenLayout={screenLayout}>
          <Stack.Screen
            name="c/[id]/index"
            options={{ title: i18n.t('nav.chat') }}
          />
        </Stack>
      )}
    </AiChatShell>
  );

  return (
    <AppErrorBoundary>
      {/* Bloom's native portal: the settings modal, a tooltip and the media
          gallery draw themselves through it, and without a provider and an
          outlet they draw nothing at all — Settings did not open on Android
          (docs/native-validation.mdx). The outlet sits INSIDE the settings
          provider, because what it renders reads its context from there: the
          settings pages call `useAliaSettings()`. On web both are no-ops and
          the portal goes to the document. Gate: native-portal-host.test.ts */}
      <PortalProvider>
        <AliaSettingsProvider>
          {/* Hides the app from a screen reader while a portaled modal is up
              (TalkBack otherwise walks the chat behind Settings). */}
          <OverlayInertBoundary>
            {Platform.OS === 'web' ? (
              shell
            ) : (
              // Android draws the app edge to edge and Bloom's shell takes no
              // safe area: without this its frame, the chat header's menu button
              // and the drawer all start under the status bar, where the system
              // takes the touch (the button did nothing to a tap on its top two
              // thirds). The strip above shows the root's background, which is
              // the shell's own surface colour. The composer keeps the bottom
              // inset itself (`chat-page-content.tsx`).
              <View style={{ flex: 1, paddingTop: insets.top }}>{shell}</View>
            )}
          </OverlayInertBoundary>
          <CommandPalette />
          <KeyboardShortcutsDialog />
          <PortalOutlet />
        </AliaSettingsProvider>
      </PortalProvider>
    </AppErrorBoundary>
  );
}

interface ScreenLayoutProps {
  route: { name: string };
  options: PageHeaderOptions;
  children: React.ReactElement;
}

/**
 * Web: the focused page, through the same `screenLayout` the native stack
 * wraps each screen in, so a page's header and surface do not depend on which
 * navigator shows it.
 *
 * Every page shares the one document scroll, so a page opens at the top — or
 * where the reader left it, if they have been here — instead of at whatever
 * offset the last page left. A chat opens at its newest turn, which its thread
 * does itself.
 */
function FocusedPage({ layout }: { layout: (props: ScreenLayoutProps) => React.ReactNode }) {
  const { state, descriptors } = Navigator.useContext();
  const descriptor = descriptors[state.routes[state.index].key];
  const pathname = usePathname();
  useScrollRestoration('window', { enabled: !isChatRoute(descriptor.route.name), key: pathname });
  return layout({
    route: descriptor.route,
    options: descriptor.options as PageHeaderOptions,
    children: descriptor.render(),
  });
}
