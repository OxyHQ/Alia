import React from "react";
import { View, Pressable, Platform, NativeSyntheticEvent, NativeScrollEvent, Linking } from "react-native";
import { ClarityWordmark } from "@/components/ui/clarity-wordmark";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { BaseSidebar } from "@/components/base-sidebar";
import { Settings2, LogIn, UserPlus, Plus } from "lucide-react-native";
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
import { cn } from "@/lib/utils";

export function Sidebar() {
  const pathname = usePathname();
  const isSettingsRoute = pathname.startsWith("/settings");
  if (isSettingsRoute) return <SettingsSidebar />;
  return <SearchSidebar />;
}

/* Date grouping helpers */

function isToday(d: Date): boolean {
  return d.toDateString() === new Date().toDateString();
}

function isYesterday(d: Date): boolean {
  const y = new Date();
  y.setDate(y.getDate() - 1);
  return d.toDateString() === y.toDateString();
}

function isThisWeek(d: Date): boolean {
  const now = new Date();
  const sow = new Date(now);
  sow.setDate(now.getDate() - now.getDay());
  sow.setHours(0, 0, 0, 0);
  return d >= sow && !isToday(d) && !isYesterday(d);
}

type ConvLike = { id: string; title: string; updatedAt: Date };

function groupConversations<T extends ConvLike>(convs: T[]) {
  const g = { today: [] as T[], yesterday: [] as T[], thisWeek: [] as T[], older: [] as T[] };
  for (const c of convs) {
    if (isToday(c.updatedAt)) g.today.push(c);
    else if (isYesterday(c.updatedAt)) g.yesterday.push(c);
    else if (isThisWeek(c.updatedAt)) g.thisWeek.push(c);
    else g.older.push(c);
  }
  return g;
}

/* History item */

const SearchHistoryItem = React.memo(function SearchHistoryItem({
  id, title, isActive, onSelect, onPrefetch, onDelete,
}: {
  id: string; title: string; isActive: boolean;
  onSelect: (id: string) => void; onPrefetch: (id: string) => void; onDelete: (id: string) => void;
}) {
  const prefetch = React.useCallback(() => onPrefetch(id), [onPrefetch, id]);
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Pressable
          onPress={() => onSelect(id)}
          onPressIn={prefetch}
          // @ts-ignore web-only
          onHoverIn={prefetch}
          className={cn("py-1.5 px-2.5 rounded-lg active:bg-muted/50", isActive && "bg-muted")}
        >
          <Text className="text-sm text-foreground" numberOfLines={1}>{title || "New search"}</Text>
        </Pressable>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content>
        <DropdownMenu.Item key="delete" destructive onSelect={() => onDelete(id)}>
          <DropdownMenu.ItemIcon ios={{ name: "trash" }} />
          <DropdownMenu.ItemTitle>Delete</DropdownMenu.ItemTitle>
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
});

/* Grouped section */

function ConversationGroup({ label, items, currentChatId, onSelect, onPrefetch, onDelete }: {
  label: string; items: ConvLike[]; currentChatId: string | undefined;
  onSelect: (id: string) => void; onPrefetch: (id: string) => void; onDelete: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <View className="gap-0.5">
      <Text className="text-xs font-medium text-muted-foreground px-2.5 pt-3 pb-1">{label}</Text>
      {items.map((c) => (
        <SearchHistoryItem key={c.id} id={c.id} title={c.title} isActive={currentChatId === c.id}
          onSelect={onSelect} onPrefetch={onPrefetch} onDelete={onDelete} />
      ))}
    </View>
  );
}

/* Main sidebar */

