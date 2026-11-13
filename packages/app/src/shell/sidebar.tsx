import { InviteDialog } from '@/features/onboarding/ui/invite-dialog';
import {
  ProjectEditDialog,
  type ProjectEditValues,
} from '@/features/projects/ui/project-edit-dialog';
import { useAliaSettings } from '@/features/settings/ui/settings-context';
import {
  ConversationActions,
  FolderActions,
  FolderNameDialog,
  NewCollectionAction,
  ProjectActions,
  RenameConversationDialog,
  StreamingIndicator,
} from '@/shell/sidebar-menus';
import { formatRelativeTime } from '@/shared/format/relative-time';
import { GEMIES_URL } from '@/shared/routing/gemies';
import { queryKeys } from '@/shared/api/query-keys';
import { GemieAvatar } from '@gemies/sdk';
import type { Conversation } from '@gemies/sdk/model';
import {
  useConversationStore,
  useConversations,
  useDeleteConversation,
  usePrefetchConversation,
  useRenameConversation,
} from '@gemies/sdk/runtime';
import { useTranslation } from '@/shared/i18n/use-translation';
import {
  flatConversations,
  isAliaChat,
  selectedItemForPath,
  sidebarSections,
} from '@/shell/sidebar-history';
import { useFavoritesStore } from '@/features/projects/runtime/favorites-store';
import { useFoldersStore, type Folder } from '@/features/projects/runtime/folders-store';
import { useStore } from '@/features/chat/runtime/global-store';
import { usePinnedStore } from '@/features/projects/runtime/pinned-store';
import { useProjectsStore, type Project } from '@/features/projects/runtime/projects-store';
import { useAiChatShell } from '@oxy.so/bloom/ai-chat';
import { useHoverIntent } from '@/shell/hover-intent';
import { ConversationSidebar } from '@oxy.so/bloom/conversation-sidebar';
import { RiPushpinLine } from '@oxy.so/bloom/icons/RiPushpinLine';
import { RiCustomerServiceLine } from '@oxy.so/bloom/icons/RiCustomerServiceLine';
import { RiFileTextLine } from '@oxy.so/bloom/icons/RiFileTextLine';
import { RiGiftLine } from '@oxy.so/bloom/icons/RiGiftLine';
import { RiMicLine } from '@oxy.so/bloom/icons/RiMicLine';
import { RiPlugLine } from '@oxy.so/bloom/icons/RiPlugLine';
import { RiRobot2Line } from '@oxy.so/bloom/icons/RiRobot2Line';
import { RiSettings4Line } from '@oxy.so/bloom/icons/RiSettings4Line';
import { RiShieldLine } from '@oxy.so/bloom/icons/RiShieldLine';
import { RiSmartphoneLine } from '@oxy.so/bloom/icons/RiSmartphoneLine';
import type {
  SidebarNavItem,
  SidebarProps,
  SidebarTree,
  SidebarTreeFolder,
  SidebarTreeItem,
} from '@oxy.so/bloom/sidebar';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { confirm } from '@oxy.so/bloom/surfaces';
import { ProfileButton, useAuth, useOxy } from '@oxy.so/services/ui/client';
import { useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter } from 'expo-router';
import React from 'react';
import {
  Linking,
  Pressable,
  Text,
  Platform,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

const SUPPORT_URL = 'https://oxy.so/help';
const PRIVACY_URL = 'https://oxy.so/legal/privacy';
const TERMS_URL = 'https://oxy.so/legal/terms';

/**
 * Alia's sidebar is Bloom's `ConversationSidebar`: search and a "+" (a new chat with Alia) on top,
 * then Alia's chats that are not filed anywhere, pinned and favourites first, newest after, each
 * row with a context menu. Projects and folders are a tree of their own under them, for the chats
 * filed in them; the account is the foot. Only the data is Alia's. The dialogs the menus open sit
 * beside the sidebar.
 *
 * The app is Alia's alone: the person's gemies, their groups and spaces live in Gemies
 * (`https://gemies.ai`), which the account menu links to.
 */

export interface AliaSidebarProps {
  /** The drawer copy the shell shows below `lg` (the template's `mobile surface="plain"`). */
  mobile?: boolean;
  /**
   * What the shell resolved for the in-flow sidebar (`collapsed`, `onCollapsedChange`, `variant`...):
   * spread into Bloom's sidebar, so its collapse control resizes the shell's track and the
   * conversation takes the room. Nothing of it is kept here.
   */
  shell?: SidebarProps;
}

export const Sidebar = React.memo(function Sidebar({ mobile, shell }: AliaSidebarProps) {
  const { props, dialogs } = useSidebarProps();
  return (
    <>
      {mobile ? (
        <ConversationSidebar {...props} mobile surface="plain" />
      ) : (
        <ConversationSidebar {...props} {...shell} />
      )}
      {dialogs}
    </>
  );
});

function useSidebarProps() {
  const router = useRouter();
  const pathname = usePathname();
  const shell = useAiChatShell();
  const settings = useAliaSettings();
  const queryClient = useQueryClient();
  const prefetchConversation = usePrefetchConversation();
  const onHoverIntent = useHoverIntent();
  const { t } = useTranslation();
  const chatId = useStore((state) => state.chatId);
  const streamingChatId = useConversationStore((state) => state.streamingConversationId);
  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    isPending,
    isError,
    refetch,
  } = useConversations();
  const { isAuthenticated } = useOxy();
  const { signIn } = useAuth();
  const projects = useProjectsStore((state) => state.projects);
  const toggleProject = useProjectsStore((state) => state.toggleProject);
  const createProject = useProjectsStore((state) => state.createProject);
  const updateProject = useProjectsStore((state) => state.updateProject);
  const deleteProject = useProjectsStore((state) => state.deleteProject);
  const addConversationToProject = useProjectsStore((state) => state.addConversationToProject);
  const removeConversationFromProject = useProjectsStore(
    (state) => state.removeConversationFromProject,
  );
  const folders = useFoldersStore((state) => state.folders);
  const createFolder = useFoldersStore((state) => state.createFolder);
  const updateFolder = useFoldersStore((state) => state.updateFolder);
  const deleteFolder = useFoldersStore((state) => state.deleteFolder);
  const toggleFolder = useFoldersStore((state) => state.toggleFolder);
  const addConversationToFolder = useFoldersStore((state) => state.addConversationToFolder);
  const removeConversationFromFolder = useFoldersStore(
    (state) => state.removeConversationFromFolder,
  );
  const pinnedIds = usePinnedStore((state) => state.pinnedConversationIds);
  const togglePin = usePinnedStore((state) => state.togglePin);
  const favoriteIds = useFavoritesStore((state) => state.favoriteConversationIds);
  const toggleFavorite = useFavoritesStore((state) => state.toggleFavorite);
  // `mutateAsync` is stable across renders; the mutation object is not, and the
  // tree's rows (and their memoised menus) depend on this.
  const { mutateAsync: deleteConversation } = useDeleteConversation();
  const renameConversation = useRenameConversation();
  const [renaming, setRenaming] = React.useState<Conversation | null>(null);
  const [projectDialogOpen, setProjectDialogOpen] = React.useState(false);
  const [editingProject, setEditingProject] = React.useState<Project | null>(null);
  const [folderDialog, setFolderDialog] = React.useState<{ folder?: Folder } | null>(null);
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState('');

  const closeNav = shell?.closeNav;
  const go = React.useCallback(
    (href: Parameters<typeof router.push>[0]) => {
      closeNav?.();
      router.push(href);
    },
    [router, closeNav],
  );

  // Alia's chats only: the list the server answers also holds the gemies' conversations.
  const conversations = React.useMemo(() => {
    const all = data?.pages.flatMap((page) => page.conversations) ?? [];
    return all.filter(isAliaChat).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }, [data]);

  const openConversation = React.useCallback(
    (id: string) => {
      // Seed the detail cache from the list so the chat renders at once.
      if (!queryClient.getQueryData(queryKeys.conversations.detail(id))) {
        const listed = conversations.find((c) => c.id === id);
        if (listed) {
          queryClient.setQueryData(
            queryKeys.conversations.detail(id),
            { ...listed, messages: [] },
            { updatedAt: 0 },
          );
        }
      }
      prefetchConversation(id);
      closeNav?.();
      router.replace(`/(app)/c/${id}`);
    },
    [router, queryClient, prefetchConversation, conversations, closeNav],
  );

  /**
   * File a chat in one project or one folder, or in neither. A chat is filed in
   * one place at most: out of every other project and folder, then into this.
   */
  const fileConversation = React.useCallback(
    async (conversationId: string, target: { project?: string; folder?: string }) => {
      for (const project of projects) {
        if (project.id !== target.project && project.conversationIds.includes(conversationId)) {
          await removeConversationFromProject(project.id, conversationId);
        }
      }
      for (const folder of folders) {
        if (folder.id !== target.folder && folder.conversationIds.includes(conversationId)) {
          await removeConversationFromFolder(folder.id, conversationId);
        }
      }
      if (target.project) await addConversationToProject(target.project, conversationId);
      if (target.folder) await addConversationToFolder(target.folder, conversationId);
    },
    [
      projects,
      folders,
      addConversationToProject,
      removeConversationFromProject,
      addConversationToFolder,
      removeConversationFromFolder,
    ],
  );
  const moveConversation = React.useCallback(
    (conversationId: string, projectId: string | null) =>
      fileConversation(conversationId, { project: projectId ?? undefined }),
    [fileConversation],
  );
  const moveConversationToFolder = React.useCallback(
    (conversationId: string, folderId: string | null) =>
      fileConversation(conversationId, { folder: folderId ?? undefined }),
    [fileConversation],
  );

  const askDeleteConversation = React.useCallback(
    async (conv: Conversation) => {
      const ok = await confirm({
        title: t('sidebar.deleteChatTitle'),
        description: t('sidebar.deleteChatDescription', {
          title: conv.title || t('sidebar.newConversation'),
        }),
        confirmLabel: t('common.delete'),
        destructive: true,
      });
      if (!ok) return;
      // A failed delete has already said so (the mutation's toast); the chat stays.
      const deleted = await deleteConversation(conv.id).then(
        () => true,
        () => false,
      );
      if (!deleted) return;
      await fileConversation(conv.id, {});
      if (usePinnedStore.getState().pinnedConversationIds.includes(conv.id)) {
        await togglePin(conv.id);
      }
      if (useFavoritesStore.getState().favoriteConversationIds.includes(conv.id)) {
        await toggleFavorite(conv.id);
      }
      // Deleting the open chat leaves nothing to show; start a new one.
      if (chatId?.id === conv.id) router.replace('/(app)');
    },
    [t, deleteConversation, fileConversation, togglePin, toggleFavorite, chatId, router],
  );

  const askDeleteProject = React.useCallback(
    async (project: Project) => {
      const ok = await confirm({
        title: t('sidebar.deleteProjectTitle'),
        description: t('sidebar.deleteProjectDescription', { name: project.name }),
        confirmLabel: t('common.delete'),
        destructive: true,
      });
      if (ok) await deleteProject(project.id);
    },
    [t, deleteProject],
  );

  const askDeleteFolder = React.useCallback(
    async (folder: Folder) => {
      const ok = await confirm({
        title: t('sidebar.deleteFolderTitle'),
        description: t('sidebar.deleteFolderDescription', { name: folder.name }),
        confirmLabel: t('common.delete'),
        destructive: true,
      });
      if (ok) await deleteFolder(folder.id);
    },
    [t, deleteFolder],
  );

  const renameFolder = React.useCallback((folder: Folder) => setFolderDialog({ folder }), []);

  const saveFolder = React.useCallback(
    (name: string, folder: Folder | undefined) => {
      if (folder) void updateFolder(folder.id, { name });
      else void createFolder(name);
    },
    [createFolder, updateFolder],
  );

  const openProjectDialog = React.useCallback((project: Project | null) => {
    setEditingProject(project);
    setProjectDialogOpen(true);
  }, []);

  const saveProject = React.useCallback(
    async (values: ProjectEditValues) => {
      setProjectDialogOpen(false);
      if (editingProject) {
        await updateProject(editingProject.id, values);
      } else {
        await createProject(values.name, values.description, undefined, values.color);
      }
    },
    [editingProject, updateProject, createProject],
  );

  const row = React.useCallback(
    (conv: Conversation): SidebarTreeItem => {
      const streaming = streamingChatId === conv.id;
      const menu = isAuthenticated ? (
        <ConversationActions
          conversation={conv}
          projects={projects}
          projectId={projects.find((p) => p.conversationIds.includes(conv.id))?.id}
          folders={folders}
          folderId={folders.find((f) => f.conversationIds.includes(conv.id))?.id}
          pinned={pinnedIds.includes(conv.id)}
          favorite={favoriteIds.includes(conv.id)}
          onRename={setRenaming}
          onTogglePin={togglePin}
          onToggleFavorite={toggleFavorite}
          onMove={moveConversation}
          onMoveToFolder={moveConversationToFolder}
          onDelete={askDeleteConversation}
        />
      ) : null;
      return {
        key: conv.id,
        label: conv.title || t('sidebar.newConversation'),
        // A pinned chat says so with its glyph; the rest are title-only.
        icon: pinnedIds.includes(conv.id) ? RiPushpinLine : undefined,
        meta: shortTime(conv.updatedAt),
        onPrefetch: () => onHoverIntent(() => prefetchConversation(conv.id)),
        actions:
          streaming && menu ? (
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <StreamingIndicator />
              {menu}
            </View>
          ) : streaming ? (
            <StreamingIndicator />
          ) : (
            (menu ?? undefined)
          ),
      };
    },
    [
      prefetchConversation,
      onHoverIntent,
      t,
      isAuthenticated,
      streamingChatId,
      projects,
      folders,
      pinnedIds,
      favoriteIds,
      togglePin,
      toggleFavorite,
      moveConversation,
      moveConversationToFolder,
      askDeleteConversation,
    ],
  );

  const sections = React.useMemo(
    () =>
      sidebarSections({
        conversations,
        projects,
        folders,
        pinnedIds,
        favoriteIds,
      }),
    [conversations, projects, folders, pinnedIds, favoriteIds],
  );

  // Alia's own chats: a section of title-only rows, the ones filed nowhere, pinned and favourites first.
  const chatSection = React.useMemo<SidebarTree | undefined>(() => {
    const query = searchQuery.trim().toLowerCase();
    const rows = flatConversations({
      conversations,
      projects,
      folders,
      pinnedIds,
      favoriteIds,
    })
      .filter((conv) => !query || (conv.title || '').toLowerCase().includes(query))
      .map(row);
    return rows.length ? { key: 'chats', label: t('sidebar.chats'), items: rows } : undefined;
  }, [conversations, projects, folders, pinnedIds, favoriteIds, searchQuery, row, t]);

  // Projects and folders, for the chats filed in them, and the chats section above them.
  const tree = React.useMemo<SidebarTree[] | undefined>(() => {
    const treeFolders: SidebarTreeFolder[] = [
      ...sections.projects.map(({ project, conversations: rows }) => ({
        key: `project:${project.id}`,
        label: project.name,
        open: project.isExpanded,
        onOpenChange: () => toggleProject(project.id),
        actions: (
          <ProjectActions
            project={project}
            onEdit={openProjectDialog}
            onDelete={askDeleteProject}
          />
        ),
        items: rows.map(row),
      })),
      ...sections.folders.map(({ folder, conversations: rows }) => ({
        key: `folder:${folder.id}`,
        label: folder.name,
        open: folder.isExpanded,
        onOpenChange: () => toggleFolder(folder.id),
        actions: (
          <FolderActions folder={folder} onRename={renameFolder} onDelete={askDeleteFolder} />
        ),
        items: rows.map(row),
      })),
    ];
    // Signed in, the tree stands even while empty: it holds "new project/folder".
    const sectionsAbove = chatSection === undefined ? [] : [chatSection];
    if (!treeFolders.length && !isAuthenticated)
      return sectionsAbove.length ? sectionsAbove : undefined;
    const projectsTree: SidebarTree = {
      key: 'projects',
      label: t('sidebar.projects'),
      folders: treeFolders,
      actions: isAuthenticated ? (
        <NewCollectionAction
          onNewProject={() => openProjectDialog(null)}
          onNewFolder={() => setFolderDialog({})}
        />
      ) : undefined,
    };
    return [...sectionsAbove, projectsTree];
  }, [
    sections,
    chatSection,
    toggleProject,
    toggleFolder,
    row,
    t,
    isAuthenticated,
    openProjectDialog,
    askDeleteProject,
    renameFolder,
    askDeleteFolder,
  ]);

  // New chat is the toolbar's "+", not a row.
  const items: SidebarNavItem[] = [
    { key: 'shows', label: t('sidebar.shows'), icon: RiMicLine, onPress: () => go('/(app)/shows') },
    {
      key: 'connectors',
      label: t('sidebar.connectors'),
      icon: RiPlugLine,
      onPress: () => go('/(app)/connectors'),
    },
  ];

  /**
   * The links under the history. Signed in they live in the account menu at the
   * foot, so on a short screen the history keeps the room; a visitor has no
   * history and no account menu, so they stay here as rows. Settings is a row
   * either way.
   *
   * `accountIcon` is the same link's glyph in the Oxy account menu, which takes
   * a MaterialCommunityIcons name rather than a component — and only a name
   * from the subset its own icon font ships; without one it draws "…" beside
   * the row, and with a name outside the subset a "?". `inAccountMenu: false` marks what that menu already
   * has: its footer carries Oxy's Privacy Policy and Terms of Service, and a
   * second pair of rows above it showed the same two documents twice (Pixel 8a,
   * `docs/native-validation.mdx`).
   */
  const links: Array<{
    key: string;
    label: string;
    icon: SidebarNavItem['icon'];
    accountIcon?: string;
    inAccountMenu?: false;
    onPress: () => void;
  }> = [
    ...(isAuthenticated
      ? [
          {
            key: 'gemies',
            label: t('sidebar.yourGemies'),
            icon: RiRobot2Line,
            accountIcon: 'account-group',
            onPress: () => {
              void Linking.openURL(GEMIES_URL);
            },
          },
          {
            key: 'invite',
            label: t('sidebar.inviteFriends'),
            icon: RiGiftLine,
            accountIcon: 'gift-outline',
            onPress: () => {
              closeNav?.();
              setInviteOpen(true);
            },
          },
        ]
      : []),
    ...(Platform.OS === 'web'
      ? [
          {
            key: 'download',
            label: t('sidebar.getTheApp'),
            icon: RiSmartphoneLine,
            accountIcon: 'download-outline',
            onPress: () => go('/(biglayout)/download'),
          },
        ]
      : []),
    {
      key: 'support',
      label: t('sidebar.support'),
      icon: RiCustomerServiceLine,
      // `headset` left the account menu's icon subset with @oxy.so/services 8.
      accountIcon: 'help-circle-outline',
      onPress: () => {
        void Linking.openURL(SUPPORT_URL);
      },
    },
    {
      key: 'privacy',
      label: t('sidebar.privacyPolicy'),
      icon: RiShieldLine,
      inAccountMenu: false,
      onPress: () => {
        void Linking.openURL(PRIVACY_URL);
      },
    },
    {
      key: 'terms',
      label: t('sidebar.termsOfService'),
      icon: RiFileTextLine,
      inAccountMenu: false,
      onPress: () => {
        void Linking.openURL(TERMS_URL);
      },
    },
  ];

  const secondaryItems: SidebarNavItem[] = [
    ...(isAuthenticated ? [] : links),
    {
      key: 'settings',
      label: t('nav.settings'),
      icon: RiSettings4Line,
      onPress: () => {
        closeNav?.();
        settings.open();
      },
    },
  ];

  // The foot of the sidebar is Oxy's own account control: the avatar and the
  // shared account menu signed in, sign-in signed out. It takes the place of
  // the template's plan card; upgrading lives in its menu.
  const footer = ({ collapsed }: { collapsed: boolean }) => (
    <ProfileButton
      expanded={!collapsed}
      placement="up"
      onAddAccount={() => {
        signIn().catch(() => {});
      }}
      menuItems={
        isAuthenticated
          ? [
              {
                key: 'upgrade',
                label: t('sidebar.upgradeToPro'),
                icon: 'star',
                onPress: () => go('/(biglayout)/subscribe'),
              },
              ...links
                .filter((link) => link.inAccountMenu !== false)
                .map(({ key, label, accountIcon, onPress }) => ({
                  key,
                  label,
                  icon: accountIcon,
                  onPress,
                })),
            ]
          : undefined
      }
    />
  );

  const onScroll = React.useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
      if (
        layoutMeasurement.height + contentOffset.y >= contentSize.height - 100 &&
        hasNextPage &&
        !isFetchingNextPage
      ) {
        void fetchNextPage();
      }
    },
    [hasNextPage, isFetchingNextPage, fetchNextPage],
  );

  // Quick search filters the rows the sidebar holds, and history arrives a page
  // at a time: keep loading while a query is typed, so an older match is found
  // rather than silently missing.
  React.useEffect(() => {
    if (searchQuery.trim() && hasNextPage && !isFetchingNextPage && !isFetchNextPageError) {
      void fetchNextPage();
    }
  }, [searchQuery, hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);

  /** While the first page loads, ghost rows; while a later one does, two more at the foot. */
  const content =
    isAuthenticated && !data && isPending ? (
      <HistorySkeleton />
    ) : isFetchingNextPage ? (
      <HistorySkeleton rows={2} />
    ) : undefined;
  const after = (
    <>
      {isError ? (
        <Pressable accessibilityRole="button" onPress={() => void refetch()}>
          <Text>{t('sidebar.loadError')}</Text>
          <Text>{t('common.retry')}</Text>
        </Pressable>
      ) : null}
      {content}
    </>
  );

  const newChat = React.useCallback(() => {
    closeNav?.();
    router.replace('/(app)');
  }, [closeNav, router]);

  const props = {
    // The panel's own header stays above the tools: the mark and name (home), and the collapse control.
    logo: {
      // A still thumbnail: a permanent 26px spot should not hold a live 3D renderer on every page.
      icon: <GemieAvatar size={26} portrait />,
      wordmark: 'Alia',
      onPress: () => {
        closeNav?.();
        router.replace('/(app)');
      },
    },
    // Alia's chats are a titled tree section; the flat list holds nothing.
    conversations: [],
    activeId: undefined,
    onSelect: () => undefined,
    query: searchQuery,
    onQueryChange: setSearchQuery,
    labels: {
      create: t('sidebar.newChat'),
      search: t('sidebar.searchChats'),
      searchPlaceholder: t('sidebar.searchChatsPlaceholder'),
      // A visitor has no chats to find: say "no results" only for a search that found none.
      empty: searchQuery.trim() ? t('common.noResults') : '',
    },
    // The "+" starts a new chat with Alia.
    onCreate: newChat,
    after,
    items,
    secondaryItems,
    selected: selectedItemForPath(pathname),
    tree,
    selectedTreeItem: chatId?.id,
    onTreeItemPress: (item: { key: string }) => openConversation(item.key),
    footer,
    onScroll,
    onClose: closeNav,
  };

  const dialogs = (
    <>
      <RenameConversationDialog
        conversation={renaming}
        onClose={() => setRenaming(null)}
        onRename={(conv, title) => renameConversation.mutate({ id: conv.id, title })}
      />
      <FolderNameDialog
        state={folderDialog}
        onClose={() => setFolderDialog(null)}
        onSubmit={saveFolder}
      />
      <ProjectEditDialog
        open={projectDialogOpen}
        onOpenChange={setProjectDialogOpen}
        project={editingProject}
        onSave={saveProject}
      />
      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} />
    </>
  );

  return { props, dialogs };
}

/** Ghost rows while the first page of history loads; uneven, so they read as titles. */
function HistorySkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <View style={{ gap: 12, paddingHorizontal: 8, paddingVertical: 4 }}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton.Box key={i} height={14} borderRadius={4} width={`${60 + (i % 3) * 15}%`} />
      ))}
    </View>
  );
}

/** The template's time chip: `now`, `34m`, `2h`, `1d`, `3w`. */
function shortTime(date: Date): string {
  const minutes = Math.floor((Date.now() - date.getTime()) / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 52) return `${weeks}w`;
  return formatRelativeTime(date.toISOString());
}
