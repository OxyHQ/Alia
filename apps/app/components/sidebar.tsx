import React from "react";
import { View, Pressable, Platform, NativeSyntheticEvent, NativeScrollEvent, Linking } from "react-native";
import { Text } from "@/components/ui/text";
import { BaseSidebar } from "@/components/base-sidebar";
import { Plus, Clock, Settings2, ChevronRight, MoreHorizontal, Bell } from "lucide-react-native";
import { useTranslation } from "@/hooks/useTranslation";
import { useStore } from "@/lib/globalStore";
import { useRouter, usePathname } from "expo-router";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";
import { UserAvatar } from "@/components/user-avatar";
import { useOxy } from "@oxyhq/services";
import { SidebarSkeleton } from "@/components/sidebar-skeleton";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/hooks/query-keys";
import { useConversations, useDeleteConversation, prefetchConversation } from "@/lib/hooks/use-conversations";
import * as DropdownMenu from "@/components/ui/dropdown-menu";

import Logo from "@/assets/clarity-logo.svg";
import { useColorScheme } from "@/lib/useColorScheme";

export function Sidebar() {
  const pathname = usePathname();
  const isSettingsRoute = pathname.startsWith("/settings");
  if (isSettingsRoute) return <SettingsSidebar />;
  return <SearchSidebar />;
}

/* ── Sidebar nav item ── */

function SidebarNavItem({
  icon,
  label,
  onPress,
  shortcut,
}: {
  icon: React.ReactNode;
  label: string;
  onPress: () => void;
  shortcut?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      className="py-1 group flex-row w-full justify-start items-center cursor-pointer relative"
    >
      <View className="absolute left-0 right-0 top-px bottom-px rounded-xl bg-muted/50 opacity-0 group-hover:opacity-100 pointer-events-none" />
      <View className="flex-row items-center w-full justify-start relative">
        <View className="items-center shrink-0 justify-center" style={{ width: 40 }}>
          {icon}
        </View>
        <Text className="flex-1 font-sans text-sm font-medium text-foreground" numberOfLines={1}>
          {label}
        </Text>
        {shortcut && Platform.OS === "web" && (
          <View className="opacity-0 group-hover:opacity-100">
            <Text className="mr-3 shrink-0 font-sans text-[10px] font-normal text-muted-foreground/60 select-none">
              {shortcut}
            </Text>
          </View>
        )}
      </View>
    </Pressable>
  );
}

/* ── History item ──────────────────────────────────────────── */

const SearchHistoryItem = React.memo(function SearchHistoryItem({
  id, title, isActive, onSelect, onPrefetch, onDelete,
}: {
  id: string; title: string; isActive: boolean;
  onSelect: (id: string) => void; onPrefetch: (id: string) => void; onDelete: (id: string) => void;
}) {
  const { t } = useTranslation();
  const prefetch = React.useCallback(() => onPrefetch(id), [onPrefetch, id]);
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Pressable
          onPress={() => onSelect(id)}
          onPressIn={prefetch}
          onHoverIn={prefetch}
          className={`group relative rounded-md select-none ${isActive ? "bg-muted" : ""}`}
        >
          {/* Hover overlay */}
          <View className="absolute inset-x-0 inset-y-0 rounded-md opacity-0 group-hover:opacity-100 duration-150 bg-muted/50" />
          {/* Text content */}
          <View className="relative flex-row items-center gap-2 pl-1 font-sans text-sm text-foreground py-1.5 px-2 w-full overflow-hidden whitespace-nowrap">
            <Text className="font-sans text-sm text-foreground" numberOfLines={1}>
              {title || t("sidebar.newSearch")}
            </Text>
          </View>
        </Pressable>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content>
        <DropdownMenu.Item key="delete" destructive onSelect={() => onDelete(id)}>
          <DropdownMenu.ItemIcon ios={{ name: "trash" }} />
          <DropdownMenu.ItemTitle>{t("sidebar.delete")}</DropdownMenu.ItemTitle>
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
});

/* ── Main sidebar ─────────────────────────────────────────── */

