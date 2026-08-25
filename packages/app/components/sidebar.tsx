import React from "react";
import { View, Pressable, Platform, NativeSyntheticEvent, NativeScrollEvent, Linking } from "react-native";
import { AliaLogo } from "@/components/ui/alia-logo";
import { BellIcon } from "@/components/ui/bell-icon";
import { GetAppIcon } from "@/components/ui/get-app-icon";
import { AgentRobotIcon } from "@/components/ui/icons/agent-robot-icon";
import { ChevronDownIcon } from "@/components/ui/icons/chevron-down-icon";
import { ChevronRightIcon } from "@/components/ui/icons/chevron-right-icon";
import { ClockIcon } from "@/components/ui/icons/clock-icon";
import { DotsHorizontalIcon } from "@/components/ui/icons/dots-horizontal-icon";
import { GiftIcon } from "@/components/ui/icons/gift-icon";
import { LibraryIcon } from "@/components/ui/icons/library-icon";
import { MicrophoneIcon } from "@/components/ui/icons/microphone-icon";
import { PlusIcon } from "@/components/ui/icons/plus-icon";
import { ProjectsIcon } from "@/components/ui/icons/projects-icon";
import { SettingsIcon } from "@/components/ui/icons/settings-icon";
import { ShortcutsIcon } from "@/components/ui/icons/shortcuts-icon";
import { SidebarToggleIcon } from "@/components/ui/icons/sidebar-toggle-icon";
import { SkillsIcon } from "@/components/ui/icons/skills-icon";
import { TasksIcon } from "@/components/ui/icons/tasks-icon";
import { UpgradePlanIcon } from "@/components/ui/icons/upgrade-plan-icon";
import { IdentityMark } from "@alia.onl/sdk";
import { useColorScheme } from "@/lib/useColorScheme";
import { Text } from "@/components/ui/text";
import { BaseSidebar } from "@/components/base-sidebar";
import {
  FolderOpen,
  Briefcase,
  Folder,
  Package,
  Rocket,
  Target,
  Lightbulb,
  Star as StarIcon,
  Heart,
  Zap,
  Archive,
  Inbox,
  BookMarked,
  FolderClosed,
  History as HistoryIcon,
  type LucideIcon,
} from "lucide-react-native";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/lib/hooks/use-translation";
import { useStore } from "@/lib/stores/global-store";
import { useRouter, usePathname } from "expo-router";
import { useOxy, useAuth, ProfileButton } from "@oxyhq/services";
import { useProjectsStore } from "@/lib/stores/projects-store";
import { useFoldersStore } from "@/lib/stores/folders-store";
import { useFavoritesStore } from "@/lib/stores/favorites-store";
import { usePinnedStore } from "@/lib/stores/pinned-store";
import { SidebarSkeleton } from "@/components/sidebar-skeleton";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/hooks/query-keys";
import { useConversations, useDeleteConversation, prefetchConversation } from "@/lib/hooks/use-conversations";
import { conversationsForHistory } from "@/lib/sidebar-history";
import { useMyAgents } from "@/lib/hooks/use-my-agents";
import { agentDisplayName, agentHandle } from "@/lib/agents/identity";
import * as DropdownMenu from "@/components/ui/dropdown-menu";
import { ProjectEditDialog } from "@/components/project-edit-dialog";
import { InviteDialog } from "@/components/invite-dialog";
import { AppDownloadDialog } from "@/components/app-download-dialog";
import { FolderEditDialog } from "@/components/folder-edit-dialog";
import { useUIStore } from "@/lib/stores/ui-store";
import { useUnreadCount } from "@/lib/hooks/use-notifications";
import {
  SidebarRow,
  SectionHeader,
  GhostIconButton,
  useRailTooltip,
  useSidebarCollapse,
} from "@/components/sidebar/primitives";
import { ConversationItem } from "@/components/sidebar/conversation-item";
import { AgentRow } from "@/components/sidebar/agent-row";
import { FolderSection } from "@/components/sidebar/folder-section";
import { HistoryList } from "@/components/sidebar/history-list";
import type { Project } from "@/lib/stores/projects-store";
import type { Folder as FolderType } from "@/lib/stores/folders-store";
import type { StopPropagationEvent } from '@/lib/types/events';