const SearchSidebar = React.memo(function SearchSidebar() {
  const router = useRouter();
  const qc = useQueryClient();
  const { t } = useTranslation();
  const chatId = useStore((s) => s.chatId);
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } = useConversations();
  const deleteMut = useDeleteConversation();
  const { user, isAuthenticated, logout, showBottomSheet } = useOxy();

  const allConvs = React.useMemo(() => {
    const all = data?.pages.flatMap((p) => p.conversations) || [];
    return all.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }, [data]);

  const grouped = React.useMemo(() => groupConversations(allConvs), [allConvs]);

  const handleNewSearch = React.useCallback(() => router.replace("/(app)"), [router]);
  const handleLogoPress = React.useCallback(() => router.replace("/(app)"), [router]);
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
  const handleRegister = React.useCallback(() => router.push("/register"), [router]);
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

  const header = (
    <Pressable accessibilityLabel="Home" accessibilityRole="button" onPress={handleLogoPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
      <ClarityWordmark height={48} />
    </Pressable>
  );

  const topSection = (
    <Button accessibilityLabel="New search" accessibilityRole="button" onPress={handleNewSearch}
      className="h-11 md:h-9 rounded-full w-full flex-row items-center justify-center gap-2">
      <Plus size={16} color="white" />
      <Text className="text-sm md:text-xs font-medium text-primary-foreground">New Search</Text>
    </Button>
  );

  const scrollableContent = (
    <View className="gap-0.5">
      {isLoading ? <SidebarSkeleton /> : allConvs.length === 0 ? (
        <View className="items-center justify-center py-8">
          <Text className="text-xs text-muted-foreground">No searches yet</Text>
        </View>
      ) : (
        <>
          <ConversationGroup label="Today" items={grouped.today} currentChatId={chatId?.id}
            onSelect={handleSelect} onPrefetch={handlePrefetch} onDelete={handleDelete} />
          <ConversationGroup label="Yesterday" items={grouped.yesterday} currentChatId={chatId?.id}
            onSelect={handleSelect} onPrefetch={handlePrefetch} onDelete={handleDelete} />
          <ConversationGroup label="This Week" items={grouped.thisWeek} currentChatId={chatId?.id}
            onSelect={handleSelect} onPrefetch={handlePrefetch} onDelete={handleDelete} />
          <ConversationGroup label="Older" items={grouped.older} currentChatId={chatId?.id}
            onSelect={handleSelect} onPrefetch={handlePrefetch} onDelete={handleDelete} />
        </>
      )}
    </View>
  );

  const footer = (
    <>
      {isAuthenticated ? (
        <View className="flex-row items-center gap-2">
          <DropdownMenu.Root>
            <DropdownMenu.Trigger>
              <Pressable accessibilityLabel="Account menu" accessibilityRole="button"
                className="h-9 w-9 md:h-8 md:w-8 items-center justify-center rounded-lg hover:bg-muted active:bg-muted">
                <UserAvatar size={24} />
              </Pressable>
            </DropdownMenu.Trigger>
            <DropdownMenu.Content>
              {Platform.OS === "web" ? (
                <View className="flex-row items-center gap-2.5 px-1.5 py-1.5">
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
          <Pressable accessibilityLabel="Settings" accessibilityRole="button" onPress={handleSettings}
            className="h-9 w-9 md:h-8 md:w-8 items-center justify-center rounded-lg hover:bg-muted active:bg-muted">
            <Settings2 size={18} className="text-muted-foreground" />
          </Pressable>
          <View className="flex-1" />
        </View>
      ) : (
        <View className="gap-2 md:gap-1.5">
          <Button onPress={handleLogin} className="h-11 md:h-9 rounded-full w-full">
            <View className="flex-row items-center gap-2 md:gap-1.5">
              <LogIn size={16} className="text-primary-foreground" />
              <Text className="text-sm md:text-xs font-semibold text-primary-foreground">{t("login.signInButton")}</Text>
            </View>
          </Button>
          <Button onPress={handleRegister} variant="outline" className="h-11 md:h-9 rounded-full w-full">
            <View className="flex-row items-center gap-2 md:gap-1.5">
              <UserPlus size={16} className="text-foreground" />
              <Text className="text-sm md:text-xs font-medium">{t("login.footerLink")}</Text>
            </View>
          </Button>
          <View className="flex-row items-center justify-center gap-1 mt-1">
            <Text className="text-[10px] text-muted-foreground underline"
              onPress={() => Linking.openURL("https://oxy.so/company/transparency/policies/privacy")}>
              {t("sidebar.privacyPolicy")}
            </Text>
            <Text className="text-[10px] text-muted-foreground">{"\u00B7"}</Text>
            <Text className="text-[10px] text-muted-foreground underline"
              onPress={() => Linking.openURL("https://oxy.so/company/transparency/policies/terms-of-service")}>
              {t("sidebar.termsOfService")}
            </Text>
          </View>
        </View>
      )}
    </>
  );

  return (
    <BaseSidebar header={header} topSection={topSection} navigation={null}
      scrollableContent={scrollableContent} footer={footer} backgroundColor="bg-sidebar"
      onScroll={handleScroll} showScrollIndicator={false} />
  );
});
