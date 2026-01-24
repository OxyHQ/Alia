import React from "react";
import { View, Pressable, ScrollView, NativeSyntheticEvent, NativeScrollEvent } from "react-native";
import { Image } from "expo-image";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Sparkles,
  Trash2,
  Users,
  Settings2,
  Sparkle,
  UserCircle,
  CreditCard,
  Bell,
  LogOut,
  LogIn,
  UserPlus,
  Library,
  FolderOpen,
  Plus,
  BrainCircuit,
  Code,
  MoreHorizontal,
  Edit,
  Briefcase,
  Folder,
  Package,
  Rocket,
  Target,
  Lightbulb,
  Star as StarIcon,
  Heart,
  Zap,
  ChevronDown,
  ChevronRight,
  Archive,
  Inbox,
  BookMarked,
  FolderClosed,
  type LucideIcon,
} from "lucide-react-native";
import { useStore } from "@/lib/globalStore";
import { useRouter } from "expo-router";
import { useAuth } from "@oxyhq/services";
import { useProjectsStore } from "@/lib/stores/projects-store";
import { useFoldersStore } from "@/lib/stores/folders-store";
import { useFavoritesStore } from "@/lib/stores/favorites-store";
import { useConversations, useDeleteConversation } from "@/lib/hooks/use-conversations";
import { groupConversationsByDate, flattenGroupedConversations } from "@/lib/utils/conversation-grouping";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ProjectEditDialog } from "@/components/project-edit-dialog";
import { FolderEditDialog } from "@/components/folder-edit-dialog";
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