// Icon mapping for projects and folders
const ICON_MAP: Record<string, LucideIcon> = {
  FolderOpen,
  Briefcase,
  Folder,
  Package,
  Rocket,
  Target,
  Lightbulb,
  Star: StarIcon,
  Heart,
  Zap,
  Archive,
  Inbox,
  BookMarked,
  FolderClosed,
};

export const Sidebar = React.memo(function Sidebar() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const { colors } = useColorScheme();
  const { data: unreadData } = useUnreadCount();
  // Use selectors to avoid worklet serialization issues
  const chatId = useStore((state) => state.chatId);
  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
  } = useConversations();
  const deleteConversationMutation = useDeleteConversation();

  // Flatten all pages into a single array, sorted by most recently updated
  const allConversations = React.useMemo(() => {
    const all = data?.pages.flatMap(page => page.conversations) || [];
    return all.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }, [data]);
  const { isAuthenticated, showBottomSheet } = useOxy();
  const { signIn } = useAuth();
  const setShortcutsDialogOpen = useUIStore((s) => s.setShortcutsDialogOpen);
  const projects = useProjectsStore((state) => state.projects);
  const currentProjectId = useProjectsStore((state) => state.currentProjectId);
  const setCurrentProject = useProjectsStore((state) => state.setCurrentProject);
  const createProject = useProjectsStore((state) => state.createProject);
  const updateProject = useProjectsStore((state) => state.updateProject);
  const deleteProject = useProjectsStore((state) => state.deleteProject);
  const toggleProject = useProjectsStore((state) => state.toggleProject);
  const addConversationToProject = useProjectsStore((state) => state.addConversationToProject);
  const removeConversationFromProject = useProjectsStore((state) => state.removeConversationFromProject);

  const folders = useFoldersStore((state) => state.folders);
  const createFolder = useFoldersStore((state) => state.createFolder);
  const updateFolder = useFoldersStore((state) => state.updateFolder);
  const deleteFolder = useFoldersStore((state) => state.deleteFolder);
  const toggleFolder = useFoldersStore((state) => state.toggleFolder);
  const addConversationToFolder = useFoldersStore((state) => state.addConversationToFolder);
  const removeConversationFromFolder = useFoldersStore((state) => state.removeConversationFromFolder);

  const favoriteConversationIds = useFavoritesStore((state) => state.favoriteConversationIds);
  const toggleFavorite = useFavoritesStore((state) => state.toggleFavorite);

  const pinnedConversationIds = usePinnedStore((state) => state.pinnedConversationIds);
  const togglePin = usePinnedStore((state) => state.togglePin);

  const [editDialogOpen, setEditDialogOpen] = React.useState(false);
  const [editingProject, setEditingProject] = React.useState<Project | null>(null);
  const [folderEditDialogOpen, setFolderEditDialogOpen] = React.useState(false);
  const [editingFolder, setEditingFolder] = React.useState<FolderType | null>(null);
  /** This person's own agents, one row each. `?? []` never reaches a render site. */
  const { data: myAgents = [] } = useMyAgents();

  const [agentsExpanded, setAgentsExpanded] = React.useState(false);
  const [agentsSectionCollapsed, setAgentsSectionCollapsed] = React.useState(false);
  const [projectsCollapsed, setProjectsCollapsed] = React.useState(false);
  const [historyCollapsed, setHistoryCollapsed] = React.useState(false);
  const [inviteDialogOpen, setInviteDialogOpen] = React.useState(false);
  const [appDownloadDialogOpen, setAppDownloadDialogOpen] = React.useState(false);

  const historyConversations = React.useMemo(
    () => conversationsForHistory(allConversations, projects),
    [allConversations, projects],
  );

  const handleNewChat = React.useCallback(() => {
    // Navigate to home page
    router.replace("/(app)");
  }, [router]);

  const { collapsed, collapse: handleCollapseSidebar, expand: handleExpandSidebar } = useSidebarCollapse();

  const handleLogoPress = React.useCallback(() => {
    // Use replace to reset to home
    router.replace("/(app)");
  }, [router]);

  const handlePrefetchConversation = React.useCallback((id: string) => {
    prefetchConversation(queryClient, id);
  }, [queryClient]);

  const handleSelectConversation = React.useCallback((id: string) => {
    // Seed the detail cache with partial data from the sidebar list so the
    // chat page renders something immediately while the full fetch completes.
    const existingDetail = queryClient.getQueryData(queryKeys.conversations.detail(id));
    if (!existingDetail) {
      const convFromList = allConversations.find(c => c.id === id);
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
  }, [router, queryClient, allConversations]);

  const handleDeleteConversation = React.useCallback((id: string, e: StopPropagationEvent) => {
    e?.stopPropagation?.();
    deleteConversationMutation.mutate(id);
  }, [deleteConversationMutation]);

  const handleSettings = React.useCallback(() => {
    router.push("/(app)/settings");
  }, [router]);

  const handleManageAccount = React.useCallback(() => {
    showBottomSheet?.('ManageAccount');
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

  const handleToggleAgents = React.useCallback(() => {
    setAgentsExpanded((prev) => !prev);
  }, []);

  const handleToggleAgentsSection = React.useCallback(() => {
    setAgentsSectionCollapsed((prev) => !prev);
  }, []);

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
  const handleOpenAgentThread = React.useCallback((handle: string) => {
    if (handle.length === 0) return;
    // The sigil belongs to the VALUE, which is what the route strips — see
    // `app/(app)/[username].tsx`. Built through the typed route rather than as
    // a string so a rename of the segment is a compile error here.
    router.push({ pathname: '/(app)/[username]', params: { username: `@${handle}` } });
  }, [router]);

  const handleAppDownload = React.useCallback(() => {
    setAppDownloadDialogOpen(true);
  }, []);

  const handleUpgrade = React.useCallback(() => {
    router.push("/(biglayout)/subscribe");
  }, [router]);

  const handleNotifications = React.useCallback(() => {
    router.push("/(app)/notifications");
  }, [router]);

  const handleSelectProject = React.useCallback((id: string | null) => {
    setCurrentProject(id);
  }, [setCurrentProject]);

  const handleNewProject = React.useCallback(() => {
    setEditingProject(null);
    setEditDialogOpen(true);
  }, []);

  const handleEditProject = React.useCallback((project: Project, e: StopPropagationEvent) => {
    e?.stopPropagation?.();
    setEditingProject(project);
    setEditDialogOpen(true);
  }, []);

  const handleDeleteProject = React.useCallback(async (id: string, e: StopPropagationEvent) => {
    e?.stopPropagation?.();
    await deleteProject(id);
  }, [deleteProject]);

  const handleSaveProject = React.useCallback(
    async (data: { name: string; description?: string; icon?: string; color?: string }) => {
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
    [editingProject, createProject, updateProject, projects]
  );

  const handleToggleProjects = React.useCallback(() => {
    setProjectsCollapsed((prev) => !prev);
  }, []);

  const handleToggleHistory = React.useCallback(() => {
    setHistoryCollapsed((prev) => !prev);
  }, []);

  const handleMoveConversationToProject = React.useCallback(
    async (conversationId: string, projectId: string | null, e: StopPropagationEvent) => {
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
    [projects, addConversationToProject, removeConversationFromProject]
  );

  // Get the project a conversation belongs to
  const getConversationProject = React.useCallback(
    (conversationId: string) => {
      return projects.find((p) => p.conversationIds.includes(conversationId));
    },
    [projects]
  );

  // Folder management functions
  const handleNewFolder = React.useCallback(() => {
    setEditingFolder(null);
    setFolderEditDialogOpen(true);
  }, []);

  const handleEditFolder = React.useCallback((folder: FolderType, e: StopPropagationEvent) => {
    e?.stopPropagation?.();
    setEditingFolder(folder);
    setFolderEditDialogOpen(true);
  }, []);

  const handleDeleteFolder = React.useCallback(async (id: string, e: StopPropagationEvent) => {
    e?.stopPropagation?.();
    await deleteFolder(id);
  }, [deleteFolder]);

  const handleToggleFavoriteFolder = React.useCallback(async (folder: FolderType, e: StopPropagationEvent) => {
    e?.stopPropagation?.();
    await updateFolder(folder.id, { isFavorite: !folder.isFavorite });
  }, [updateFolder]);

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
    [editingFolder, createFolder, updateFolder, folders]
  );

  const handleMoveConversationToFolder = React.useCallback(
    async (conversationId: string, folderId: string | null, e: StopPropagationEvent) => {
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
    [folders, addConversationToFolder, removeConversationFromFolder]
  );

  // Get the folder a conversation belongs to
  const getConversationFolder = React.useCallback(
    (conversationId: string) => {
      return folders.find((f) => f.conversationIds.includes(conversationId));
    },
    [folders]
  );

  const handleToggleFavorite = React.useCallback(
    async (conversationId: string, e: StopPropagationEvent) => {
      e?.stopPropagation?.();
      await toggleFavorite(conversationId);
    },
    [toggleFavorite]
  );

  const handleTogglePin = React.useCallback(
    async (conversationId: string, e: StopPropagationEvent) => {
      e?.stopPropagation?.();
      await togglePin(conversationId);
    },
    [togglePin]
  );

  // Get pinned conversations (from all conversations not in projects)
  const pinnedConversations = React.useMemo(() => {
    return historyConversations.filter((conv) =>
      pinnedConversationIds.includes(conv.id)
    );
  }, [historyConversations, pinnedConversationIds]);

  // Get standalone conversations (not in folders and not pinned)
  const standaloneConversations = React.useMemo(() => {
    const conversationsInFolders = new Set<string>();
    folders.forEach((folder) => {
      folder.conversationIds.forEach((id) => conversationsInFolders.add(id));
    });
    return historyConversations.filter((conv) =>
      !conversationsInFolders.has(conv.id) && !pinnedConversationIds.includes(conv.id)
    );
  }, [historyConversations, folders, pinnedConversationIds]);

  // Handle scroll for infinite loading
  const handleScroll = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
    const paddingToBottom = 100;
    const isCloseToBottom = layoutMeasurement.height + contentOffset.y >= contentSize.height - paddingToBottom;

    if (isCloseToBottom && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Header — logo chip on the left, collapse trigger on the right
  const header = (
    <View className={cn("flex-row items-center", collapsed && "justify-center")}>
      {collapsed ? (
        <View className="p-1.5 mx-0.5 rounded-xl hover:bg-muted active:bg-muted">
          <IdentityMark size={24} color={colors.primary} onPress={handleLogoPress} accessibilityLabel="Home" spinOnMount />
        </View>
      ) : (
        <Pressable
          accessibilityLabel="Home"
          accessibilityRole="button"
          onPress={handleLogoPress}
          className="p-1.5 mx-0.5 rounded-xl hover:bg-muted active:bg-muted"
        >
          <AliaLogo height={36} />
        </Pressable>
      )}
      {!collapsed && (
        <View className="ml-auto">
          <GhostIconButton
            icon={SidebarToggleIcon}
            label={t('sidebar.collapse')}
            onPress={handleCollapseSidebar}
          />
        </View>
      )}
    </View>
  );

  /*
   * New Chat, as a primary action rather than a menu row.
   *
   * Deliberately NOT a `SidebarRow`: the primitives exist so that rows look
   * alike, and the whole point here is that this one does not — a filled pill
   * that reads as the thing to press, above a list of quieter links.
   *
   * `bg-primary` because Alia has no `tertiary`: `global.css` declares
   * primary / secondary / destructive / muted / accent / popover / card /
   * surface, and primary is the pair that means "the action". Its own
   * foreground token comes with it, which is what keeps it legible in both
   * schemes without naming a colour here.
   *
   * Open it is a full-width pill with its label centred and no icon; in the
   * rail it is a circle with only the icon. 50px of circle sits in a 56px rail
   * (`app/(app)/_layout.tsx`) with three pixels either side.
   */
  const newChatTooltip = useRailTooltip(t('sidebar.newChat'));
  const expandTooltip = useRailTooltip(t('sidebar.expand'));
  const newChatButton = (
      <Pressable
        {...(collapsed ? newChatTooltip.anchorProps : null)}
        accessibilityLabel={t('sidebar.newChat')}
        accessibilityRole="button"
        onPress={handleNewChat}
        className={cn(
          "items-center justify-center rounded-full bg-primary hover:bg-primary/90 active:bg-primary/80",
          collapsed ? "h-[50px] w-[50px]" : "w-full py-3"
        )}
      >
        {collapsed ? (
          <PlusIcon size={26} color={colors.primaryForeground} />
        ) : (
          <Text className="text-center text-[17px] font-extrabold text-primary-foreground">
            {t('sidebar.newChat')}
          </Text>
        )}
      </Pressable>
  );

  const topSection = (
    <View className={cn("gap-2", collapsed && "items-center")}>
      <ProfileButton
        expanded={!collapsed}
        onNavigateManage={handleManageAccount}
        onAddAccount={handleAddAccount}
      />
      <View className="gap-px">
        {newChatButton}
        {collapsed && newChatTooltip.tooltip}
      </View>
    </View>
  );

  // Navigation links — SidebarRow everywhere; the Agents entry expands a
  // nested submenu when the sidebar is open and expands the rail otherwise.
  const navigation = (
    <>
      {collapsed ? (
        <SidebarRow icon={AgentRobotIcon} label={t('sidebar.agents')} onPress={handleExpandSidebar} iconOnly />
      ) : (
        <View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('sidebar.agents')}
            onPress={handleToggleAgents}
            className="h-9 flex-row items-center justify-between rounded-xl px-1.5 w-full hover:bg-muted active:bg-muted"
          >
            <View className="flex-row items-center gap-2">
              <AgentRobotIcon size={18} color={colors.foreground} />
              <Text className="text-sm text-foreground">{t('sidebar.agents')}</Text>
            </View>
            {agentsExpanded ? (
              <ChevronDownIcon size={12} color={colors.mutedForeground} />
            ) : (
              <ChevronRightIcon size={12} color={colors.mutedForeground} />
            )}
          </Pressable>
          {agentsExpanded && (
            <View className="ml-7 gap-px">
              <SidebarRow icon={AgentRobotIcon} label={t('agents.allAgents')} onPress={handleAgents} sub />
            </View>
          )}
        </View>
      )}
      <SidebarRow icon={LibraryIcon} label={t('sidebar.library')} onPress={handleLibrary} iconOnly={collapsed} />
      <SidebarRow icon={TasksIcon} label="Tasks" onPress={handleTasks} iconOnly={collapsed} />
      <SidebarRow icon={ClockIcon} label={t('sidebar.automations')} onPress={handleAutomations} iconOnly={collapsed} />
      <SidebarRow icon={SkillsIcon} label={t('sidebar.skills')} onPress={handleSkills} iconOnly={collapsed} />
      <SidebarRow icon={MicrophoneIcon} label="Shows" onPress={handleShows} iconOnly={collapsed} />
    </>
  );

  // Scrollable content - Projects and History (rail: icons that expand)
  const scrollableContent = collapsed ? (
    <View className="gap-px pt-2">
      <SidebarRow icon={AgentRobotIcon} label={t('sidebar.agents')} onPress={handleExpandSidebar} iconOnly />
      <SidebarRow icon={ProjectsIcon} label={t('sidebar.projects')} onPress={handleExpandSidebar} iconOnly />
      <SidebarRow icon={HistoryIcon} label="History" onPress={handleExpandSidebar} iconOnly />
    </View>
  ) : (
    <View className="gap-2">
        <View className="gap-2">
            {/* Agents Subsection — one row per agent, not one per stretch of its
                thread. The conversations behind them are excluded from History
                above, which is what keeps the two from saying the same thing. */}
            <View>
              <SectionHeader
                label={t('sidebar.agents')}
                collapsed={agentsSectionCollapsed}
                onToggle={handleToggleAgentsSection}
                onAdd={handleNewAgent}
                addAccessibilityLabel={t('agents.createAgent')}
              />
              {!agentsSectionCollapsed && (
                <View className="gap-1">
                  {myAgents.length === 0 ? (
                    <View className="items-center justify-center py-4">
                      <Text className="text-xs text-muted-foreground">
                        {t('sidebar.noAgents')}
                      </Text>
                    </View>
                  ) : (
                    myAgents.map((agent) => {
                      const handle = agentHandle(agent);
                      return (
                        <AgentRow
                          key={agent._id}
                          name={agentDisplayName(agent)}
                          handle={handle}
                          color={agent.color}
                          lastMessage={agent.lastMessage}
                          lastMessageAt={agent.lastMessageAt}
                          emptyLabel={t('sidebar.noAgentMessages')}
                          onPress={() => handleOpenAgentThread(handle)}
                        />
                      );
                    })
                  )}
                </View>
              )}
            </View>

            {/* Projects Subsection */}
            <View>
              <View className="flex-row items-center justify-between pt-4 pb-1 px-2">
                <Pressable
                  onPress={handleToggleProjects}
                  className="flex-row items-center gap-1 flex-1 rounded-lg active:opacity-70"
                >
                  <Text className="text-xs font-semibold text-foreground select-none">
                    {t('sidebar.projects')}
                  </Text>
                  {projectsCollapsed ? (
                    <ChevronRightIcon size={12} color={colors.foreground} />
                  ) : (
                    <ChevronDownIcon size={12} color={colors.foreground} />
                  )}
                </Pressable>
                <Pressable
                  onPress={handleNewProject}
                  className="h-6 w-6 items-center justify-center rounded-lg hover:bg-muted active:bg-muted"
                >
                  <PlusIcon size={14} color={colors.mutedForeground} />
                </Pressable>
              </View>
              {!projectsCollapsed && (
                <View className="gap-1">
                {projects.length === 0 ? (
                  <View className="items-center justify-center py-4">
                    <Text className="text-xs text-muted-foreground">
                      {t('sidebar.noProjects')}
                    </Text>
                  </View>
                ) : (
                  projects.map((project) => {
                  const ProjectIcon = ICON_MAP[project.icon || "FolderOpen"] || FolderOpen;
                  const projectConversations = allConversations.filter((conv) =>
                    project.conversationIds.includes(conv.id)
                  );

                  return (
                    <View key={project.id} className="gap-0.5">
                      {/* Project Header */}
                      <View className="flex-row items-center gap-1 rounded-xl group hover:bg-muted">
                        <Pressable
                          onPress={() => toggleProject(project.id)}
                          className="flex-1 h-9 flex-row items-center gap-2 px-2 active:bg-muted/50 rounded-xl"
                        >
                          <ProjectIcon
                            size={16}
                            className="text-muted-foreground"
                            color={project.color}
                          />
                          <Text
                            className="flex-1 text-sm md:text-xs text-foreground font-medium"
                            numberOfLines={1}
                          >
                            {project.name}
                          </Text>
                          <Text className="text-xs text-muted-foreground mr-1">
                            {projectConversations.length}
                          </Text>
                          {project.isExpanded ? (
                            <ChevronDownIcon size={14} color={colors.mutedForeground} />
                          ) : (
                            <ChevronRightIcon size={14} color={colors.mutedForeground} />
                          )}
                        </Pressable>
                        <DropdownMenu.Root>
                          <DropdownMenu.Trigger>
                            <Pressable className="h-6 w-6 items-center justify-center rounded-lg mr-1 web:opacity-0 web:group-hover:opacity-100 active:bg-muted/70">
                              <DotsHorizontalIcon size={14} color={colors.mutedForeground} />
                            </Pressable>
                          </DropdownMenu.Trigger>
                          <DropdownMenu.Content>
                            <DropdownMenu.Item key="edit" onSelect={() => handleEditProject(project, {})}>
                              <DropdownMenu.ItemIcon ios={{ name: "pencil" }} />
                              <DropdownMenu.ItemTitle>{t('sidebar.editProject')}</DropdownMenu.ItemTitle>
                            </DropdownMenu.Item>
                            <DropdownMenu.Separator />
                            <DropdownMenu.Item key="delete" destructive onSelect={() => handleDeleteProject(project.id, {})}>
                              <DropdownMenu.ItemIcon ios={{ name: "trash" }} />
                              <DropdownMenu.ItemTitle>{t('sidebar.deleteProject')}</DropdownMenu.ItemTitle>
                            </DropdownMenu.Item>
                          </DropdownMenu.Content>
                        </DropdownMenu.Root>
                      </View>

                      {/* Project Conversations */}
                      {project.isExpanded && projectConversations
                        .sort((a, b) => (favoriteConversationIds.includes(b.id) ? 1 : 0) - (favoriteConversationIds.includes(a.id) ? 1 : 0))
                        .map((conv) => (
                          <ConversationItem
                            key={conv.id}
                            conversation={conv}
                            isActive={chatId?.id === conv.id}
                            isFavorite={favoriteConversationIds.includes(conv.id)}
                            isPinned={pinnedConversationIds.includes(conv.id)}
                            currentProject={getConversationProject(conv.id)}
                            currentFolder={getConversationFolder(conv.id)}
                            projects={projects}
                            folders={folders}
                            onSelect={handleSelectConversation}
                            onPrefetch={handlePrefetchConversation}
                            onToggleFavorite={handleToggleFavorite}
                            onTogglePin={handleTogglePin}
                            onMoveToProject={handleMoveConversationToProject}
                            onMoveToFolder={handleMoveConversationToFolder}
                            onDelete={handleDeleteConversation}
                            indented
                          />
                        ))}
                    </View>
                  );
                })
                )}
              </View>
              )}
            </View>

            {/* History Subsection */}
            <View>
              <View className="flex-row items-center justify-between pt-4 pb-1 px-2">
                <Pressable
                  onPress={handleToggleHistory}
                  className="flex-row items-center gap-1 flex-1 rounded-lg active:opacity-70"
                >
                  <Text className="text-xs font-semibold text-foreground select-none">
                    History
                  </Text>
                  {historyCollapsed ? (
                    <ChevronRightIcon size={12} color={colors.foreground} />
                  ) : (
                    <ChevronDownIcon size={12} color={colors.foreground} />
                  )}
                </Pressable>
                <Pressable
                  accessibilityLabel="New folder"
                  accessibilityRole="button"
                  onPress={handleNewFolder}
                  className="h-6 w-6 items-center justify-center rounded-lg hover:bg-muted active:bg-muted"
                >
                  <PlusIcon size={14} color={colors.mutedForeground} />
                </Pressable>
              </View>
              {!historyCollapsed && (
                <View className="gap-1">
{historyConversations.length === 0 ? (
                  isLoading ? (
                    <SidebarSkeleton />
                  ) : (
                  <View className="items-center justify-center py-4">
                    <Text className="text-xs text-muted-foreground">
                      No history yet
                    </Text>
                  </View>
                  )
                ) : (
                  <>
                    {/* Render folders (always on top, favorites first) */}
                    {folders
                      .filter((folder) => {
                        const folderConvs = historyConversations.filter((conv) =>
                          folder.conversationIds.includes(conv.id)
                        );
                        return folderConvs.length > 0 || true;
                      })
                      .sort((a, b) => (b.isFavorite ? 1 : 0) - (a.isFavorite ? 1 : 0))
                      .map((folder) => {
                        const folderConversations = historyConversations.filter((conv) =>
                          folder.conversationIds.includes(conv.id)
                        );
                        return (
                          <FolderSection
                            key={folder.id}
                            folder={folder}
                            conversations={folderConversations}
                            currentChatId={chatId?.id}
                            favoriteIds={favoriteConversationIds}
                            pinnedIds={pinnedConversationIds}
                            projects={projects}
                            folders={folders}
                            onToggle={toggleFolder}
                            onEdit={handleEditFolder}
                            onDelete={handleDeleteFolder}
                            onToggleFavorite={handleToggleFavoriteFolder}
                            onSelectConversation={handleSelectConversation}
                            onToggleFavoriteConversation={handleToggleFavorite}
                            onTogglePinConversation={handleTogglePin}
                            onMoveToProject={handleMoveConversationToProject}
                            onMoveToFolder={handleMoveConversationToFolder}
                            onDeleteConversation={handleDeleteConversation}
                            onPrefetchConversation={handlePrefetchConversation}
                            getConversationProject={getConversationProject}
                            getConversationFolder={getConversationFolder}
                          />
                        );
                      })}

                    {/* Pinned conversations */}
                    {pinnedConversations.length > 0 && pinnedConversations.map((conv) => (
                      <ConversationItem
                        key={conv.id}
                        conversation={conv}
                        isActive={chatId?.id === conv.id}
                        isFavorite={favoriteConversationIds.includes(conv.id)}
                        isPinned={true}
                        currentProject={getConversationProject(conv.id)}
                        currentFolder={getConversationFolder(conv.id)}
                        projects={projects}
                        folders={folders}
                        onSelect={handleSelectConversation}
                        onPrefetch={handlePrefetchConversation}
                        onToggleFavorite={handleToggleFavorite}
                        onTogglePin={handleTogglePin}
                        onMoveToProject={handleMoveConversationToProject}
                        onMoveToFolder={handleMoveConversationToFolder}
                        onDelete={handleDeleteConversation}
                      />
                    ))}

                    {/* Standalone conversations with date grouping */}
                    <HistoryList
                      data={standaloneConversations}
                      currentChatId={chatId?.id}
                      favoriteIds={favoriteConversationIds}
                      pinnedIds={pinnedConversationIds}
                      projects={projects}
                      folders={folders}
                      isFetchingNextPage={isFetchingNextPage}
                      onSelect={handleSelectConversation}
                      onToggleFavorite={handleToggleFavorite}
                      onTogglePin={handleTogglePin}
                      onMoveToProject={handleMoveConversationToProject}
                      onMoveToFolder={handleMoveConversationToFolder}
                      onDelete={handleDeleteConversation}
                      onPrefetch={handlePrefetchConversation}
                      getConversationProject={getConversationProject}
                      getConversationFolder={getConversationFolder}
                    />
                  </>
                )}
                </View>
              )}
            </View>
        </View>
    </View>
  );

  // Share banner - floats above scroll content
  const shareBanner = isAuthenticated ? (
    <Pressable
      onPress={() => setInviteDialogOpen(true)}
      className="flex-row items-center gap-3 md:gap-2 p-2.5 md:p-2 rounded-xl bg-muted active:bg-muted/80"
    >
      <GiftIcon size={18} color={colors.foreground} />
      <View className="flex-1">
        <Text className="text-sm md:text-xs font-medium text-foreground">
          Share Alia with a friend
        </Text>
        <Text className="text-xs md:text-[10px] text-muted-foreground">
          Get 500 credits each
        </Text>
      </View>
      <ChevronRightIcon size={16} color={colors.mutedForeground} />
    </Pressable>
  ) : null;

  // Footer: icon-button bar + legal links. ProfileButton now lives in
  // topSection (right after the logo, before New Chat).
  const footer = collapsed ? (
    <View className="gap-2 items-center">
      <GhostIconButton
        icon={SidebarToggleIcon}
        label={t('sidebar.expand')}
        onPress={handleExpandSidebar}
        anchorProps={expandTooltip.anchorProps}
      />
      {expandTooltip.tooltip}
    </View>
  ) : (
    <View className="gap-2">
            {/* Icon Button Bar */}
            {isAuthenticated && (
            <View className="flex-row items-center gap-1">
              <GhostIconButton icon={UpgradePlanIcon} label={t('sidebar.upgradeToPro')} onPress={handleUpgrade} />
              <GhostIconButton
                icon={BellIcon}
                label={t('sidebar.notifications')}
                onPress={handleNotifications}
                badge={(unreadData?.count ?? 0) > 0}
              />
              <GhostIconButton icon={SettingsIcon} label="Settings" onPress={handleSettings} />
              {Platform.OS === "web" && (
                <>
                  <GhostIconButton icon={GetAppIcon} label="App download" onPress={handleAppDownload} />
                  <GhostIconButton
                    icon={ShortcutsIcon}
                    label="Keyboard shortcuts"
                    onPress={() => setShortcutsDialogOpen(true)}
                  />
                </>
              )}
            </View>
            )}

            {/* Legal links */}
            <View className="flex-row items-center justify-center gap-1">
              <Text
                className="text-[10px] text-muted-foreground underline"
                onPress={() => Linking.openURL('https://oxy.so/company/transparency/policies/privacy')}
              >
                {t('sidebar.privacyPolicy')}
              </Text>
              <Text className="text-[10px] text-muted-foreground">·</Text>
              <Text
                className="text-[10px] text-muted-foreground underline"
                onPress={() => Linking.openURL('https://oxy.so/company/transparency/policies/terms-of-service')}
              >
                {t('sidebar.termsOfService')}
              </Text>
            </View>
    </View>
  );

  return (
    <>
      <BaseSidebar
        collapsed={collapsed}
        header={header}
        topSection={topSection}
        navigation={navigation}
        scrollableContent={scrollableContent}
        scrollOverlay={collapsed ? null : shareBanner}
        footer={footer}
        backgroundColor="bg-background"
        onScroll={handleScroll}
        showScrollIndicator={false}
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
