import React from "react";
import { View, Pressable, Platform, NativeSyntheticEvent, NativeScrollEvent, Linking } from "react-native";
import { AliaLogo } from "@/components/ui/alia-logo";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { BaseSidebar } from "@/components/base-sidebar";
import {
  Users,
  Settings2,
  LogIn,
  UserPlus,
  Library,
  FolderOpen,
  Plus,
  BrainCircuit,
  Code,
  BookOpen,
  CloudCog,
  MoreHorizontal,
  Briefcase,
  Folder,
  Package,
  Rocket,
  Target,
  Lightbulb,
  Star as StarIcon,
  UsersRound,
  Heart,
  Zap,
  ChevronDown,
  ChevronRight,
  Archive,
  Inbox,
  BookMarked,
  FolderClosed,
  Gift,
  Smartphone,
  Keyboard,
  ListTodo,
  Mic,
  type LucideIcon,
} from "lucide-react-native";
import { useTranslation } from "@/hooks/useTranslation";
import { useStore } from "@/lib/globalStore";
import { useRouter, usePathname } from "expo-router";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";
import { useOxy } from "@oxyhq/services";
import { useProjectsStore } from "@/lib/stores/projects-store";
import { useFoldersStore } from "@/lib/stores/folders-store";
import { useFavoritesStore } from "@/lib/stores/favorites-store";
import { usePinnedStore } from "@/lib/stores/pinned-store";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/hooks/query-keys";
import { useConversations, useDeleteConversation, prefetchConversation } from "@/lib/hooks/use-conversations";
import * as DropdownMenu from "@/components/ui/dropdown-menu";
import { ProjectEditDialog } from "@/components/project-edit-dialog";
import { InviteDialog } from "@/components/invite-dialog";
import { AppDownloadDialog } from "@/components/app-download-dialog";
import { FolderEditDialog } from "@/components/folder-edit-dialog";
import { useUIStore } from "@/lib/stores/ui-store";
import { useUnreadCount } from "@/lib/hooks/use-notifications";
import { ConversationItem } from "@/components/sidebar/conversation-item";
import { FolderSection } from "@/components/sidebar/folder-section";
import { HistoryList } from "@/components/sidebar/history-list";
import type { Project } from "@/lib/stores/projects-store";
import type { Folder as FolderType } from "@/lib/stores/folders-store";

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

export function Sidebar() {
  const pathname = usePathname();
  const isSettingsRoute = pathname.startsWith("/settings");

  if (isSettingsRoute) {
    return <SettingsSidebar />;
  }

  return <ChatSidebar />;
}

