import React from "react";
import { View, Pressable, Platform, NativeSyntheticEvent, NativeScrollEvent, Linking } from "react-native";
import { AliaLogo } from "@/components/ui/alia-logo";
import { AliaMark } from "@alia.onl/sdk";
import { Text } from "@/components/ui/text";
import { BaseSidebar } from "@/components/base-sidebar";
import {
  Users,
  Settings2,
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
  ChevronsLeft,
  ChevronsRight,
  History as HistoryIcon,
  Archive,
  Inbox,
  BookMarked,
  FolderClosed,
  Gift,
  Smartphone,
  Keyboard,
  ListTodo,
  Mic,
  Bell,
  CreditCard,
  Sparkles,
  type LucideIcon,
} from "lucide-react-native";
import { Portal } from "@oxyhq/bloom/portal";
import { cn } from "@/lib/utils";
import { useIsLargeScreen } from "@/hooks/useIsLargeScreen";
import { useTranslation } from "@/hooks/useTranslation";
import { useStore } from "@/lib/globalStore";
import { useRouter, usePathname, useNavigation } from "expo-router";
import type { DrawerNavigationProp } from "expo-router/drawer";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";
import { useOxy, useAuth, ProfileButton } from "@oxyhq/services";
import { useProjectsStore } from "@/lib/stores/projects-store";
import { useFoldersStore } from "@/lib/stores/folders-store";
import { useFavoritesStore } from "@/lib/stores/favorites-store";
import { usePinnedStore } from "@/lib/stores/pinned-store";
import { SidebarSkeleton } from "@/components/sidebar-skeleton";
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

interface RailTooltipHandle {
  anchorProps: {
    ref: React.RefObject<View | null>;
    onHoverIn: () => void;
    onHoverOut: () => void;
  };
  tooltip: React.ReactNode;
}

/**
 * Hover tooltip for icon-rail items. Attach `anchorProps` to the row's own
 * Pressable and render `tooltip` next to it; the bubble goes through the Bloom
 * portal so the drawer can't clip it. Hover-only, so touch never shows it.
 */
function useRailTooltip(label: string): RailTooltipHandle {
  const ref = React.useRef<View>(null);
  const [anchor, setAnchor] = React.useState<{ x: number; y: number } | null>(null);

  const onHoverIn = React.useCallback(() => {
    if (Platform.OS !== "web") return;
    ref.current?.measureInWindow((x, y, width, height) => {
      setAnchor({ x: x + width + 10, y: y + height / 2 });
    });
  }, []);
  const onHoverOut = React.useCallback(() => setAnchor(null), []);

  const tooltip = anchor ? (
    <Portal>
      <View
        pointerEvents="none"
        className="absolute rounded-lg bg-popover border border-border px-2 py-1 shadow-sm"
        style={{ left: anchor.x, top: anchor.y - 13 }}
      >
        <Text className="text-xs text-popover-foreground" numberOfLines={1}>
          {label}
        </Text>
      </View>
    </Portal>
  ) : null;

  return { anchorProps: { ref, onHoverIn, onHoverOut }, tooltip };
}

interface SidebarRowProps {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  accessibilityLabel?: string;
  /** Compact variant for nested rows (e.g. the expanded Agents children). */
  sub?: boolean;
  /** Icon-rail variant used when the sidebar is collapsed. */
  iconOnly?: boolean;
}

/** Ghost menu row shared by every sidebar navigation entry. */
function SidebarRow({ icon: Icon, label, onPress, accessibilityLabel, sub = false, iconOnly = false }: SidebarRowProps) {
  const { anchorProps, tooltip } = useRailTooltip(label);
  return (
    <>
      <Pressable
        {...(iconOnly ? anchorProps : null)}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label}
        onPress={onPress}
        className={cn(
          "flex-row items-center rounded-xl hover:bg-muted active:bg-muted",
          iconOnly ? "h-9 w-9 justify-center" : "gap-2 px-1.5 w-full",
          !iconOnly && (sub ? "h-8" : "h-9")
        )}
      >
        <Icon size={sub ? 16 : 18} className="text-foreground" />
        {!iconOnly && (
          <Text className={cn("text-foreground", sub ? "text-xs" : "text-sm")}>{label}</Text>
        )}
      </Pressable>
      {iconOnly && tooltip}
    </>
  );
}

