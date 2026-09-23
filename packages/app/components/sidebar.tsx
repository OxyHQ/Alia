import { useAliaSettings } from "@/components/settings/settings-context";
import { formatRelativeTime } from "@/lib/utils/relative-time";
import { queryKeys } from "@/lib/hooks/query-keys";
import { useSubscription } from "@/lib/hooks/use-billing";
import {
  prefetchConversation,
  useConversations,
} from "@/lib/hooks/use-conversations";
import { useTranslation } from "@/lib/hooks/use-translation";
import { conversationsForHistory } from "@/lib/sidebar-history";
import { useStore } from "@/lib/stores/global-store";
import { useProjectsStore } from "@/lib/stores/projects-store";
import { IdentityMark } from "@alia.onl/sdk";
import { useAiChatShell } from "@oxy.so/bloom/ai-chat";
import { RiAddFill } from "@oxy.so/bloom/icons/RiAddFill";
import { RiBookOpenLine } from "@oxy.so/bloom/icons/RiBookOpenLine";
import { RiCustomerServiceLine } from "@oxy.so/bloom/icons/RiCustomerServiceLine";
import { RiListCheck3 } from "@oxy.so/bloom/icons/RiListCheck3";
import { RiLoginBoxLine } from "@oxy.so/bloom/icons/RiLoginBoxLine";
import { RiMicLine } from "@oxy.so/bloom/icons/RiMicLine";
import { RiRobot2Line } from "@oxy.so/bloom/icons/RiRobot2Line";
import { RiSettings4Line } from "@oxy.so/bloom/icons/RiSettings4Line";
import { RiSparklingLine } from "@oxy.so/bloom/icons/RiSparklingLine";
import { RiTimeLine } from "@oxy.so/bloom/icons/RiTimeLine";
import {
  Sidebar as BloomSidebar,
  type SidebarAccount,
  type SidebarNavItem,
  type SidebarPlan,
  type SidebarTree,
  type SidebarTreeFolder,
} from "@oxy.so/bloom/sidebar";
import { useAuth, useOxy } from "@oxy.so/services";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import React from "react";
import { Linking, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";

const SUPPORT_URL = "https://oxy.so/support";

/**
 * Alia's sidebar is Bloom's AI Chat template sidebar, prop for prop: account,
 * quick search, primary rows, a tree of chats, theme toggle, secondary rows and
 * the plan card. Only the data is Alia's.
 */
export interface AliaSidebarProps {
  /** The drawer copy the shell shows below `lg` (the template's `mobile surface="plain"`). */
  mobile?: boolean;
}

export const Sidebar = React.memo(function Sidebar({ mobile }: AliaSidebarProps) {
  const props = useSidebarProps();
  return mobile ? (
    <BloomSidebar {...props} mobile surface="plain" />
  ) : (
    <BloomSidebar {...props} />
  );
});

function useSidebarProps() {
  const router = useRouter();
  const shell = useAiChatShell();
  const settings = useAliaSettings();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const chatId = useStore((state) => state.chatId);
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = useConversations();
  const { isAuthenticated, showBottomSheet, openAccountDialog, oxyServices } = useOxy();
  const { signIn, user, isAuthResolved, isPrivateApiPending } = useAuth();
  const { data: subscription } = useSubscription();
  const projects = useProjectsStore((state) => state.projects);
  const toggleProject = useProjectsStore((state) => state.toggleProject);

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

  const row = React.useCallback(
    (conv: (typeof conversations)[number]) => ({
      key: conv.id,
      label: conv.title || t("sidebar.newConversation"),
      meta: shortTime(conv.updatedAt),
      onPrefetch: () => prefetchConversation(queryClient, conv.id),
    }),
    [queryClient, t],
  );

  const tree = React.useMemo<SidebarTree | undefined>(() => {
    const recent = conversationsForHistory(conversations, projects);
    const folders: SidebarTreeFolder[] = [
      ...projects.map((project) => ({
        key: `project:${project.id}`,
        label: project.name,
        open: project.isExpanded,
        onOpenChange: () => toggleProject(project.id),
        items: conversations
          .filter((conv) => project.conversationIds.includes(conv.id))
          .map(row),
      })),
      ...(recent.length
        ? [
            {
              key: "recent",
              label: t("sidebar.recent"),
              defaultOpen: true,
              items: recent.map(row),
            },
          ]
        : []),
    ];
    return folders.length
      ? { label: t("sidebar.chats"), folders }
      : undefined;
  }, [conversations, projects, toggleProject, row, t]);

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
  ];

  const authReady = isAuthResolved && !isPrivateApiPending;
  const signedIn = authReady && isAuthenticated;

  const secondaryItems: SidebarNavItem[] = [
    ...(authReady && !isAuthenticated
      ? [
          {
            key: "sign-in",
            label: t("sidebar.signIn"),
            icon: RiLoginBoxLine,
            onPress: () => {
              signIn().catch(() => {});
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

  const name = user?.name?.displayName?.trim() || user?.username || "";
  const avatar = user?.avatar
    ? { source: oxyServices.getFileDownloadUrl(user.avatar, "thumb") }
    : { initials: name.slice(0, 1).toUpperCase(), color: "neutral" as const };

  const account: SidebarAccount | undefined = signedIn
    ? {
        name,
        avatar,
        users: [
          {
            id: user?.id ?? "me",
            name,
            avatar,
            selected: true,
            onPress: () => openAccountDialog("accounts"),
          },
        ],
        onAddUser: () => {
          signIn().catch(() => {});
        },
        onManage: () => showBottomSheet?.("ManageAccount"),
      }
    : undefined;

  const plan: SidebarPlan | undefined = signedIn
    ? {
        name,
        plan: subscription?.plan.name ?? t("sidebar.freePlan"),
        avatar,
        onAction: () => go("/(biglayout)/subscribe"),
      }
    : undefined;

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

  return {
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
    account,
    tree,
    selectedTreeItem: chatId?.id,
    onTreeItemPress: (item: { key: string }) => openConversation(item.key),
    plan,
    onScroll,
    onClose: closeNav,
  };
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
