import { InviteDialog } from "@/components/invite-dialog";
import { ProjectEditDialog, type ProjectEditValues } from "@/components/project-edit-dialog";
import { useAliaSettings } from "@/components/settings/settings-context";
import {
  ConversationActions,
  NewProjectAction,
  ProjectActions,
  RenameConversationDialog,
} from "@/components/sidebar-menus";
import { formatRelativeTime } from "@/lib/utils/relative-time";
import { queryKeys } from "@/lib/hooks/query-keys";
import {
  prefetchConversation,
  useConversations,
  useDeleteConversation,
  useRenameConversation,
  type Conversation,
} from "@/lib/hooks/use-conversations";
import { useUnreadCount } from "@/lib/hooks/use-notifications";
import { useTranslation } from "@/lib/hooks/use-translation";
import { conversationsForHistory, selectedItemForPath } from "@/lib/sidebar-history";
import { useStore } from "@/lib/stores/global-store";
import { useProjectsStore, type Project } from "@/lib/stores/projects-store";
import { IdentityMark } from "@alia.onl/sdk";
import { useAiChatShell } from "@oxy.so/bloom/ai-chat";
import { RiAddFill } from "@oxy.so/bloom/icons/RiAddFill";
import { RiBookOpenLine } from "@oxy.so/bloom/icons/RiBookOpenLine";
import { RiCustomerServiceLine } from "@oxy.so/bloom/icons/RiCustomerServiceLine";
import { RiGiftLine } from "@oxy.so/bloom/icons/RiGiftLine";
import { RiListCheck3 } from "@oxy.so/bloom/icons/RiListCheck3";
import { RiMicLine } from "@oxy.so/bloom/icons/RiMicLine";
import { RiNotification3Line } from "@oxy.so/bloom/icons/RiNotification3Line";
import { RiRobot2Line } from "@oxy.so/bloom/icons/RiRobot2Line";
import { RiSettings4Line } from "@oxy.so/bloom/icons/RiSettings4Line";
import { RiSparklingLine } from "@oxy.so/bloom/icons/RiSparklingLine";
import { RiTimeLine } from "@oxy.so/bloom/icons/RiTimeLine";
import {
  Sidebar as BloomSidebar,
  type SidebarNavItem,
  type SidebarTree,
  type SidebarTreeFolder,
} from "@oxy.so/bloom/sidebar";
import { confirm } from "@oxy.so/bloom/surfaces";
import { ProfileButton, useAuth, useOxy } from "@oxy.so/services";
import { useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter } from "expo-router";
import React from "react";
import { Linking, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";

const SUPPORT_URL = "https://oxy.so/support";

/**
 * Alia's sidebar is Bloom's AI Chat template sidebar, prop for prop: account,
 * quick search, primary rows, a tree of chats, theme toggle, secondary rows and
 * the plan card. Only the data is Alia's. Each chat and each project carries a
 * menu in the tree's `actions` slot; the dialogs those menus open sit beside
 * the sidebar.
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
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = useConversations();
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
  const { data: unread } = useUnreadCount();
  // `mutateAsync` is stable across renders; the mutation object is not, and the
  // tree's rows (and their memoised menus) depend on this.
  const { mutateAsync: deleteConversation } = useDeleteConversation();
  const renameConversation = useRenameConversation();
  const [renaming, setRenaming] = React.useState<Conversation | null>(null);
  const [projectDialogOpen, setProjectDialogOpen] = React.useState(false);
  const [editingProject, setEditingProject] = React.useState<Project | null>(null);
  const [inviteOpen, setInviteOpen] = React.useState(false);

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

  const moveConversation = React.useCallback(
    async (conversationId: string, projectId: string | null) => {
      // A chat is in one project at most: out of every other, then into this one.
      for (const project of projects) {
        if (project.id !== projectId && project.conversationIds.includes(conversationId)) {
          await removeConversationFromProject(project.id, conversationId);
        }
      }
      if (projectId) await addConversationToProject(projectId, conversationId);
    },
    [projects, addConversationToProject, removeConversationFromProject],
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
      for (const project of projects) {
        if (project.conversationIds.includes(conv.id)) {
          await removeConversationFromProject(project.id, conv.id);
        }
      }
      // Deleting the open chat leaves nothing to show; start a new one.
      if (chatId?.id === conv.id) router.replace("/(app)");
    },
    [t, deleteConversation, projects, removeConversationFromProject, chatId, router],
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
    (conv: Conversation, projectId?: string) => ({
      key: conv.id,
      label: conv.title || t("sidebar.newConversation"),
      meta: shortTime(conv.updatedAt),
      onPrefetch: () => prefetchConversation(queryClient, conv.id),
      actions: isAuthenticated ? (
        <ConversationActions
          conversation={conv}
          projects={projects}
          projectId={projectId}
          onRename={setRenaming}
          onMove={moveConversation}
          onDelete={askDeleteConversation}
        />
      ) : undefined,
    }),
    [queryClient, t, isAuthenticated, projects, moveConversation, askDeleteConversation],
  );

  const tree = React.useMemo<SidebarTree | undefined>(() => {
    const recent = conversationsForHistory(conversations, projects);
    const folders: SidebarTreeFolder[] = [
      ...projects.map((project) => ({
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
        items: conversations
          .filter((conv) => project.conversationIds.includes(conv.id))
          .map((conv) => row(conv, project.id)),
      })),
      ...(recent.length
        ? [
            {
              key: "recent",
              label: t("sidebar.recent"),
              defaultOpen: true,
              items: recent.map((conv) => row(conv)),
            },
          ]
        : []),
    ];
    // Signed in, the tree stands even while empty: it holds "new project".
    if (!folders.length && !isAuthenticated) return undefined;
    return {
      label: t("sidebar.chats"),
      folders,
      actions: isAuthenticated ? (
        <NewProjectAction onPress={() => openProjectDialog(null)} />
      ) : undefined,
    };
  }, [
    conversations,
    projects,
    toggleProject,
    row,
    t,
    isAuthenticated,
    openProjectDialog,
    askDeleteProject,
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
    {
      key: "support",
      label: t("sidebar.support"),
      icon: RiCustomerServiceLine,
      onPress: () => {
        void Linking.openURL(SUPPORT_URL);
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
