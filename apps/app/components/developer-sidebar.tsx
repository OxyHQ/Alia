import React from "react";
import { View, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import {
  Code,
  BookOpen,
  FileCode,
  Package,
  Home,
  LogOut,
  UserCircle,
  BarChart3,
  CreditCard,
} from "lucide-react-native";
import { useRouter, usePathname } from "expo-router";
import { useAuth } from "@oxyhq/services";
import { useApps } from "@/lib/hooks/use-developer";
import { OrganizationSwitcher } from "@/components/organization-switcher";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { BaseSidebar } from "@/components/base-sidebar";

export const DeveloperSidebar = React.memo(function DeveloperSidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const { user, isAuthenticated, logout } = useAuth();
  const { data: apps = [] } = useApps();

  const handleLogoPress = React.useCallback(() => {
    router.replace("/developers");
  }, [router]);

  const handleHome = React.useCallback(() => {
    router.replace("/(app)");
  }, [router]);

  const handleDashboard = React.useCallback(() => {
    router.replace("/developers");
  }, [router]);

  const handleDocumentation = React.useCallback(() => {
    router.push("/developers/documentation");
  }, [router]);

  const handleExamples = React.useCallback(() => {
    router.push("/developers/examples");
  }, [router]);

  const handleBilling = React.useCallback(() => {
    router.push("/developers/billing");
  }, [router]);

  const handleAccount = React.useCallback(() => {
    router.push("/(app)/settings/account");
  }, [router]);

  const handleLogout = React.useCallback(() => {
    logout();
    router.replace("/login");
  }, [router, logout]);

  const handleSelectApp = React.useCallback((appId: string) => {
    router.push(`/developers/apps/${appId}`);
  }, [router]);

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

  // Header component
  const header = (
    <Pressable onPress={handleLogoPress} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
      <View className="flex-row items-center">
        <Code size={32} className="text-primary mr-2" />
        <View>
          <Text className="text-lg font-bold text-foreground">Developers</Text>
          <Text className="text-xs text-muted-foreground">Alia AI</Text>
        </View>
      </View>
    </Pressable>
  );

  // Top section with organization switcher
  const topSection = <OrganizationSwitcher />;

  // Navigation links
  const navigation = (
    <>
      <Button
        variant="ghost"
        className={cn(
          "h-10 md:h-8 flex-row items-center justify-start gap-2 rounded-full px-3 md:px-2 w-full",
          pathname === "/" || pathname === "/(app)" ? "bg-muted" : ""
        )}
        onPress={handleHome}
      >
        <Home size={16} className="text-muted-foreground" />
        <Text className="text-sm md:text-xs">Back to App</Text>
      </Button>

      <Button
        variant="ghost"
        className={cn(
          "h-10 md:h-8 flex-row items-center justify-start gap-2 rounded-full px-3 md:px-2 w-full",
          pathname === "/developers" ? "bg-muted" : ""
        )}
        onPress={handleDashboard}
      >
        <BarChart3 size={16} className="text-muted-foreground" />
        <Text className="text-sm md:text-xs">Dashboard</Text>
      </Button>

      <Button
        variant="ghost"
        className={cn(
          "h-10 md:h-8 flex-row items-center justify-start gap-2 rounded-full px-3 md:px-2 w-full",
          pathname === "/developers/documentation" ? "bg-muted" : ""
        )}
        onPress={handleDocumentation}
      >
        <BookOpen size={16} className="text-muted-foreground" />
        <Text className="text-sm md:text-xs">Documentation</Text>
      </Button>

      <Button
        variant="ghost"
        className={cn(
          "h-10 md:h-8 flex-row items-center justify-start gap-2 rounded-full px-3 md:px-2 w-full",
          pathname === "/developers/examples" ? "bg-muted" : ""
        )}
        onPress={handleExamples}
      >
        <FileCode size={16} className="text-muted-foreground" />
        <Text className="text-sm md:text-xs">Examples</Text>
      </Button>

      <Button
        variant="ghost"
        className={cn(
          "h-10 md:h-8 flex-row items-center justify-start gap-2 rounded-full px-3 md:px-2 w-full",
          pathname === "/developers/billing" ? "bg-muted" : ""
        )}
        onPress={handleBilling}
      >
        <CreditCard size={16} className="text-muted-foreground" />
        <Text className="text-sm md:text-xs">Billing</Text>
      </Button>
    </>
  );

  // Scrollable content - My Apps
  const scrollableContent = (
    <View className="gap-2">
      <View className="flex-row items-center justify-between px-2 py-2 md:py-1.5">
        <Text className="text-sm md:text-xs font-medium text-muted-foreground">
          My Apps
        </Text>
        <Text className="text-xs text-muted-foreground">
          {apps.length}
        </Text>
      </View>
      <View className="gap-1">
        {apps.length === 0 ? (
          <View className="items-center justify-center py-8">
            <Package size={32} className="text-muted-foreground mb-2" />
            <Text className="text-sm md:text-xs text-muted-foreground text-center">
              No apps yet
            </Text>
            <Text className="text-xs text-muted-foreground text-center mt-1">
              Create your first app
            </Text>
          </View>
        ) : (
          apps.map((app) => (
            <Pressable
              key={app._id}
              onPress={() => handleSelectApp(app._id)}
              className={cn(
                "group relative flex-row items-center gap-2 rounded-full py-2.5 md:py-2 px-3 md:px-2.5 transition-colors",
                pathname.includes(app._id)
                  ? "bg-muted border border-border"
                  : "active:bg-muted/50"
              )}
            >
              <Package
                size={16}
                className={cn(
                  "text-muted-foreground",
                  pathname.includes(app._id) && "text-primary"
                )}
              />
              <View className="flex-1">
                <Text
                  className={cn(
                    "text-sm md:text-xs text-foreground",
                    pathname.includes(app._id) && "font-medium"
                  )}
                  numberOfLines={1}
                >
                  {app.name}
                </Text>
                {!app.isActive && (
                  <Text className="text-xs text-muted-foreground">Inactive</Text>
                )}
              </View>
              {pathname.includes(app._id) && (
                <View className="w-1 h-1 rounded-full bg-primary" />
              )}
            </Pressable>
          ))
        )}
      </View>
    </View>
  );

  // Footer with user dropdown
  const footer = isAuthenticated ? (
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
              Developer
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
        <DropdownMenuItem onPress={handleAccount}>
          <UserCircle size={16} className="text-muted-foreground" />
          <Text className="text-sm">Account</Text>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onPress={handleLogout}>
          <LogOut size={16} className="text-destructive" />
          <Text className="text-sm">Log out</Text>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ) : (
    <View className="items-center py-4">
      <Text className="text-sm text-muted-foreground text-center">
        Please sign in to access developer features
      </Text>
    </View>
  );

  return (
    <BaseSidebar
      header={header}
      topSection={topSection}
      navigation={navigation}
      scrollableContent={scrollableContent}
      footer={footer}
      backgroundColor="bg-background"
    />
  );
});