const SearchSidebar = React.memo(function SearchSidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const qc = useQueryClient();
  const { t } = useTranslation();
  const { colors } = useColorScheme();
  const chatId = useStore((s) => s.chatId);
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } = useConversations();
  const deleteMut = useDeleteConversation();
  const { user, isAuthenticated, logout, showBottomSheet } = useOxy();

  const allConvs = React.useMemo(() => {
    const all = data?.pages.flatMap((p) => p.conversations) || [];
    return all.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }, [data]);

  const isHome = pathname === "/" || pathname === "/(app)";

  const handleNewSearch = React.useCallback(() => router.replace("/(app)"), [router]);
  const handlePrefetch = React.useCallback((id: string) => prefetchConversation(qc, id), [qc]);

  const handleSelect = React.useCallback((id: string) => {
    if (!qc.getQueryData(queryKeys.conversations.detail(id))) {
      const c = allConvs.find((x) => x.id === id);
      if (c) qc.setQueryData(queryKeys.conversations.detail(id), { ...c, messages: [] }, { updatedAt: 0 });
    }
    prefetchConversation(qc, id);
    router.replace(`/(app)/c/${id}`);
  }, [router, qc, allConvs]);

  const handleDelete = React.useCallback((id: string) => deleteMut.mutate(id), [deleteMut]);
  const handleSettings = React.useCallback(() => router.push("/(app)/settings"), [router]);
  const handleAccount = React.useCallback(() => showBottomSheet("AccountSettings"), [showBottomSheet]);
  const handleLogout = React.useCallback(() => { logout(); router.replace("/login"); }, [router, logout]);
  const handleLogin = React.useCallback(() => router.push("/login"), [router]);
  const handleUpgrade = React.useCallback(() => router.push("/(biglayout)/subscribe"), [router]);

  const displayName = React.useCallback(() => {
    if (!user) return t("common.user");
    if (user.name?.first) return user.name.last ? `${user.name.first} ${user.name.last}` : user.name.first;
    return user.username || t("common.user");
  }, [user, t]);

  const handleScroll = React.useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent;
    if (layoutMeasurement.height + contentOffset.y >= contentSize.height - 100 && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  /* ── Header: Search mode toggle ── */
  const header = (
    <View style={{ height: 90 }} className="flex-col justify-center">
      <View className="mx-2 p-1 relative">
        {/* Background track */}
        <View className="absolute inset-0 bg-accent/50 rounded-xl" />
        {/* Active indicator */}
        <View
          className="absolute bg-background rounded-lg"
          style={{ top: 4, left: 4, right: 4, height: 32 }}
        />
        {/* Search item */}
        <Pressable
          onPress={handleNewSearch}
          className="group/toggle flex-row items-center justify-start w-full h-8 shrink-0 relative cursor-pointer gap-1"
        >
          <View className="items-center justify-center shrink-0" style={{ width: 32 }}>
            <Logo width={20} height={20} fill={colors.foreground} />
          </View>
          <Text className="font-sans text-sm text-foreground flex-1">
            {t("sidebar.newSearch")}
          </Text>
          {Platform.OS === "web" && (
            <View className="opacity-0 group-hover/toggle:opacity-100">
              <Text className="mr-3 shrink-0 font-sans text-[10px] font-normal text-muted-foreground/60 select-none">
                {"\u2318"}1
              </Text>
            </View>
          )}
        </Pressable>
      </View>
    </View>
  );

  /* ── Footer: user section ── */
  const footer = isAuthenticated ? (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        <Pressable
          accessibilityLabel="Account menu"
          accessibilityRole="button"
          className="flex-row cursor-pointer items-center relative group shrink-0 w-full py-2 px-2"
        >
          {/* Hover bg */}
          <View className="pointer-events-none absolute inset-1 bg-muted/50 rounded-md opacity-0 group-hover:opacity-100 transition-opacity duration-150" />
          {/* Avatar */}
          <View className="relative flex aspect-square shrink-0 items-center justify-center bg-muted rounded-full w-8 h-8">
            <UserAvatar size={32} />
          </View>
          {/* Name */}
          <Text className="font-sans text-sm text-foreground leading-tight truncate ml-2 flex-1">
            {displayName()}
          </Text>
          <Bell size={16} className="text-muted-foreground ml-2" />
        </Pressable>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content>
        {Platform.OS === "web" ? (
          <View className="flex-row items-center gap-2.5 px-2 py-2">
            <UserAvatar size={36} />
            <View>
              <Text className="text-sm font-semibold text-foreground">{displayName()}</Text>
              {user?.username && <Text className="text-xs text-muted-foreground">{user.username}@oxy.so</Text>}
            </View>
          </View>
        ) : (
          <DropdownMenu.Label>{displayName()}</DropdownMenu.Label>
        )}
        <DropdownMenu.Separator />
        <DropdownMenu.Item key="upgrade" onSelect={handleUpgrade}>
          <DropdownMenu.ItemIcon ios={{ name: "sparkle" }} />
          <DropdownMenu.ItemTitle>{t("sidebar.upgradeToPro")}</DropdownMenu.ItemTitle>
        </DropdownMenu.Item>
        <DropdownMenu.Item key="account" onSelect={handleAccount}>
          <DropdownMenu.ItemIcon ios={{ name: "person.circle" }} />
          <DropdownMenu.ItemTitle>{t("sidebar.account")}</DropdownMenu.ItemTitle>
        </DropdownMenu.Item>
        <DropdownMenu.Item key="settings" onSelect={handleSettings}>
          <DropdownMenu.ItemIcon ios={{ name: "gearshape" }} />
          <DropdownMenu.ItemTitle>{t("sidebar.settings")}</DropdownMenu.ItemTitle>
        </DropdownMenu.Item>
        <DropdownMenu.Separator />
        <DropdownMenu.Item key="terms" onSelect={() => Linking.openURL("https://oxy.so/company/transparency/policies/terms-of-service")}>
          <DropdownMenu.ItemIcon ios={{ name: "doc.text" }} />
          <DropdownMenu.ItemTitle>{t("sidebar.termsOfService")}</DropdownMenu.ItemTitle>
        </DropdownMenu.Item>
        <DropdownMenu.Item key="privacy" onSelect={() => Linking.openURL("https://oxy.so/company/transparency/policies/privacy")}>
          <DropdownMenu.ItemIcon ios={{ name: "hand.raised" }} />
          <DropdownMenu.ItemTitle>{t("sidebar.privacyPolicy")}</DropdownMenu.ItemTitle>
        </DropdownMenu.Item>
        <DropdownMenu.Separator />
        <DropdownMenu.Item key="logout" destructive onSelect={handleLogout}>
          <DropdownMenu.ItemIcon ios={{ name: "rectangle.portrait.and.arrow.right" }} />
          <DropdownMenu.ItemTitle>{t("sidebar.logOut")}</DropdownMenu.ItemTitle>
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  ) : (
    <Pressable
      onPress={handleLogin}
      className="flex-row cursor-pointer items-center relative group shrink-0 w-full py-2 px-2"
    >
      <View className="pointer-events-none absolute inset-1 bg-muted/50 rounded-md opacity-0 group-hover:opacity-100 transition-opacity duration-150" />
      <View className="relative flex aspect-square shrink-0 items-center justify-center bg-primary/10 rounded-full w-8 h-8">
        <Text className="text-sm font-bold text-primary">
          {(t("login.signInButton")[0] || "S").toUpperCase()}
        </Text>
      </View>
      <Text className="font-sans text-sm font-medium text-primary leading-tight truncate ml-2 flex-1">
        {t("login.signInButton")}
      </Text>
      <ChevronRight size={14} className="text-primary ml-2" />
    </Pressable>
  );

  return (
    <BaseSidebar
      header={header}
      footer={footer}
      onScroll={handleScroll}
    >
      {/* Navigation items */}
      <View className="flex-col gap-0.5 px-2">
        {/* New thread */}
        <Pressable
          onPress={handleNewSearch}
          className="py-1 group flex-row w-full justify-start items-center cursor-pointer relative"
        >
          <View className="absolute left-0 right-0 top-px bottom-px rounded-xl bg-muted/50 opacity-0 group-hover:opacity-100 pointer-events-none" />
          <View className="flex-row items-center w-full justify-start relative">
            <View className="items-center shrink-0 justify-center" style={{ width: 40 }}>
              <View className="rounded-full items-center justify-center w-6 h-6 bg-accent">
                <Plus size={14} className="text-foreground" />
              </View>
            </View>
            <Text className="flex-1 font-sans text-sm font-medium text-foreground" numberOfLines={1}>
              {t("sidebar.newChat")}
            </Text>
            {Platform.OS === "web" && (
              <View className="opacity-0 group-hover:opacity-100">
                <Text className="mr-3 shrink-0 font-sans text-[10px] font-normal text-muted-foreground/60 select-none">
                  Ctrl I
                </Text>
              </View>
            )}
          </View>
        </Pressable>

        {/* History */}
        <SidebarNavItem
          icon={<Clock size={20} className="text-muted-foreground" />}
          label={t("sidebar.history")}
          onPress={() => {}}
        />

        {/* Settings */}
        <SidebarNavItem
          icon={<Settings2 size={20} className="text-muted-foreground" />}
          label={t("sidebar.settings")}
          onPress={handleSettings}
        />

        {/* More */}
        <SidebarNavItem
          icon={<MoreHorizontal size={20} className="text-muted-foreground" />}
          label={t("common.more")}
          onPress={() => {}}
        />
      </View>

      {/* Divider */}
      <View className="border-t border-border/50 mx-3 my-1" />

      {/* History section */}
      <View className="flex min-h-0 w-full flex-1 flex-col overflow-x-hidden overflow-y-auto px-2">
        {/* Section header */}
        <View className="gap-1 flex-row items-center justify-between select-none py-1 pl-1 pb-2">
          <View className="min-w-0 flex-row items-center gap-1">
            <Text className="text-muted-foreground font-medium text-xs hover:text-foreground">
              {t("sidebar.history")}
            </Text>
          </View>
        </View>

        {/* Conversation list */}
        {isLoading ? <SidebarSkeleton /> : allConvs.length === 0 ? (
          <View className="items-center justify-center py-8">
            <Text className="text-xs text-muted-foreground">
              {t("sidebar.noSearches")}
            </Text>
          </View>
        ) : (
          <View className="flex-col gap-0.5">
            {allConvs.map((c) => (
              <SearchHistoryItem
                key={c.id}
                id={c.id}
                title={c.title}
                isActive={chatId?.id === c.id}
                onSelect={handleSelect}
                onPrefetch={handlePrefetch}
                onDelete={handleDelete}
              />
            ))}
          </View>
        )}
      </View>
    </BaseSidebar>
  );
});