interface SectionHeaderProps {
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  onAdd: () => void;
  addAccessibilityLabel: string;
}

/** Collapsible group header (label + chevron) with a trailing add action. */
function SectionHeader({ label, collapsed, onToggle, onAdd, addAccessibilityLabel }: SectionHeaderProps) {
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <View className="flex-row items-center justify-between pt-4 pb-1 px-2">
      <Pressable
        onPress={onToggle}
        className="flex-row items-center gap-1 flex-1 rounded-lg active:opacity-70"
      >
        <Text className="text-xs font-semibold text-foreground select-none">{label}</Text>
        <Chevron size={12} className="text-foreground" />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={addAccessibilityLabel}
        onPress={onAdd}
        className="h-6 w-6 items-center justify-center rounded-lg hover:bg-muted active:bg-muted"
      >
        <Plus size={14} className="text-muted-foreground" />
      </Pressable>
    </View>
  );
}

interface GhostIconButtonProps {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  badge?: boolean;
  /** Rail tooltip anchor from `useRailTooltip` (hover + measure target). */
  anchorProps?: RailTooltipHandle["anchorProps"];
}

/** Square ghost icon button (header collapse trigger, footer action bar). */
function GhostIconButton({ icon: Icon, label, onPress, badge = false, anchorProps }: GhostIconButtonProps) {
  return (
    <Pressable
      {...anchorProps}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      className="h-9 w-9 items-center justify-center rounded-xl hover:bg-muted active:bg-muted"
    >
      <Icon size={18} className="text-muted-foreground" />
      {badge && (
        <View className="absolute top-0.5 right-0.5 h-2.5 w-2.5 rounded-full bg-red-500 border border-background" />
      )}
    </Pressable>
  );
}

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
  const pathname = usePathname();
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

  const isLargeScreen = useIsLargeScreen();
  const drawerNavigation = useNavigation<DrawerNavigationProp<ReactNavigation.RootParamList>>();
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen);
  // Desktop icon rail: the drawer narrows and every row renders icon-only.
  const collapsed = isLargeScreen && !sidebarOpen;

  const handleCollapseSidebar = React.useCallback(() => {
    // Desktop: the permanent drawer collapses to an icon rail; mobile: the
    // front drawer simply closes.
    if (isLargeScreen) {
      setSidebarOpen(false);
    } else {
      drawerNavigation.closeDrawer();
    }
  }, [isLargeScreen, setSidebarOpen, drawerNavigation]);

  const handleExpandSidebar = React.useCallback(() => {
    setSidebarOpen(true);
  }, [setSidebarOpen]);

  // Playful rail detail: pressing the mark while already home replays a one-shot
  // CSS spin (NativeWind keyframes); the `key` remount restarts the animation.
  const [logoSpinCount, setLogoSpinCount] = React.useState(0);

  const handleLogoPress = React.useCallback(() => {
    if (collapsed && pathname === "/") {
      setLogoSpinCount((count) => count + 1);
      return;
    }
    // Use replace to reset to home
    router.replace("/(app)");
  }, [collapsed, pathname, router]);

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

  const handleAgentTeams = React.useCallback(() => {
    router.push("/(app)/agents/teams");
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

  // Header — logo chip on the left, collapse trigger on the right
  const header = (
    <View className={cn("flex-row items-center", collapsed && "justify-center")}>
      <Pressable
        accessibilityLabel="Home"
        accessibilityRole="button"
        onPress={handleLogoPress}
        className="p-1.5 mx-0.5 rounded-xl hover:bg-muted active:bg-muted"
      >
        {collapsed ? (
          <View key={logoSpinCount} className={cn(logoSpinCount > 0 && "animate-spin-once")}>
            <AliaMark size={24} className="text-foreground select-none" />
          </View>
        ) : (
          <AliaLogo height={36} />
        )}
      </Pressable>
      {!collapsed && (
        <View className="ml-auto">
          <GhostIconButton
            icon={ChevronsLeft}
            label={t('sidebar.collapse')}
            onPress={handleCollapseSidebar}
          />
        </View>
      )}
    </View>
  );

  // Top section with New Chat as a highlighted menu row (icon-only in the rail)
  const newChatTooltip = useRailTooltip(t('sidebar.newChat'));
  const expandTooltip = useRailTooltip(t('sidebar.expand'));
  const newChatRow = (
      <Pressable
        {...(collapsed ? newChatTooltip.anchorProps : null)}
        accessibilityLabel={t('sidebar.newChat')}
        accessibilityRole="button"
        onPress={handleNewChat}
        className={cn(
          "h-9 rounded-xl flex-row items-center bg-muted hover:bg-muted/80 active:bg-muted/70",
          collapsed ? "w-9 justify-center" : "px-1.5 w-full gap-2"
        )}
      >
        <Plus size={18} className="text-foreground" />
        {!collapsed && (
          <Text className="text-sm font-semibold text-foreground">
            {t('sidebar.newChat')}
          </Text>
        )}
      </Pressable>
  );

  const topSection = (
    <View className="gap-px">
      {newChatRow}
      {collapsed && newChatTooltip.tooltip}
    </View>
  );

  // Navigation links — SidebarRow everywhere; the Agents entry expands a
  // nested submenu when the sidebar is open and expands the rail otherwise.
  const navigation = (
    <>
      <SidebarRow icon={BrainCircuit} label={t('sidebar.roles')} onPress={handleRoles} iconOnly={collapsed} />
      {collapsed ? (
        <SidebarRow icon={Users} label={t('sidebar.agents')} onPress={handleExpandSidebar} iconOnly />
      ) : (
        <View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('sidebar.agents')}
            onPress={handleToggleAgents}
            className="h-9 flex-row items-center justify-between rounded-xl px-1.5 w-full hover:bg-muted active:bg-muted"
          >
            <View className="flex-row items-center gap-2">
              <Users size={18} className="text-foreground" />
              <Text className="text-sm text-foreground">{t('sidebar.agents')}</Text>
            </View>
            {agentsExpanded ? (
              <ChevronDown size={12} className="text-muted-foreground" />
            ) : (
              <ChevronRight size={12} className="text-muted-foreground" />
            )}
          </Pressable>
          {agentsExpanded && (
            <View className="ml-7 gap-px">
              <SidebarRow icon={Users} label={t('agents.allAgents')} onPress={handleAgents} sub />
              <SidebarRow icon={UsersRound} label={t('agents.teams')} onPress={handleAgentTeams} sub />
            </View>
          )}
        </View>
      )}
      <SidebarRow icon={StarIcon} label="Favorites" onPress={handleFavorites} iconOnly={collapsed} />
      <SidebarRow icon={Library} label={t('sidebar.library')} onPress={handleLibrary} iconOnly={collapsed} />
      <SidebarRow icon={ListTodo} label="Tasks" onPress={handleTasks} iconOnly={collapsed} />
      <SidebarRow icon={CloudCog} label={t('sidebar.automations')} onPress={handleAutomations} iconOnly={collapsed} />
      <SidebarRow icon={BookOpen} label={t('sidebar.skills')} onPress={handleSkills} iconOnly={collapsed} />
      <SidebarRow icon={Mic} label="Shows" onPress={handleShows} iconOnly={collapsed} />
    </>
  );

  // Scrollable content - Projects and History (rail: icons that expand)
  const scrollableContent = collapsed ? (
    <View className="gap-px pt-2">
      <SidebarRow icon={FolderOpen} label={t('sidebar.projects')} onPress={handleExpandSidebar} iconOnly />
      <SidebarRow icon={HistoryIcon} label="History" onPress={handleExpandSidebar} iconOnly />
    </View>
  ) : (
    <View className="gap-2">
        <View className="gap-2">
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
                    <ChevronRight size={12} className="text-foreground" />
                  ) : (
                    <ChevronDown size={12} className="text-foreground" />
                  )}
                </Pressable>
                <Pressable
                  onPress={handleNewProject}
                  className="h-6 w-6 items-center justify-center rounded-lg hover:bg-muted active:bg-muted"
                >
                  <Plus size={14} className="text-muted-foreground" />
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
                            <ChevronDown size={14} className="text-muted-foreground" />
                          ) : (
                            <ChevronRight size={14} className="text-muted-foreground" />
                          )}
                        </Pressable>
                        <DropdownMenu.Root>
                          <DropdownMenu.Trigger>
                            <Pressable className="h-6 w-6 items-center justify-center rounded-lg mr-1 web:opacity-0 web:group-hover:opacity-100 active:bg-muted/70">
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
              <View className="flex-row items-center justify-between pt-4 pb-1 px-2">
                <Pressable
                  onPress={handleToggleHistory}
                  className="flex-row items-center gap-1 flex-1 rounded-lg active:opacity-70"
                >
                  <Text className="text-xs font-semibold text-foreground select-none">
                    History
                  </Text>
                  {historyCollapsed ? (
                    <ChevronRight size={12} className="text-foreground" />
                  ) : (
                    <ChevronDown size={12} className="text-foreground" />
                  )}
                </Pressable>
                <Pressable
                  accessibilityLabel="New folder"
                  accessibilityRole="button"
                  onPress={handleNewFolder}
                  className="h-6 w-6 items-center justify-center rounded-lg hover:bg-muted active:bg-muted"
                >
                  <Plus size={14} className="text-muted-foreground" />
                </Pressable>
              </View>
              {!historyCollapsed && (
                <View className="gap-1">
{conversationsNotInProjects.length === 0 ? (
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

  // Footer: ProfileButton owns all three auth states (undetermined skeleton,
  // signed-in row + account switcher, signed-out "Sign in" → SDK dialog), so it
  // renders unconditionally — same pattern as Mention's sidebar. Only the
  // account-scoped icon bar is gated on auth.
  const footer = collapsed ? (
    <View className="gap-2 items-center">
      <GhostIconButton
        icon={ChevronsRight}
        label={t('sidebar.expand')}
        onPress={handleExpandSidebar}
        anchorProps={expandTooltip.anchorProps}
      />
      {expandTooltip.tooltip}
      <ProfileButton
        expanded={false}
        onNavigateManage={handleManageAccount}
        onAddAccount={handleAddAccount}
      />
    </View>
  ) : (
    <View className="gap-2">
            <ProfileButton
              expanded
              onNavigateManage={handleManageAccount}
              onAddAccount={handleAddAccount}
            />

            {/* Icon Button Bar */}
            {isAuthenticated && (
            <View className="flex-row items-center">
              <GhostIconButton icon={Sparkles} label={t('sidebar.upgradeToPro')} onPress={handleUpgrade} />
              <GhostIconButton
                icon={Bell}
                label={t('sidebar.notifications')}
                onPress={handleNotifications}
                badge={(unreadData?.count ?? 0) > 0}
              />
              <GhostIconButton icon={CreditCard} label={t('sidebar.billing')} onPress={handleBilling} />
              <GhostIconButton icon={Settings2} label="Settings" onPress={handleSettings} />
              {Platform.OS === "web" && (
                <>
                  <GhostIconButton icon={Smartphone} label="App download" onPress={handleAppDownload} />
                  <GhostIconButton icon={Code} label="Console" onPress={handleConsole} />
                  <GhostIconButton
                    icon={Keyboard}
                    label="Keyboard shortcuts"
                    onPress={() => setShortcutsDialogOpen(true)}
                  />
                </>
              )}
              <View className="flex-1" />
              <GhostIconButton icon={BookOpen} label="Docs" onPress={handleDocs} />
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
