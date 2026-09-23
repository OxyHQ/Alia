import { AppDownloadDialog } from "@/components/app-download-dialog";
import { useAppNav } from "@/components/app-shell/nav-context";
import { FolderEditDialog } from "@/components/folder-edit-dialog";
import { InviteDialog } from "@/components/invite-dialog";
import { ProjectEditDialog } from "@/components/project-edit-dialog";
import { useAliaSettings } from "@/components/settings/settings-context";
import { SidebarSkeleton } from "@/components/sidebar-skeleton";
import { bloomIcon } from "@/components/sidebar/bloom-icon";
import { ConversationMenu } from "@/components/sidebar/conversation-menu";
import { groupHistory } from "@/components/sidebar/group-history";
import { useSidebarCollapse } from "@/components/sidebar/use-sidebar-collapse";
import { SidebarActions } from "@/components/sidebar/sidebar-actions";
import { BellIcon } from "@/components/ui/bell-icon";
import { GetAppIcon } from "@/components/ui/get-app-icon";
import { AgentRobotIcon } from "@/components/ui/icons/agent-robot-icon";
import { ClockIcon } from "@/components/ui/icons/clock-icon";
import { GiftIcon } from "@/components/ui/icons/gift-icon";
import { LibraryIcon } from "@/components/ui/icons/library-icon";
import { MicrophoneIcon } from "@/components/ui/icons/microphone-icon";
import { PlusIcon } from "@/components/ui/icons/plus-icon";
import { SettingsIcon } from "@/components/ui/icons/settings-icon";
import { ShortcutsIcon } from "@/components/ui/icons/shortcuts-icon";
import { SkillsIcon } from "@/components/ui/icons/skills-icon";
import { TasksIcon } from "@/components/ui/icons/tasks-icon";
import { UpgradePlanIcon } from "@/components/ui/icons/upgrade-plan-icon";
import { agentDisplayName, agentHandle } from "@/lib/agents/identity";
import { formatRelativeTime } from "@/lib/utils/relative-time";
import { queryKeys } from "@/lib/hooks/query-keys";
import { useSubscription } from "@/lib/hooks/use-billing";
import {
  prefetchConversation,
  useConversations,
  useDeleteConversation,
} from "@/lib/hooks/use-conversations";
import { useMyAgents } from "@/lib/hooks/use-my-agents";
import { useUnreadCount } from "@/lib/hooks/use-notifications";
import { useTranslation } from "@/lib/hooks/use-translation";
import { conversationsForHistory } from "@/lib/sidebar-history";
import { useFavoritesStore } from "@/lib/stores/favorites-store";
import type { Folder as FolderType } from "@/lib/stores/folders-store";
import { useFoldersStore } from "@/lib/stores/folders-store";
import { useStore } from "@/lib/stores/global-store";
import { usePinnedStore } from "@/lib/stores/pinned-store";
import type { Project } from "@/lib/stores/projects-store";
import { useProjectsStore } from "@/lib/stores/projects-store";
import { useUIStore } from "@/lib/stores/ui-store";
import type { StopPropagationEvent } from "@/lib/types/events";
import {
  Sidebar as BloomSidebar,
  type SidebarTreeFolder,
  type SidebarTreeItem,
} from "@oxy.so/bloom/sidebar";
import { Text } from "@oxy.so/bloom/typography";
import { useTheme } from "@oxy.so/bloom/theme";
import { useAuth, useOxy } from "@oxy.so/services";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { BookMarked } from "lucide-react-native";
import React from "react";
import { View, ActivityIndicator } from "react-native";
import {
  Linking,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
} from "react-native";

/**
 * The Agents glyph, wrapped for Bloom once at module scope.
 *
 * `bloomIcon` memoises per source component anyway, but hoisting the call says
 * the thing out loud: `SidebarItem` is `memo`'d and compares `icon` by
 * identity, so this has to be the same component on every render of a sidebar
 * that re-renders whenever a page of conversations lands.
 */