export const Sidebar = React.memo(function Sidebar() {
  const router = useRouter();
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

  // Flatten all pages into a single array
  const allConversations = React.useMemo(() => {
    return data?.pages.flatMap(page => page.conversations) || [];
  }, [data]);
  const { user, isAuthenticated, logout } = useAuth();
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

  const [editDialogOpen, setEditDialogOpen] = React.useState(false);
  const [editingProject, setEditingProject] = React.useState<Project | null>(null);
  const [folderEditDialogOpen, setFolderEditDialogOpen] = React.useState(false);
  const [editingFolder, setEditingFolder] = React.useState<FolderType | null>(null);
  const [projectsCollapsed, setProjectsCollapsed] = React.useState(false);
  const [historyCollapsed, setHistoryCollapsed] = React.useState(false);

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

  const handleSelectConversation = React.useCallback((id: string) => {
    // Use replace to avoid accumulating chat history in navigation stack
    router.replace(`/(app)/c/${id}`);
  }, [router]);

  const handleDeleteConversation = React.useCallback((id: string, e: any) => {
    e.stopPropagation();
    deleteConversationMutation.mutate(id);
  }, [deleteConversationMutation]);

  const handleSettings = React.useCallback(() => {
    router.push("/(app)/settings");
  }, [router]);

  const handleAccount = React.useCallback(() => {
    router.push("/(app)/settings/account");
  }, [router]);

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

  const handleLibrary = React.useCallback(() => {
    router.push("/(app)/library");
  }, [router]);

  const handleRoles = React.useCallback(() => {
    router.push("/(app)/roles");
  }, [router]);

  const handleDevelopers = React.useCallback(() => {
    router.push("/developers");
  }, [router]);

  const handleSelectProject = React.useCallback((id: string | null) => {
    setCurrentProject(id);
  }, [setCurrentProject]);

  const handleNewProject = React.useCallback(() => {
    setEditingProject(null);
    setEditDialogOpen(true);
  }, []);

  const handleEditProject = React.useCallback((project: Project, e: any) => {
    e.stopPropagation();
    setEditingProject(project);
    setEditDialogOpen(true);
  }, []);

  const handleDeleteProject = React.useCallback(async (id: string, e: any) => {
    e.stopPropagation();
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
      e.stopPropagation();

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
    e.stopPropagation();
    setEditingFolder(folder);
    setFolderEditDialogOpen(true);
  }, []);

  const handleDeleteFolder = React.useCallback(async (id: string, e: any) => {
    e.stopPropagation();
    await deleteFolder(id);
  }, [deleteFolder]);

  const handleToggleFavoriteFolder = React.useCallback(async (folder: FolderType, e: any) => {
    e.stopPropagation();
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
      e.stopPropagation();

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
      e.stopPropagation();
      await toggleFavorite(conversationId);
    },
    [toggleFavorite]
  );

  // Get user initials for avatar
  const getUserInitials = React.useCallback(() => {
    if (!user?.name) return user?.username?.[0]?.toUpperCase() || "U";
    const { first, last } = user.name;
    if (first && last) {
      return `${first[0]}${last[0]}`.toUpperCase();
    }
    return (first?.[0] || user?.username?.[0] || "U").toUpperCase();
  }, [user]);

  // Get display name for user
  const getUserDisplayName = React.useCallback(() => {
    if (!user) return "User";
    if (user.name?.first) {
      return user.name.last ? `${user.name.first} ${user.name.last}` : user.name.first;
    }
    return user.username || "User";
  }, [user]);

  // Get standalone conversations (not in folders)
  const standaloneConversations = React.useMemo(() => {
    const conversationsInFolders = new Set<string>();
    folders.forEach((folder) => {
      folder.conversationIds.forEach((id) => conversationsInFolders.add(id));
    });
    return conversationsNotInProjects.filter((conv) => !conversationsInFolders.has(conv.id));
  }, [conversationsNotInProjects, folders]);

  // Group standalone conversations by date
  const groupedStandaloneConversations = React.useMemo(() => {
    return groupConversationsByDate(standaloneConversations);
  }, [standaloneConversations]);

  const flattenedStandaloneConversations = React.useMemo(() => {
    return flattenGroupedConversations(groupedStandaloneConversations);
  }, [groupedStandaloneConversations]);

  // Handle scroll for infinite loading
  const handleScroll = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
    const paddingToBottom = 100;
    const isCloseToBottom = layoutMeasurement.height + contentOffset.y >= contentSize.height - paddingToBottom;

    if (isCloseToBottom && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <View className="flex-1 bg-surface">
      {/* Header with Logo */}
      <View className="border-b border-border/50 p-4 md:p-3">
        <Pressable onPress={handleLogoPress} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
          <Image
            source={require("@/assets/images/logo.png")}
            style={{ width: "100%", height: 48 }}
            contentFit="contain"
          />
        </Pressable>
      </View>

      {/* New Chat Button */}
      <View className="p-3 md:p-2">
        <Button
          onPress={handleNewChat}
          variant="outline"
          className="h-11 md:h-9 rounded-full w-full"
        >
          <View className="flex-row items-center gap-2">
            <Sparkles size={16} className="text-primary" />
            <Text className="text-sm md:text-xs font-medium">
              New Chat
            </Text>
          </View>
        </Button>
      </View>

      {/* Scrollable Content */}
      <ScrollView
        className="flex-1"
        onScroll={handleScroll}
        scrollEventThrottle={400}
        showsVerticalScrollIndicator={false}
      >
        {/* Navigation Links */}
        <View className="px-3 md:px-2 pb-3 md:pb-2 pt-3 md:pt-2 gap-1">
        <Button
          variant="ghost"
          className="h-10 md:h-8 flex-row items-center justify-start gap-2 rounded-full px-3 md:px-2 w-full"
          onPress={handleRoles}
        >
          <BrainCircuit size={16} className="text-muted-foreground" />
          <Text className="text-sm md:text-xs">Roles</Text>
        </Button>
        <Button
          variant="ghost"
          className="h-10 md:h-8 flex-row items-center justify-start gap-2 rounded-full px-3 md:px-2 w-full"
        >
          <Users size={16} className="text-muted-foreground" />
          <Text className="text-sm md:text-xs">Agents</Text>
        </Button>
        <Button
          variant="ghost"
          className="h-10 md:h-8 flex-row items-center justify-start gap-2 rounded-full px-3 md:px-2 w-full"
          onPress={handleLibrary}
        >
          <Library size={16} className="text-muted-foreground" />
          <Text className="text-sm md:text-xs">Library</Text>
        </Button>
        <Button
          variant="ghost"
          className="h-10 md:h-8 flex-row items-center justify-start gap-2 rounded-full px-3 md:px-2 w-full"
          onPress={handleDevelopers}
        >
          <Code size={16} className="text-muted-foreground" />
          <Text className="text-sm md:text-xs">Developers</Text>
        </Button>
        <Button
          variant="ghost"
          className="h-10 md:h-8 flex-row items-center justify-start gap-2 rounded-full px-3 md:px-2 w-full"
          onPress={handleSettings}
        >
          <Settings2 size={16} className="text-muted-foreground" />
          <Text className="text-sm md:text-xs">
            Settings
          </Text>
        </Button>
      </View>

      {/* Projects and History Section */}
      <View className="px-3 md:px-2">
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
                    Projects
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
                      No projects yet
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
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Pressable className="h-8 w-8 items-center justify-center rounded-full mr-1 active:bg-muted/70">
                              <MoreHorizontal size={14} className="text-muted-foreground" />
                            </Pressable>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent side="bottom" align="end" className="w-48">
                            <DropdownMenuItem onPress={(e) => handleEditProject(project, e)}>
                              <Edit size={16} className="text-muted-foreground" />
                              <Text className="text-sm">Edit Project</Text>
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              variant="destructive"
                              onPress={(e) => handleDeleteProject(project.id, e)}
                            >
                              <Trash2 size={16} className="text-destructive" />
                              <Text className="text-sm">Delete Project</Text>
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
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
                            currentProject={getConversationProject(conv.id)}
                            currentFolder={getConversationFolder(conv.id)}
                            projects={projects}
                            folders={folders}
                            onSelect={handleSelectConversation}
                            onToggleFavorite={handleToggleFavorite}
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
                      {isLoading ? 'Loading...' : 'No history yet'}
                    </Text>
                  </View>
                ) : (
                  <>
                    {/* Render folders (favorites at top) */}
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
                            projects={projects}
                            folders={folders}
                            onToggle={toggleFolder}
                            onEdit={handleEditFolder}
                            onDelete={handleDeleteFolder}
                            onToggleFavorite={handleToggleFavoriteFolder}
                            onSelectConversation={handleSelectConversation}
                            onToggleFavoriteConversation={handleToggleFavorite}
                            onMoveToProject={handleMoveConversationToProject}
                            onMoveToFolder={handleMoveConversationToFolder}
                            onDeleteConversation={handleDeleteConversation}
                            getConversationProject={getConversationProject}
                            getConversationFolder={getConversationFolder}
                          />
                        );
                      })}

                    {/* Standalone conversations with date grouping */}
                    <HistoryList
                      data={flattenedStandaloneConversations}
                      currentChatId={chatId?.id}
                      favoriteIds={favoriteConversationIds}
                      projects={projects}
                      folders={folders}
                      isFetchingNextPage={isFetchingNextPage}
                      onSelect={handleSelectConversation}
                      onToggleFavorite={handleToggleFavorite}
                      onMoveToProject={handleMoveConversationToProject}
                      onMoveToFolder={handleMoveConversationToFolder}
                      onDelete={handleDeleteConversation}
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
      </ScrollView>

      {/* Footer with User or Auth Buttons */}
      <View className="border-t border-border/50 p-3 md:p-2">
        {isAuthenticated ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Pressable className="flex-row items-center gap-3 md:gap-2 rounded-full p-2 md:p-1.5 active:bg-muted">
                <Avatar className="h-8 w-8 md:h-7 md:w-7">
                  {user?.avatar ? (
                    <AvatarImage source={{ uri: user.avatar }} />
                  ) : null}
                  <AvatarFallback className="bg-primary">
                    <Text className="text-xs md:text-[10px] text-primary-foreground">{getUserInitials()}</Text>
                  </AvatarFallback>
                </Avatar>
                <View className="flex-1">
                  <Text className="text-sm md:text-xs font-medium text-foreground">
                    {getUserDisplayName()}
                  </Text>
                  <Text className="text-xs md:text-[10px] text-muted-foreground">
                    {user?.email || ""}
                  </Text>
                </View>
              </Pressable>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side="top"
              align="start"
              className="w-64"
            >
              <View className="flex flex-col space-y-1 p-2">
                <Text className="text-sm font-medium text-foreground">{getUserDisplayName()}</Text>
                <Text className="text-xs text-muted-foreground">{user?.email || ""}</Text>
              </View>
              <DropdownMenuSeparator />
              <DropdownMenuItem>
                <Sparkle size={16} className="text-muted-foreground" />
                <Text className="text-sm">Upgrade to Pro</Text>
              </DropdownMenuItem>
              <DropdownMenuItem onPress={handleAccount}>
                <UserCircle size={16} className="text-muted-foreground" />
                <Text className="text-sm">Account</Text>
              </DropdownMenuItem>
              <DropdownMenuItem>
                <CreditCard size={16} className="text-muted-foreground" />
                <Text className="text-sm">Billing</Text>
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Bell size={16} className="text-muted-foreground" />
                <Text className="text-sm">Notifications</Text>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onPress={handleLogout}>
                <LogOut size={16} className="text-destructive" />
                <Text className="text-sm">Log out</Text>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <View className="gap-2 md:gap-1.5">
            <Button
              onPress={handleLogin}
              className="h-11 md:h-9 rounded-full w-full"
            >
              <View className="flex-row items-center gap-2 md:gap-1.5">
                <LogIn size={16} className="text-primary-foreground" />
                <Text className="text-sm md:text-xs font-semibold text-primary-foreground">
                  Sign in
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
                  Sign up
                </Text>
              </View>
            </Button>
          </View>
        )}
      </View>

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
    </View>
  );
});
