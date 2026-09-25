import { InviteDialog } from "@/components/invite-dialog";
import { ProjectEditDialog, type ProjectEditValues } from "@/components/project-edit-dialog";
import { useAliaSettings } from "@/components/settings/settings-context";
import {
  ConversationActions,
  FolderActions,
  FolderNameDialog,
  NewAgentAction,
  NewCollectionAction,
  ProjectActions,
  RenameConversationDialog,
  StreamingIndicator,
} from "@/components/sidebar-menus";
import { agentDisplayName, agentHandle } from "@/lib/agents/identity";
import { formatRelativeTime } from "@/lib/utils/relative-time";
import { queryKeys } from "@/lib/hooks/query-keys";
import {
  prefetchConversation,
  useConversations,
  useDeleteConversation,
  useRenameConversation,
  type Conversation,
} from "@/lib/hooks/use-conversations";
import { useMyAgents } from "@/lib/hooks/use-my-agents";
import { useUnreadCount } from "@/lib/hooks/use-notifications";
import { useTranslation } from "@/lib/hooks/use-translation";
import { selectedItemForPath, sidebarSections } from "@/lib/sidebar-history";
import { useFavoritesStore } from "@/lib/stores/favorites-store";
import { useFoldersStore, type Folder } from "@/lib/stores/folders-store";
import { useStore } from "@/lib/stores/global-store";
import { usePinnedStore } from "@/lib/stores/pinned-store";
import { useProjectsStore, type Project } from "@/lib/stores/projects-store";
import { IdentityMark } from "@alia.onl/sdk";
import { useAiChatShell } from "@oxy.so/bloom/ai-chat";
import { RiAddFill } from "@oxy.so/bloom/icons/RiAddFill";
import { RiBookOpenLine } from "@oxy.so/bloom/icons/RiBookOpenLine";
import { RiCustomerServiceLine } from "@oxy.so/bloom/icons/RiCustomerServiceLine";
import { RiFileTextLine } from "@oxy.so/bloom/icons/RiFileTextLine";
import { RiGiftLine } from "@oxy.so/bloom/icons/RiGiftLine";
import { RiListCheck3 } from "@oxy.so/bloom/icons/RiListCheck3";
import { RiMicLine } from "@oxy.so/bloom/icons/RiMicLine";
import { RiNotification3Line } from "@oxy.so/bloom/icons/RiNotification3Line";
import { RiRobot2Line } from "@oxy.so/bloom/icons/RiRobot2Line";
import { RiSettings4Line } from "@oxy.so/bloom/icons/RiSettings4Line";
import { RiShieldLine } from "@oxy.so/bloom/icons/RiShieldLine";
import { RiSmartphoneLine } from "@oxy.so/bloom/icons/RiSmartphoneLine";
import { RiSparklingLine } from "@oxy.so/bloom/icons/RiSparklingLine";
import { RiTimeLine } from "@oxy.so/bloom/icons/RiTimeLine";
import {
  Sidebar as BloomSidebar,
  type SidebarNavItem,
  type SidebarTree,
  type SidebarTreeFolder,
  type SidebarTreeItem,
} from "@oxy.so/bloom/sidebar";
import * as Skeleton from "@oxy.so/bloom/skeleton";
import { confirm } from "@oxy.so/bloom/surfaces";
import { Text } from "@oxy.so/bloom/typography";
import { ProfileButton, useAuth, useOxy } from "@oxy.so/services";
import { useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter } from "expo-router";
import React from "react";
import {
  Linking,
  Platform,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";

const SUPPORT_URL = "https://oxy.so/help";
const PRIVACY_URL = "https://oxy.so/legal/privacy";
const TERMS_URL = "https://oxy.so/legal/terms";

/** Tree keys of agent rows: `agent:<handle>`. Chat rows are keyed by conversation id. */
const AGENT_KEY = "agent:";

/**
 * Alia's sidebar is Bloom's AI Chat template sidebar, prop for prop: account,
 * quick search, primary rows, a tree of chats, theme toggle, secondary rows and
 * the plan card. Only the data is Alia's. The tree holds the agents, Pinned and
 * Favorites, the projects and folders, then History by day (see
 * `sidebarSections`). Each chat, project and folder carries a menu in the
 * tree's `actions` slot; the dialogs those menus open sit beside the sidebar.
 */
export interface AliaSidebarProps {
  /** The drawer copy the shell shows below `lg` (the template's `mobile surface="plain"`). */
  mobile?: boolean;
}

export const Sidebar = React.memo(function Sidebar({ mobile }: AliaSidebarProps) {
  const { props, dialogs } = useSidebarProps();
  return (
    <>
      {mobile ? (
        <BloomSidebar {...props} mobile surface="plain" />
      ) : (
        <BloomSidebar {...props} />
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
  const { t } = useTranslation();
  const chatId = useStore((state) => state.chatId);
  const streamingChatId = useStore((state) => state.streamingChatId);
  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    isLoading,
  } = useConversations();
  const { data: myAgents } = useMyAgents();
  const { isAuthenticated, showBottomSheet } = useOxy();
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
  const { data: unread } = useUnreadCount();
  // `mutateAsync` is stable across renders; the mutation object is not, and the
  // tree's rows (and their memoised menus) depend on this.
  const { mutateAsync: deleteConversation } = useDeleteConversation();
  const renameConversation = useRenameConversation();
  const [renaming, setRenaming] = React.useState<Conversation | null>(null);
  const [projectDialogOpen, setProjectDialogOpen] = React.useState(false);
  const [editingProject, setEditingProject] = React.useState<Project | null>(null);
  const [folderDialog, setFolderDialog] = React.useState<{ folder?: Folder } | null>(null);
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState("");

  const closeNav = shell?.closeNav;
  const go = React.useCallback(
    (href: Parameters<typeof router.push>[0]) => {
      closeNav?.();
      router.push(href);
    },
    [router, closeNav],
  );

  const conversations = React.useMemo(() => {
    const all = data?.pages.flatMap((page) => page.conversations) ?? [];
    return all.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
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
      prefetchConversation(queryClient, id);
      closeNav?.();
      router.replace(`/(app)/c/${id}`);
    },
    [router, queryClient, conversations, closeNav],
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
        title: t("sidebar.deleteChatTitle"),
        description: t("sidebar.deleteChatDescription", {
          title: conv.title || t("sidebar.newConversation"),
        }),
        confirmLabel: t("common.delete"),
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
      if (chatId?.id === conv.id) router.replace("/(app)");
    },
    [t, deleteConversation, fileConversation, togglePin, toggleFavorite, chatId, router],
  );

  const askDeleteProject = React.useCallback(
    async (project: Project) => {
      const ok = await confirm({
        title: t("sidebar.deleteProjectTitle"),
        description: t("sidebar.deleteProjectDescription", { name: project.name }),
        confirmLabel: t("common.delete"),
        destructive: true,
      });
      if (ok) await deleteProject(project.id);
    },
    [t, deleteProject],
  );

  const askDeleteFolder = React.useCallback(
    async (folder: Folder) => {
      const ok = await confirm({
        title: t("sidebar.deleteFolderTitle"),
        description: t("sidebar.deleteFolderDescription", { name: folder.name }),
        confirmLabel: t("common.delete"),
        destructive: true,
      });
      if (ok) await deleteFolder(folder.id);
    },
    [t, deleteFolder],
  );

  const renameFolder = React.useCallback(
    (folder: Folder) => setFolderDialog({ folder }),
    [],
  );

  const saveFolder = React.useCallback(
    (name: string, folder: Folder | undefined) => {
      if (folder) void updateFolder(folder.id, { name });
      else void createFolder(name);
    },
    [createFolder, updateFolder],
  );

  const openAgent = React.useCallback(
    (handle: string) => {
      // An agent is opened by its handle; one Oxy did not resolve has no address.
      if (!handle) return;
      closeNav?.();
      router.push({ pathname: "/(app)/[username]", params: { username: `@${handle}` } });
    },
    [router, closeNav],
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
        label: conv.title || t("sidebar.newConversation"),
        meta: shortTime(conv.updatedAt),
        onPrefetch: () => prefetchConversation(queryClient, conv.id),
        actions:
          streaming && menu ? (
            <View style={{ flexDirection: "row", alignItems: "center" }}>
              <StreamingIndicator />
              {menu}
            </View>
          ) : streaming ? (
            <StreamingIndicator />
          ) : (
            menu ?? undefined
          ),
      };
    },
    [
      queryClient,
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

  const tree = React.useMemo<SidebarTree | undefined>(() => {
    const sections = sidebarSections({
      conversations,
      projects,
      folders,
      pinnedIds,
      favoriteIds,
    });
    const agents = isAuthenticated ? (myAgents ?? []) : [];
    const shortcut = (key: string, label: string, rows: Conversation[]) =>
      rows.length ? [{ key, label, defaultOpen: true, items: rows.map(row) }] : [];
    const treeFolders: SidebarTreeFolder[] = [
      ...(agents.length
        ? [
            {
              key: "agents",
              label: t("sidebar.agents"),
              defaultOpen: true,
              actions: <NewAgentAction onPress={() => go("/(app)/agents/create")} />,
              items: agents.map((agent) => ({
                key: `${AGENT_KEY}${agentHandle(agent)}`,
                label: agentDisplayName(agent),
                meta: agent.lastMessageAt ? shortTime(new Date(agent.lastMessageAt)) : undefined,
              })),
            },
          ]
        : []),
      ...shortcut("pinned", t("sidebar.pinned"), sections.pinned),
      ...shortcut("favorites", t("sidebar.favorites"), sections.favorites),
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
      ...sections.history.map((bucket) => ({
        key: `history:${bucket.key}`,
        label: t(`sidebar.${bucket.key}`),
        defaultOpen: true,
        items: bucket.items.map(row),
      })),
    ];
    // Signed in, the tree stands even while empty: it holds "new project/folder".
    if (!treeFolders.length && !isAuthenticated) return undefined;
    return {
      label: t("sidebar.chats"),
      folders: treeFolders,
      actions: isAuthenticated ? (
        <NewCollectionAction
          onNewProject={() => openProjectDialog(null)}
          onNewFolder={() => setFolderDialog({})}
        />
      ) : undefined,
    };
  }, [
    conversations,
    projects,
    folders,
    pinnedIds,
    favoriteIds,
    myAgents,
    toggleProject,
    toggleFolder,
    row,
    t,
    go,
    isAuthenticated,
    openProjectDialog,
    askDeleteProject,
    renameFolder,
    askDeleteFolder,
  ]);

  const items: SidebarNavItem[] = [
    {
      key: "new-chat",
      label: t("sidebar.newChat"),
      icon: RiAddFill,
      onPress: () => {
        closeNav?.();
        router.replace("/(app)");
      },
    },
    { key: "agents", label: t("sidebar.agents"), icon: RiRobot2Line, onPress: () => go("/(app)/agents") },
    { key: "library", label: t("sidebar.library"), icon: RiBookOpenLine, onPress: () => go("/(app)/library") },
    { key: "tasks", label: t("sidebar.tasks"), icon: RiListCheck3, onPress: () => go("/(app)/tasks") },
    { key: "automations", label: t("sidebar.automations"), icon: RiTimeLine, onPress: () => go("/(app)/automations") },
    { key: "skills", label: t("sidebar.skills"), icon: RiSparklingLine, onPress: () => go("/(app)/skills") },
    { key: "shows", label: t("sidebar.shows"), icon: RiMicLine, onPress: () => go("/(app)/shows") },
    ...(isAuthenticated
      ? [
          {
            key: "notifications",
            label: t("sidebar.notifications"),
            icon: RiNotification3Line,
            badge: unread?.count ? unread.count : undefined,
            onPress: () => go("/(app)/notifications"),
          },
        ]
      : []),
  ];

  const secondaryItems: SidebarNavItem[] = [
    ...(isAuthenticated
      ? [
          {
            key: "invite",
            label: t("sidebar.inviteFriends"),
            icon: RiGiftLine,
            onPress: () => {
              closeNav?.();
              setInviteOpen(true);
            },
          },
        ]
      : []),
    ...(Platform.OS === "web"
      ? [
          {
            key: "download",
            label: t("sidebar.getTheApp"),
            icon: RiSmartphoneLine,
            onPress: () => go("/(biglayout)/download"),
          },
        ]
      : []),
    {
      key: "support",
      label: t("sidebar.support"),
      icon: RiCustomerServiceLine,
      onPress: () => {
        void Linking.openURL(SUPPORT_URL);
      },
    },
    {
      key: "privacy",
      label: t("sidebar.privacyPolicy"),
      icon: RiShieldLine,
      onPress: () => {
        void Linking.openURL(PRIVACY_URL);
      },
    },
    {
      key: "terms",
      label: t("sidebar.termsOfService"),
      icon: RiFileTextLine,
      onPress: () => {
        void Linking.openURL(TERMS_URL);
      },
    },
    {
      key: "settings",
      label: t("nav.settings"),
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
      onNavigateManage={() => showBottomSheet?.("ManageAccount")}
      onAddAccount={() => {
        signIn().catch(() => {});
      }}
      menuItems={
        isAuthenticated
          ? [
              {
                key: "upgrade",
                label: t("sidebar.upgradeToPro"),
                onPress: () => go("/(biglayout)/subscribe"),
              },
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

  /** While the first page loads, ghost rows; while a later one does, a line saying so. */
  const content = isLoading ? (
    <HistorySkeleton />
  ) : isFetchingNextPage ? (
    <Text variant="caption-1-regular" style={{ paddingHorizontal: 8 }}>
      {t("sidebar.loadingConversations")}
    </Text>
  ) : undefined;

  const props = {
    logo: {
      icon: <IdentityMark size={26} />,
      wordmark: "Alia",
      onPress: () => {
        closeNav?.();
        router.replace("/(app)");
      },
    },
    items,
    secondaryItems,
    selected: selectedItemForPath(pathname),
    tree,
    content,
    searchQuery,
    onSearchQueryChange: setSearchQuery,
    searchLabel: t("sidebar.searchChats"),
    searchPlaceholder: t("sidebar.searchChatsPlaceholder"),
    noResultsLabel: t("common.noResults"),
    selectedTreeItem: selectedTreeItemForPath(pathname) ?? chatId?.id,
    onTreeItemPress: (item: { key: string }) =>
      item.key.startsWith(AGENT_KEY)
        ? openAgent(item.key.slice(AGENT_KEY.length))
        : openConversation(item.key),
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

/** An agent thread's route (`/@pepe`) selects that agent's row. */
function selectedTreeItemForPath(pathname: string): string | undefined {
  const match = /^\/@([^/]+)$/.exec(pathname);
  return match ? `${AGENT_KEY}${decodeURIComponent(match[1]!)}` : undefined;
}

/** Ghost rows while the first page of history loads; uneven, so they read as titles. */
function HistorySkeleton() {
  return (
    <View style={{ gap: 12, paddingHorizontal: 8, paddingVertical: 4 }}>
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton.Box key={i} height={14} borderRadius={4} width={`${60 + (i % 3) * 15}%`} />
      ))}
    </View>
  );
}

/** The template's time chip: `now`, `34m`, `2h`, `1d`, `3w`. */
function shortTime(date: Date): string {
  const minutes = Math.floor((Date.now() - date.getTime()) / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 52) return `${weeks}w`;
  return formatRelativeTime(date.toISOString());
}