const AGENTS_GLYPH = bloomIcon(AgentRobotIcon);

export const Sidebar = React.memo(function Sidebar() {
  const router = useRouter();
  const appNav = useAppNav();
  const settings = useAliaSettings();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const { data: unreadData } = useUnreadCount();
  // Use selectors to avoid worklet serialization issues
  const chatId = useStore((state) => state.chatId);
  const streamingChatId = useStore((state) => state.streamingChatId);
  const { colors } = useTheme();
  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    isLoading,
  } = useConversations();
  const deleteConversationMutation = useDeleteConversation();

  // Flatten all pages into a single array, sorted by most recently updated
  const allConversations = React.useMemo(() => {
    const all = data?.pages.flatMap((page) => page.conversations) || [];
    return all.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }, [data]);
  const { isAuthenticated, showBottomSheet, openAccountDialog, oxyServices } =
    useOxy();
  const { signIn, user, isAuthResolved, isPrivateApiPending } = useAuth();
  const { data: subscription } = useSubscription();
  const [searchQuery, setSearchQuery] = React.useState("");
  const setShortcutsDialogOpen = useUIStore((s) => s.setShortcutsDialogOpen);
  const projects = useProjectsStore((state) => state.projects);
  const createProject = useProjectsStore((state) => state.createProject);
  const updateProject = useProjectsStore((state) => state.updateProject);
  const deleteProject = useProjectsStore((state) => state.deleteProject);
  const toggleProject = useProjectsStore((state) => state.toggleProject);
  const addConversationToProject = useProjectsStore(
    (state) => state.addConversationToProject,
  );
  const removeConversationFromProject = useProjectsStore(
    (state) => state.removeConversationFromProject,
  );

  const folders = useFoldersStore((state) => state.folders);
  const createFolder = useFoldersStore((state) => state.createFolder);
  const updateFolder = useFoldersStore((state) => state.updateFolder);
  const deleteFolder = useFoldersStore((state) => state.deleteFolder);
  const toggleFolder = useFoldersStore((state) => state.toggleFolder);
  const addConversationToFolder = useFoldersStore(
    (state) => state.addConversationToFolder,
  );
  const removeConversationFromFolder = useFoldersStore(
    (state) => state.removeConversationFromFolder,
  );

  const favoriteConversationIds = useFavoritesStore(
    (state) => state.favoriteConversationIds,
  );
  const toggleFavorite = useFavoritesStore((state) => state.toggleFavorite);

  const pinnedConversationIds = usePinnedStore(
    (state) => state.pinnedConversationIds,
  );
  const togglePin = usePinnedStore((state) => state.togglePin);

  const [editDialogOpen, setEditDialogOpen] = React.useState(false);
  const [editingProject, setEditingProject] = React.useState<Project | null>(
    null,
  );
  const [folderEditDialogOpen, setFolderEditDialogOpen] = React.useState(false);
  const [editingFolder, setEditingFolder] = React.useState<FolderType | null>(
    null,
  );
  /** This person's own agents, one row each. `?? []` never reaches a render site. */
  const { data: myAgents = [] } = useMyAgents();

  const [agentsSectionCollapsed, setAgentsSectionCollapsed] =
    React.useState(false);
  const [inviteDialogOpen, setInviteDialogOpen] = React.useState(false);
  const [appDownloadDialogOpen, setAppDownloadDialogOpen] =
    React.useState(false);

  const historyConversations = React.useMemo(
    () => conversationsForHistory(allConversations, projects),
    [allConversations, projects],
  );

  const handleNewChat = React.useCallback(() => {
    // Navigate to home page
    router.replace("/(app)");
  }, [router]);

  const {
    collapsed,
    collapse: handleCollapseSidebar,
    expand: handleExpandSidebar,
  } = useSidebarCollapse();

  const handlePrefetchConversation = React.useCallback(
    (id: string) => {
      prefetchConversation(queryClient, id);
    },
    [queryClient],
  );

  const handleSelectConversation = React.useCallback(
    (id: string) => {
      // Seed the detail cache with partial data from the sidebar list so the
      // chat page renders something immediately while the full fetch completes.
      const existingDetail = queryClient.getQueryData(
        queryKeys.conversations.detail(id),
      );
      if (!existingDetail) {
        const convFromList = allConversations.find((c) => c.id === id);
        if (convFromList) {
          queryClient.setQueryData(
            queryKeys.conversations.detail(id),
            { ...convFromList, messages: [] },
            { updatedAt: 0 },
          );
        }
      }
      // Ensure full fetch is in-flight (may already be running from onPressIn prefetch)
      prefetchConversation(queryClient, id);
      // Use replace to avoid accumulating chat history in navigation stack
      router.replace(`/(app)/c/${id}`);
    },
    [router, queryClient, allConversations],
  );

  const handleDeleteConversation = React.useCallback(
    (id: string, e: StopPropagationEvent) => {
      e?.stopPropagation?.();
      deleteConversationMutation.mutate(id);
    },
    [deleteConversationMutation],
  );

  const handleManageAccount = React.useCallback(() => {
    showBottomSheet?.("ManageAccount");
  }, [showBottomSheet]);

  // Adding another account (from the ProfileButton menu) and signing in while
  // signed out both go through the same SDK sign-in flow, same as Mention.
  const handleAddAccount = React.useCallback(() => {
    signIn().catch(() => {});
  }, [signIn]);

  const handleLibrary = React.useCallback(() => {
    router.push("/(app)/library");
  }, [router]);

  const handleTasks = React.useCallback(() => {
    router.push("/(app)/tasks");
  }, [router]);

  const handleAutomations = React.useCallback(() => {
    router.push("/(app)/automations");
  }, [router]);

  const handleSkills = React.useCallback(() => {
    router.push("/(app)/skills");
  }, [router]);

  const handleShows = React.useCallback(() => {
    router.push("/(app)/shows");
  }, [router]);

  const handleAgents = React.useCallback(() => {
    router.push("/(app)/agents");
  }, [router]);

  const handleNewAgent = React.useCallback(() => {
    router.push("/(app)/agents/create");
  }, [router]);

  /**
   * An agent is opened by its HANDLE, which is Oxy's, and never by its id.
   *
   * A handle Oxy did not resolve leaves the row unopenable rather than pointing
   * at `/@` — the thread has no address without one, and a URL that resolves to
   * a blank username would answer "agent not found" about an agent that exists.
   */
  const handleOpenAgentThread = React.useCallback(
    (handle: string) => {
      if (handle.length === 0) return;
      // The sigil belongs to the VALUE, which is what the route strips — see
      // `app/(app)/[username].tsx`. Built through the typed route rather than as
      // a string so a rename of the segment is a compile error here.
      router.push({
        pathname: "/(app)/[username]",
        params: { username: `@${handle}` },
      });
    },
    [router],
  );

  const handleAppDownload = React.useCallback(() => {
    setAppDownloadDialogOpen(true);
  }, []);

  const handleUpgrade = React.useCallback(() => {
    router.push("/(biglayout)/subscribe");
  }, [router]);

  const handleNotifications = React.useCallback(() => {
    router.push("/(app)/notifications");
  }, [router]);

  const handleNewProject = React.useCallback(() => {
    setEditingProject(null);
    setEditDialogOpen(true);
  }, []);

  const handleEditProject = React.useCallback(
    (project: Project, e: StopPropagationEvent) => {
      e?.stopPropagation?.();
      setEditingProject(project);
      setEditDialogOpen(true);
    },
    [],
  );

  const handleDeleteProject = React.useCallback(
    async (id: string, e: StopPropagationEvent) => {
      e?.stopPropagation?.();
      await deleteProject(id);
    },
    [deleteProject],
  );

  const handleSaveProject = React.useCallback(
    async (data: {
      name: string;
      description?: string;
      icon?: string;
      color?: string;
    }) => {
      if (editingProject) {
        await updateProject(editingProject.id, data);
      } else {
        await createProject(data.name, data.description, data.icon);
        if (data.color && projects.length > 0) {
          // Update the color of the newly created project
          const newProject = projects[projects.length - 1];
          if (newProject) {
            await updateProject(newProject.id, { color: data.color });
          }
        }
      }
    },
    [editingProject, createProject, updateProject, projects],
  );

  const handleMoveConversationToProject = React.useCallback(
    async (
      conversationId: string,
      projectId: string | null,
      e: StopPropagationEvent,
    ) => {
      e?.stopPropagation?.();

      // Remove from all projects first
      for (const project of projects) {
        if (project.conversationIds.includes(conversationId)) {
          await removeConversationFromProject(project.id, conversationId);
        }
      }

      // Add to new project if specified
      if (projectId) {
        await addConversationToProject(projectId, conversationId);
      }
    },
    [projects, addConversationToProject, removeConversationFromProject],
  );

  // Get the project a conversation belongs to
  const getConversationProject = React.useCallback(
    (conversationId: string) => {
      return projects.find((p) => p.conversationIds.includes(conversationId));
    },
    [projects],
  );

  // Folder management functions
  const handleNewFolder = React.useCallback(() => {
    setEditingFolder(null);
    setFolderEditDialogOpen(true);
  }, []);

  const handleEditFolder = React.useCallback(
    (folder: FolderType, e: StopPropagationEvent) => {
      e?.stopPropagation?.();
      setEditingFolder(folder);
      setFolderEditDialogOpen(true);
    },
    [],
  );

  const handleDeleteFolder = React.useCallback(
    async (id: string, e: StopPropagationEvent) => {
      e?.stopPropagation?.();
      await deleteFolder(id);
    },
    [deleteFolder],
  );

  const handleToggleFavoriteFolder = React.useCallback(
    async (folder: FolderType, e: StopPropagationEvent) => {
      e?.stopPropagation?.();
      await updateFolder(folder.id, { isFavorite: !folder.isFavorite });
    },
    [updateFolder],
  );

  const handleSaveFolder = React.useCallback(
    async (data: { name: string; icon?: string; color?: string }) => {
      if (editingFolder) {
        await updateFolder(editingFolder.id, data);
      } else {
        await createFolder(data.name, data.icon);
        if (data.color && folders.length > 0) {
          // Update the color of the newly created folder
          const newFolder = folders[folders.length - 1];
          if (newFolder) {
            await updateFolder(newFolder.id, { color: data.color });
          }
        }
      }
    },
    [editingFolder, createFolder, updateFolder, folders],
  );

  const handleMoveConversationToFolder = React.useCallback(
    async (
      conversationId: string,
      folderId: string | null,
      e: StopPropagationEvent,
    ) => {
      e?.stopPropagation?.();

      // Remove from all folders first
      for (const folder of folders) {
        if (folder.conversationIds.includes(conversationId)) {
          await removeConversationFromFolder(folder.id, conversationId);
        }
      }

      // Add to new folder if specified
      if (folderId) {
        await addConversationToFolder(folderId, conversationId);
      }
    },
    [folders, addConversationToFolder, removeConversationFromFolder],
  );

  // Get the folder a conversation belongs to
  const getConversationFolder = React.useCallback(
    (conversationId: string) => {
      return folders.find((f) => f.conversationIds.includes(conversationId));
    },
    [folders],
  );

  const handleToggleFavorite = React.useCallback(
    async (conversationId: string, e: StopPropagationEvent) => {
      e?.stopPropagation?.();
      await toggleFavorite(conversationId);
    },
    [toggleFavorite],
  );

  const handleTogglePin = React.useCallback(
    async (conversationId: string, e: StopPropagationEvent) => {
      e?.stopPropagation?.();
      await togglePin(conversationId);
    },
    [togglePin],
  );

  // Get pinned conversations (from all conversations not in projects)
  const pinnedConversations = React.useMemo(() => {
    return historyConversations.filter((conv) =>
      pinnedConversationIds.includes(conv.id),
    );
  }, [historyConversations, pinnedConversationIds]);

  // Get standalone conversations (not in folders and not pinned)
  const standaloneConversations = React.useMemo(() => {
    const conversationsInFolders = new Set<string>();
    folders.forEach((folder) => {
      folder.conversationIds.forEach((id) => conversationsInFolders.add(id));
    });
    return historyConversations.filter(
      (conv) =>
        !conversationsInFolders.has(conv.id) &&
        !pinnedConversationIds.includes(conv.id),
    );
  }, [historyConversations, folders, pinnedConversationIds]);

  // Handle scroll for infinite loading
  const handleScroll = React.useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { layoutMeasurement, contentOffset, contentSize } =
        event.nativeEvent;
      const paddingToBottom = 100;
      const isCloseToBottom =
        layoutMeasurement.height + contentOffset.y >=
        contentSize.height - paddingToBottom;

      if (isCloseToBottom && hasNextPage && !isFetchingNextPage) {
        fetchNextPage();
      }
    },
    [hasNextPage, isFetchingNextPage, fetchNextPage],
  );

  // Search uses the same paginated history source as navigation. Continue
  // loading while filtering so older matches are not silently excluded.
  React.useEffect(() => {
    if (
      searchQuery.trim() &&
      hasNextPage &&
      !isFetchingNextPage &&
      !isFetchNextPageError
    )
      void fetchNextPage();
  }, [
    searchQuery,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    fetchNextPage,
  ]);

  const conversationRow = (
    conv: (typeof allConversations)[number],
  ): SidebarTreeItem => ({
    key: conv.id,
    label: conv.title || "New conversation",
    onPrefetch: () => handlePrefetchConversation(conv.id),
    actions: (
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        {streamingChatId === conv.id ? (
          <ActivityIndicator size={16} color={colors.textSecondary} />
        ) : null}
        <ConversationMenu
          conversation={conv}
          currentProject={getConversationProject(conv.id)}
          currentFolder={getConversationFolder(conv.id)}
          isFavorite={favoriteConversationIds.includes(conv.id)}
          isPinned={pinnedConversationIds.includes(conv.id)}
          projects={projects}
          folders={folders}
          onToggleFavorite={handleToggleFavorite}
          onTogglePin={handleTogglePin}
          onMoveToProject={handleMoveConversationToProject}
          onMoveToFolder={handleMoveConversationToFolder}
          onDelete={handleDeleteConversation}
        />
      </View>
    ),
  });
  const favoritesFirst = (rows: typeof allConversations) =>
    [...rows].sort(
      (a, b) =>
        Number(favoriteConversationIds.includes(b.id)) -
        Number(favoriteConversationIds.includes(a.id)),
    );
  const treeFolders: SidebarTreeFolder[] = [
    {
      key: "agents",
      label: t("sidebar.agents"),
      open: !agentsSectionCollapsed,
      onOpenChange: (open) => setAgentsSectionCollapsed(!open),
      actions: (
        <SidebarActions
          label={t("sidebar.agents")}
          items={[{ label: t("agents.createAgent"), onPress: handleNewAgent }]}
        />
      ),
      items: myAgents.map((agent) => ({
        key: `agent:${agentHandle(agent)}`,
        label: `${agentDisplayName(agent)} · ${agent.lastMessage || t("sidebar.noAgentMessages")}`,
        meta: agent.lastMessageAt
          ? formatRelativeTime(agent.lastMessageAt)
          : undefined,
      })),
    },
    ...projects.map((project) => ({
      key: `project:${project.id}`,
      label: project.name,
      open: project.isExpanded,
      onOpenChange: () => toggleProject(project.id),
      actions: (
        <SidebarActions
          label={project.name}
          items={[
            {
              label: t("sidebar.editProject"),
              onPress: () => handleEditProject(project, {}),
            },
            {
              label: t("sidebar.deleteProject"),
              onPress: () => handleDeleteProject(project.id, {}),
              danger: true,
            },
          ]}
        />
      ),
      items: favoritesFirst(
        allConversations.filter((conv) =>
          project.conversationIds.includes(conv.id),
        ),
      ).map(conversationRow),
    })),
    ...[...folders]
      .sort((a, b) => Number(b.isFavorite) - Number(a.isFavorite))
      .map((folder) => ({
        key: `folder:${folder.id}`,
        label: folder.name,
        open: folder.isExpanded,
        onOpenChange: () => toggleFolder(folder.id),
        actions: (
          <SidebarActions
            label={folder.name}
            items={[
              {
                label: folder.isFavorite ? "Unfavorite" : "Favorite",
                onPress: () => handleToggleFavoriteFolder(folder, {}),
              },
              {
                label: "Edit folder",
                onPress: () => handleEditFolder(folder, {}),
              },
              {
                label: "Delete folder",
                onPress: () => handleDeleteFolder(folder.id, {}),
                danger: true,
              },
            ]}
          />
        ),
        items: favoritesFirst(
          historyConversations.filter((conv) =>
            folder.conversationIds.includes(conv.id),
          ),
        ).map(conversationRow),
      })),
    ...(pinnedConversations.length
      ? [
          {
            key: "pinned",
            label: "Pinned",
            defaultOpen: true,
            items: pinnedConversations.map(conversationRow),
          },
        ]
      : []),
    ...groupHistory(standaloneConversations, [
      t("sidebar.today"),
      t("sidebar.yesterday"),
      t("sidebar.previous7Days"),
      t("sidebar.earlier"),
    ]).map((group) => ({
      key: `history:${group.key}`,
      label: group.label,
      defaultOpen: true,
      items: group.items.map(conversationRow),
    })),
  ];
  const name = user?.name?.displayName?.trim() || user?.username || "Sign in";
  const avatar = user?.avatar
    ? { source: oxyServices.getFileDownloadUrl(user.avatar, "thumb") }
    : { initials: name.slice(0, 1) };

  return (
    <>
      <BloomSidebar
        fluid={!appNav.inFlow}
        mobile={!appNav.inFlow}
        surface={appNav.inFlow ? "card" : "plain"}
        collapsed={collapsed}
        onCollapsedChange={(next) =>
          next ? handleCollapseSidebar() : handleExpandSidebar()
        }
        onClose={appNav.close}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        searchLabel="Search"
        searchPlaceholder="Search conversations…"
        account={
          isAuthResolved && !isPrivateApiPending
            ? {
                name,
                avatar,
                usersLabel: "Account",
                users: isAuthenticated
                  ? [
                      {
                        id: "current-account",
                        name,
                        avatar,
                        selected: true,
                        onPress: () => openAccountDialog("accounts"),
                      },
                    ]
                  : [],
                onAddUser: handleAddAccount,
                addUserLabel: isAuthenticated ? "Add account" : "Sign in",
                onManage: isAuthenticated
                  ? handleManageAccount
                  : handleAddAccount,
                manageLabel: isAuthenticated ? "Manage account" : "Sign in",
              }
            : undefined
        }
        tree={{
          label: "Alia",
          folders: treeFolders,
          actions: (
            <SidebarActions
              label="Workspace"
              items={[
                { label: "New project", onPress: handleNewProject },
                { label: "New folder", onPress: handleNewFolder },
              ]}
            />
          ),
        }}
        selectedTreeItem={chatId?.id}
        onTreeItemPress={(item) =>
          item.key.startsWith("agent:")
            ? handleOpenAgentThread(item.key.slice(6))
            : handleSelectConversation(item.key)
        }
        plan={
          isAuthenticated && subscription
            ? {
                name: "Alia",
                plan: subscription.plan.name,
                avatar,
                actionLabel: "Manage plan",
                onAction: handleUpgrade,
              }
            : undefined
        }
        items={[
          {
            key: "new-chat",
            label: t("sidebar.newChat"),
            icon: bloomIcon(PlusIcon),
            onPress: handleNewChat,
          },
          {
            key: "agents",
            label: t("sidebar.agents"),
            icon: AGENTS_GLYPH,
            onPress: handleAgents,
          },
          {
            key: "library",
            label: t("sidebar.library"),
            icon: bloomIcon(LibraryIcon),
            onPress: handleLibrary,
          },
          {
            key: "tasks",
            label: "Tasks",
            icon: bloomIcon(TasksIcon),
            onPress: handleTasks,
          },
          {
            key: "automations",
            label: t("sidebar.automations"),
            icon: bloomIcon(ClockIcon),
            onPress: handleAutomations,
          },
          {
            key: "skills",
            label: t("sidebar.skills"),
            icon: bloomIcon(SkillsIcon),
            onPress: handleSkills,
          },
          {
            key: "shows",
            label: "Shows",
            icon: bloomIcon(MicrophoneIcon),
            onPress: handleShows,
          },
        ]}
        secondaryItems={[
          {
            key: "privacy",
            label: t("sidebar.privacyPolicy"),
            icon: bloomIcon(BookMarked),
            onPress: () =>
              Linking.openURL(
                "https://oxy.so/company/transparency/policies/privacy",
              ),
          },
          {
            key: "terms",
            label: t("sidebar.termsOfService"),
            icon: bloomIcon(BookMarked),
            onPress: () =>
              Linking.openURL(
                "https://oxy.so/company/transparency/policies/terms-of-service",
              ),
          },
          {
            key: "settings",
            label: t("nav.settings"),
            icon: bloomIcon(SettingsIcon),
            onPress: () => {
              appNav.close();
              settings.open();
            },
          },
          ...(isAuthenticated
            ? [
                {
                  key: "upgrade",
                  label: t("sidebar.upgradeToPro"),
                  icon: bloomIcon(UpgradePlanIcon),
                  onPress: handleUpgrade,
                },
                {
                  key: "notifications",
                  label: t("sidebar.notifications"),
                  icon: bloomIcon(BellIcon),
                  badge: unreadData?.count,
                  onPress: handleNotifications,
                },
                {
                  key: "invite",
                  label: "Invite a friend",
                  icon: bloomIcon(GiftIcon),
                  onPress: () => setInviteDialogOpen(true),
                },
              ]
            : []),
          ...(Platform.OS === "web"
            ? [
                {
                  key: "download",
                  label: "App download",
                  icon: bloomIcon(GetAppIcon),
                  onPress: handleAppDownload,
                },
                {
                  key: "shortcuts",
                  label: "Keyboard shortcuts",
                  icon: bloomIcon(ShortcutsIcon),
                  onPress: () => setShortcutsDialogOpen(true),
                },
              ]
            : []),
        ]}
        content={
          isLoading ? (
            <SidebarSkeleton />
          ) : isFetchingNextPage ? (
            <Text variant="caption-1-regular">Loading conversations…</Text>
          ) : undefined
        }
        onScroll={handleScroll}
      />

      {/* Project Edit Dialog */}
      <ProjectEditDialog
        open={editDialogOpen}
        onOpenChange={setEditDialogOpen}
        project={editingProject}
        onSave={handleSaveProject}
      />

      {/* Folder Edit Dialog */}
      <FolderEditDialog
        open={folderEditDialogOpen}
        onOpenChange={setFolderEditDialogOpen}
        folder={editingFolder}
        onSave={handleSaveFolder}
      />

      {/* Invite/Referral Dialog */}
      <InviteDialog
        open={inviteDialogOpen}
        onOpenChange={setInviteDialogOpen}
      />

      {/* App Download QR Dialog */}
      <AppDownloadDialog
        open={appDownloadDialogOpen}
        onOpenChange={setAppDownloadDialogOpen}
      />
    </>
  );
});