const ChatSidebar = React.memo(function ChatSidebar() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
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
  const { user, isAuthenticated, logout, showBottomSheet } = useOxy();
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
  const [agentsExpanded, setAgentsExpanded] = React.useState(false);
  const [projectsCollapsed, setProjectsCollapsed] = React.useState(false);
  const [historyCollapsed, setHistoryCollapsed] = React.useState(false);
  const [inviteDialogOpen, setInviteDialogOpen] = React.useState(false);
  const [appDownloadDialogOpen, setAppDownloadDialogOpen] = React.useState(false);

  // Group and flatten conversations for display
  const conversationsNotInProjects = React.useMemo(() => {
    return allConversations.filter((conv) =>
      !projects.some((p) => p.conversationIds.includes(conv.id))
    );
  }, [allConversations, projects]);

  const handleNewChat = React.useCallback(() => {
    // Navigate to home page
    router.replace("/(app)");
  }, [router]);

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

  const handleDeleteConversation = React.useCallback((id: string, e: any) => {
    e?.stopPropagation?.();
    deleteConversationMutation.mutate(id);
  }, [deleteConversationMutation]);

  const handleSettings = React.useCallback(() => {
    router.push("/(app)/settings");
  }, [router]);

  const handleAccount = React.useCallback(() => {
    showBottomSheet('AccountSettings');
  }, [showBottomSheet]);

  const handleLogout = React.useCallback(() => {
    logout();
    router.replace("/login");
  }, [router, logout]);

  const handleLogin = React.useCallback(() => {
    router.push("/login");
  }, [router]);

  const handleRegister = React.useCallback(() => {
    router.push("/register");
  }, [router]);

  const handleFavorites = React.useCallback(() => {
    router.push("/(app)/favorites");
  }, [router]);

  const handleLibrary = React.useCallback(() => {
    router.push("/(app)/library");
  }, [router]);

  const handleRoles = React.useCallback(() => {
    router.push("/(app)/roles");
  }, [router]);

  const handleTasks = React.useCallback(() => {
    router.push("/(app)/tasks" as any);
  }, [router]);

  const handleAutomations = React.useCallback(() => {
    router.push("/(app)/automations");
  }, [router]);

  const handleSkills = React.useCallback(() => {
    router.push("/(app)/skills");
  }, [router]);

  const handleShows = React.useCallback(() => {
    router.push("/(app)/shows" as any);
  }, [router]);

  const handleAgents = React.useCallback(() => {
    router.push("/(app)/agents");
  }, [router]);

  const handleAgentTeams = React.useCallback(() => {
    router.push("/(app)/agents/teams" as any);
  }, [router]);

  const handleToggleAgents = React.useCallback(() => {
    setAgentsExpanded((prev) => !prev);
  }, []);

  const handleConsole = React.useCallback(() => {
    Linking.openURL("https://console.alia.onl");
  }, []);

  const handleAppDownload = React.useCallback(() => {
    setAppDownloadDialogOpen(true);
  }, []);

  const handleDocs = React.useCallback(() => {
    Linking.openURL("https://console.alia.onl/documentation");
  }, []);

  const handleUpgrade = React.useCallback(() => {
    router.push("/(biglayout)/subscribe");
  }, [router]);

  const handleBilling = React.useCallback(() => {
    router.push("/(app)/settings/usage");
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

  const handleEditProject = React.useCallback((project: Project, e: any) => {
    e?.stopPropagation?.();
    setEditingProject(project);
    setEditDialogOpen(true);
  }, []);

  const handleDeleteProject = React.useCallback(async (id: string, e: any) => {
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
    async (conversationId: string, projectId: string | null, e: any) => {
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

  const handleEditFolder = React.useCallback((folder: FolderType, e: any) => {
    e?.stopPropagation?.();
    setEditingFolder(folder);
    setFolderEditDialogOpen(true);
  }, []);

  const handleDeleteFolder = React.useCallback(async (id: string, e: any) => {
    e?.stopPropagation?.();
    await deleteFolder(id);
  }, [deleteFolder]);

  const handleToggleFavoriteFolder = React.useCallback(async (folder: FolderType, e: any) => {
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
    async (conversationId: string, folderId: string | null, e: any) => {
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
    async (conversationId: string, e: any) => {
      e?.stopPropagation?.();
      await toggleFavorite(conversationId);
    },
    [toggleFavorite]
  );

  const handleTogglePin = React.useCallback(
    async (conversationId: string, e: any) => {
      e?.stopPropagation?.();
      await togglePin(conversationId);
    },
    [togglePin]
  );

  // Get display name for user
  const getUserDisplayName = React.useCallback(() => {
    if (!user) return t('common.user');
    if (user.name?.first) {
      return user.name.last ? `${user.name.first} ${user.name.last}` : user.name.first;
    }
    return user.username || t('common.user');
  }, [user, t]);

  // Get pinned conversations (from all conversations not in projects)
  const pinnedConversations = React.useMemo(() => {
    return conversationsNotInProjects.filter((conv) =>
      pinnedConversationIds.includes(conv.id)
    );
  }, [conversationsNotInProjects, pinnedConversationIds]);

  // Get standalone conversations (not in folders and not pinned)
  const standaloneConversations = React.useMemo(() => {
    const conversationsInFolders = new Set<string>();
    folders.forEach((folder) => {
      folder.conversationIds.forEach((id) => conversationsInFolders.add(id));
    });
    return conversationsNotInProjects.filter((conv) =>
      !conversationsInFolders.has(conv.id) && !pinnedConversationIds.includes(conv.id)
    );
  }, [conversationsNotInProjects, folders, pinnedConversationIds]);

  // Handle scroll for infinite loading
  const handleScroll = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
    const paddingToBottom = 100;
    const isCloseToBottom = layoutMeasurement.height + contentOffset.y >= contentSize.height - paddingToBottom;

    if (isCloseToBottom && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Header component
  const header = (
    <Pressable onPress={handleLogoPress} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
      <AliaLogo height={48} />
    </Pressable>
  );

  // Top section with New Chat button
  const topSection = (
    <View className="gap-2">
      <Button
        onPress={handleNewChat}
        className="h-11 md:h-9 rounded-full w-full"
      >
        <Text className="text-sm md:text-xs font-medium text-primary-foreground">
          {t('sidebar.newChat')}
        </Text>
      </Button>
    </View>
  );

  // Navigation links
  const navigation = (
    <>
        <Button
          variant="ghost"
          className="h-10 md:h-8 flex-row items-center justify-start gap-2 rounded-full px-3 md:px-2 w-full"
          onPress={handleRoles}
        >
          <BrainCircuit size={16} className="text-muted-foreground" />
          <Text className="text-sm md:text-xs">{t('sidebar.roles')}</Text>
        </Button>
        <View>
          <Pressable
            onPress={handleToggleAgents}
            className="h-10 md:h-8 flex-row items-center justify-between rounded-full px-3 md:px-2 w-full active:opacity-70"
          >
            <View className="flex-row items-center gap-2">
              <Users size={16} className="text-muted-foreground" />
              <Text className="text-sm md:text-xs text-foreground">{t('sidebar.agents')}</Text>
            </View>
            {agentsExpanded ? (
              <ChevronDown size={12} className="text-muted-foreground" />
            ) : (
              <ChevronRight size={12} className="text-muted-foreground" />
            )}
          </Pressable>
          {agentsExpanded && (
            <View className="ml-5 gap-0.5">
              <Button
                variant="ghost"
                className="h-9 md:h-7 flex-row items-center justify-start gap-2 rounded-full px-3 md:px-2 w-full"
                onPress={handleAgents}
              >
                <Users size={14} className="text-muted-foreground" />
                <Text className="text-xs">{t('agents.allAgents')}</Text>
              </Button>
              <Button
                variant="ghost"
                className="h-9 md:h-7 flex-row items-center justify-start gap-2 rounded-full px-3 md:px-2 w-full"
                onPress={handleAgentTeams}
              >
                <UsersRound size={14} className="text-muted-foreground" />
                <Text className="text-xs">{t('agents.teams')}</Text>
              </Button>
            </View>
          )}
        </View>
        <Button
          variant="ghost"
          className="h-10 md:h-8 flex-row items-center justify-start gap-2 rounded-full px-3 md:px-2 w-full"
          onPress={handleFavorites}
        >
          <StarIcon size={16} className="text-muted-foreground" />
          <Text className="text-sm md:text-xs">Favorites</Text>
        </Button>
        <Button
          variant="ghost"
          className="h-10 md:h-8 flex-row items-center justify-start gap-2 rounded-full px-3 md:px-2 w-full"
          onPress={handleLibrary}
        >
          <Library size={16} className="text-muted-foreground" />
          <Text className="text-sm md:text-xs">{t('sidebar.library')}</Text>
        </Button>
        <Button
          variant="ghost"
          className="h-10 md:h-8 flex-row items-center justify-start gap-2 rounded-full px-3 md:px-2 w-full"
          onPress={handleTasks}
        >
          <ListTodo size={16} className="text-muted-foreground" />
          <Text className="text-sm md:text-xs">Tasks</Text>
        </Button>
        <Button
          variant="ghost"
          className="h-10 md:h-8 flex-row items-center justify-start gap-2 rounded-full px-3 md:px-2 w-full"
          onPress={handleAutomations}
        >
          <CloudCog size={16} className="text-muted-foreground" />
          <Text className="text-sm md:text-xs">{t('sidebar.automations')}</Text>
        </Button>
        <Button
          variant="ghost"
          className="h-10 md:h-8 flex-row items-center justify-start gap-2 rounded-full px-3 md:px-2 w-full"
          onPress={handleSkills}
        >
          <BookOpen size={16} className="text-muted-foreground" />
          <Text className="text-sm md:text-xs">{t('sidebar.skills')}</Text>
        </Button>
        <Button
          variant="ghost"
          className="h-10 md:h-8 flex-row items-center justify-start gap-2 rounded-full px-3 md:px-2 w-full"
          onPress={handleShows}
        >
          <Mic size={16} className="text-muted-foreground" />
          <Text className="text-sm md:text-xs">Shows</Text>
        </Button>
    </>
  );

  // Scrollable content - Projects and History
  const scrollableContent = (
    <View className="gap-2">
        <View className="gap-2">
            {/* Projects Subsection */}
            <View>
              <View className="flex-row items-center justify-between px-2 py-1.5 md:py-1">
                <Pressable
                  onPress={handleToggleProjects}
                  className="flex-row items-center gap-1 flex-1 active:opacity-70"
                >
                  {projectsCollapsed ? (
                    <ChevronRight size={12} className="text-muted-foreground" />
                  ) : (
                    <ChevronDown size={12} className="text-muted-foreground" />
                  )}
                  <Text className="text-xs font-medium text-muted-foreground">
                    {t('sidebar.projects')}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={handleNewProject}
                  className="h-5 w-5 md:h-4 md:w-4 rounded active:opacity-70"
                >
                  <Plus size={12} className="text-muted-foreground" />
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
                      <View className="flex-row items-center gap-1 rounded-lg group">
                        <Pressable
                          onPress={() => toggleProject(project.id)}
                          className="flex-1 flex-row items-center gap-2 py-2 px-2 active:bg-muted/50 rounded-lg"
                        >
                          <ProjectIcon
                            size={16}
                            className="text-muted-foreground"
                            style={{ color: project.color }}
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
                            <ChevronDown size={14} className="text-muted-foreground" />
                          ) : (
                            <ChevronRight size={14} className="text-muted-foreground" />
                          )}
                        </Pressable>
                        <DropdownMenu.Root>
                          <DropdownMenu.Trigger>
                            <Pressable className="h-8 w-8 items-center justify-center rounded-full mr-1 active:bg-muted/70">
                              <MoreHorizontal size={14} className="text-muted-foreground" />
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
              <View className="flex-row items-center justify-between px-2 py-1.5 md:py-1">
                <Pressable
                  onPress={handleToggleHistory}
                  className="flex-row items-center gap-1 flex-1 active:opacity-70"
                >
                  {historyCollapsed ? (
                    <ChevronRight size={12} className="text-muted-foreground" />
                  ) : (
                    <ChevronDown size={12} className="text-muted-foreground" />
                  )}
                  <Text className="text-xs font-medium text-muted-foreground">
                    History
                  </Text>
                </Pressable>
                <Pressable
                  onPress={handleNewFolder}
                  className="h-5 w-5 md:h-4 md:w-4 rounded active:opacity-70"
                >
                  <Plus size={12} className="text-muted-foreground" />
                </Pressable>
              </View>
              {!historyCollapsed && (
                <View className="gap-1">
{conversationsNotInProjects.length === 0 ? (
                  <View className="items-center justify-center py-4">
                    <Text className="text-xs text-muted-foreground">
                      {isLoading ? t('common.loading') : 'No history yet'}
                    </Text>
                  </View>
                ) : (
                  <>
                    {/* Render folders (always on top, favorites first) */}
                    {folders
                      .filter((folder) => {
                        const folderConvs = conversationsNotInProjects.filter((conv) =>
                          folder.conversationIds.includes(conv.id)
                        );
                        return folderConvs.length > 0 || true;
                      })
                      .sort((a, b) => (b.isFavorite ? 1 : 0) - (a.isFavorite ? 1 : 0))
                      .map((folder) => {
                        const folderConversations = conversationsNotInProjects.filter((conv) =>
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
                        compact
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
      <Gift size={18} className="text-foreground" />
      <View className="flex-1">
        <Text className="text-sm md:text-xs font-medium text-foreground">
          Share Alia with a friend
        </Text>
        <Text className="text-xs md:text-[10px] text-muted-foreground">
          Get 500 credits each
        </Text>
      </View>
      <ChevronRight size={16} className="text-muted-foreground" />
    </Pressable>
  ) : null;

  // Footer with icon bar or auth buttons
  const footer = (
    <>
        {isAuthenticated ? (
          <View className="gap-2">
            {/* Icon Button Bar */}
            <View className="flex-row items-center">
              {/* User avatar - opens account dropdown */}
              <DropdownMenu.Root>
                <DropdownMenu.Trigger>
                  <Pressable className="h-9 w-9 md:h-8 md:w-8 items-center justify-center rounded-lg hover:bg-muted active:bg-muted">
                    <View className="h-6 w-6 rounded-full bg-muted items-center justify-center">
                      <Text className="text-[10px] font-bold text-foreground">
                        {(user?.name?.first?.[0] || user?.username?.[0] || "U").toUpperCase()}
                      </Text>
                    </View>
                    {(unreadData?.count ?? 0) > 0 && (
                      <View className="absolute top-0.5 right-0.5 h-2.5 w-2.5 rounded-full bg-red-500 border border-background" />
                    )}
                  </Pressable>
                </DropdownMenu.Trigger>
                <DropdownMenu.Content>
                  {Platform.OS === 'web' ? (
                    <View className="flex-row items-center gap-2.5 px-1.5 py-1.5">
                      <View className="h-9 w-9 rounded-full bg-muted items-center justify-center">
                        <Text className="text-xs font-bold text-foreground">
                          {(user?.name?.first?.[0] || user?.username?.[0] || "U").toUpperCase()}
                        </Text>
                      </View>
                      <View>
                        <Text className="text-sm font-semibold text-foreground">{getUserDisplayName()}</Text>
                        {user?.username && <Text className="text-xs text-muted-foreground">{user.username}@oxy.so</Text>}
                      </View>
                    </View>
                  ) : (
                    <DropdownMenu.Label>{getUserDisplayName()}</DropdownMenu.Label>
                  )}
                  <DropdownMenu.Separator />
                  <DropdownMenu.Item key="upgrade" onSelect={handleUpgrade}>
                    <DropdownMenu.ItemIcon ios={{ name: "sparkle" }} />
                    <DropdownMenu.ItemTitle>{t('sidebar.upgradeToPro')}</DropdownMenu.ItemTitle>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item key="account" onSelect={handleAccount}>
                    <DropdownMenu.ItemIcon ios={{ name: "person.circle" }} />
                    <DropdownMenu.ItemTitle>{t('sidebar.account')}</DropdownMenu.ItemTitle>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item key="billing" onSelect={handleBilling}>
                    <DropdownMenu.ItemIcon ios={{ name: "creditcard" }} />
                    <DropdownMenu.ItemTitle>{t('sidebar.billing')}</DropdownMenu.ItemTitle>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item key="notifications" onSelect={handleNotifications}>
                    <DropdownMenu.ItemIcon ios={{ name: "bell" }} />
                    <DropdownMenu.ItemTitle>{t('sidebar.notifications')}</DropdownMenu.ItemTitle>
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator />
                  <DropdownMenu.Item key="terms" onSelect={() => Linking.openURL('https://oxy.so/company/transparency/policies/terms-of-service')}>
                    <DropdownMenu.ItemIcon ios={{ name: "doc.text" }} />
                    <DropdownMenu.ItemTitle>{t('sidebar.termsOfService')}</DropdownMenu.ItemTitle>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item key="privacy" onSelect={() => Linking.openURL('https://oxy.so/company/transparency/policies/privacy')}>
                    <DropdownMenu.ItemIcon ios={{ name: "hand.raised" }} />
                    <DropdownMenu.ItemTitle>{t('sidebar.privacyPolicy')}</DropdownMenu.ItemTitle>
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator />
                  <DropdownMenu.Item key="logout" destructive onSelect={handleLogout}>
                    <DropdownMenu.ItemIcon ios={{ name: "rectangle.portrait.and.arrow.right" }} />
                    <DropdownMenu.ItemTitle>{t('sidebar.logOut')}</DropdownMenu.ItemTitle>
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Root>

              {/* Settings */}
              <Pressable
                onPress={handleSettings}
                className="h-9 w-9 md:h-8 md:w-8 items-center justify-center rounded-lg hover:bg-muted active:bg-muted"
              >
                <Settings2 size={18} className="text-muted-foreground" />
              </Pressable>

              {/* App Download - web only */}
              {Platform.OS === "web" && (
                <Pressable
                  onPress={handleAppDownload}
                  className="h-9 w-9 md:h-8 md:w-8 items-center justify-center rounded-lg hover:bg-muted active:bg-muted"
                >
                  <Smartphone size={18} className="text-muted-foreground" />
                </Pressable>
              )}

              {/* Console - web only */}
              {Platform.OS === "web" && (
                <Pressable
                  onPress={handleConsole}
                  className="h-9 w-9 md:h-8 md:w-8 items-center justify-center rounded-lg hover:bg-muted active:bg-muted"
                >
                  <Code size={18} className="text-muted-foreground" />
                </Pressable>
              )}

              {/* Keyboard Shortcuts - web only */}
              {Platform.OS === "web" && (
                <Pressable
                  onPress={() => setShortcutsDialogOpen(true)}
                  className="h-9 w-9 md:h-8 md:w-8 items-center justify-center rounded-lg hover:bg-muted active:bg-muted"
                >
                  <Keyboard size={18} className="text-muted-foreground" />
                </Pressable>
              )}

              {/* Spacer */}
              <View className="flex-1" />

              {/* Docs */}
              <Pressable
                onPress={handleDocs}
                className="h-9 w-9 md:h-8 md:w-8 items-center justify-center rounded-lg hover:bg-muted active:bg-muted"
              >
                <BookOpen size={18} className="text-muted-foreground" />
              </Pressable>
            </View>
          </View>
        ) : (
          <View className="gap-2 md:gap-1.5">
            <Button
              onPress={handleLogin}
              className="h-11 md:h-9 rounded-full w-full"
            >
              <View className="flex-row items-center gap-2 md:gap-1.5">
                <LogIn size={16} className="text-primary-foreground" />
                <Text className="text-sm md:text-xs font-semibold text-primary-foreground">
                  {t('login.signInButton')}
                </Text>
              </View>
            </Button>
            <Button
              onPress={handleRegister}
              variant="outline"
              className="h-11 md:h-9 rounded-full w-full"
            >
              <View className="flex-row items-center gap-2 md:gap-1.5">
                <UserPlus size={16} className="text-foreground" />
                <Text className="text-sm md:text-xs font-medium">
                  {t('login.footerLink')}
                </Text>
              </View>
            </Button>
            <View className="flex-row items-center justify-center gap-1 mt-1">
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
        )}
    </>
  );

  return (
    <>
      <BaseSidebar
        header={header}
        topSection={topSection}
        navigation={navigation}
        scrollableContent={scrollableContent}
        scrollOverlay={shareBanner}
        footer={footer}
        backgroundColor="bg-sidebar"
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
