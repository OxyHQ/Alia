import React from "react";
import { View, Pressable, ScrollView } from "react-native";
import { Image } from "expo-image";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import {
  Sparkles,
  MessageSquare,
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
} from "lucide-react-native";
import { useStore } from "@/lib/globalStore";
import { useRouter } from "expo-router";
import { useAuthStore } from "@/lib/stores/auth-store";
import { useProjectsStore } from "@/lib/stores/projects-store";
import { useConversations, useDeleteConversation } from "@/lib/hooks/use-conversations";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export const Sidebar = React.memo(function Sidebar() {
  const router = useRouter();
  // Use selectors to avoid worklet serialization issues
  const chatId = useStore((state) => state.chatId);
  const { data: conversations = [] } = useConversations();
  const deleteConversationMutation = useDeleteConversation();
  const user = useAuthStore((state) => state.user);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const logout = useAuthStore((state) => state.logout);
  const projects = useProjectsStore((state) => state.projects);
  const currentProjectId = useProjectsStore((state) => state.currentProjectId);
  const setCurrentProject = useProjectsStore((state) => state.setCurrentProject);
  const createProject = useProjectsStore((state) => state.createProject);

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

  const handleSelectProject = React.useCallback((id: string | null) => {
    setCurrentProject(id);
  }, [setCurrentProject]);

  const handleNewProject = React.useCallback(async () => {
    const projectName = `Project ${projects.length + 1}`;
    await createProject(projectName);
  }, [createProject, projects.length]);

  // Get user initials for avatar
  const getUserInitials = React.useCallback(() => {
    if (!user?.name) return "U";
    const names = user.name.split(" ");
    if (names.length >= 2) {
      return `${names[0][0]}${names[1][0]}`.toUpperCase();
    }
    return names[0][0].toUpperCase();
  }, [user]);

  return (
    <View className="flex-1 bg-background">
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

      {/* Navigation Links */}
      <View className="px-3 md:px-2 pb-3 md:pb-2 gap-1">
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
          onPress={handleSettings}
        >
          <Settings2 size={16} className="text-muted-foreground" />
          <Text className="text-sm md:text-xs">
            Settings
          </Text>
        </Button>
      </View>

      {/* Projects Section */}
      <View className="px-3 md:px-2 pb-2 md:pb-1.5">
        <View className="flex-row items-center justify-between px-2 py-1.5 md:py-1">
          <Text className="text-sm md:text-xs font-medium text-muted-foreground">
            Projects
          </Text>
          <Pressable
            onPress={handleNewProject}
            className="h-5 w-5 md:h-4 md:w-4 rounded active:opacity-70"
          >
            <Plus size={14} className="text-muted-foreground" />
          </Pressable>
        </View>
        <View className="gap-1">
          {/* All Chats - Special project for unorganized chats */}
          <Pressable
            onPress={() => handleSelectProject(null)}
            className={cn(
              "flex-row items-center gap-2 rounded-full py-2.5 md:py-2 px-3 md:px-2.5 transition-colors",
              currentProjectId === null
                ? "bg-muted border border-border"
                : "active:bg-muted/50"
            )}
          >
            <View
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: "#6b7280" }}
            />
            <Text
              className={cn(
                "flex-1 text-sm md:text-xs text-foreground",
                currentProjectId === null && "font-medium"
              )}
            >
              All Chats
            </Text>
          </Pressable>

          {/* Project list */}
          {projects.map((project) => (
            <Pressable
              key={project.id}
              onPress={() => handleSelectProject(project.id)}
              className={cn(
                "flex-row items-center gap-2 rounded-full py-2.5 md:py-2 px-3 md:px-2.5 transition-colors",
                currentProjectId === project.id
                  ? "bg-muted border border-border"
                  : "active:bg-muted/50"
              )}
            >
              <View
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: project.color }}
              />
              <Text
                className={cn(
                  "flex-1 text-sm md:text-xs text-foreground",
                  currentProjectId === project.id && "font-medium"
                )}
                numberOfLines={1}
              >
                {project.name}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {/* Recent History */}
      <View className="flex-1 px-3 md:px-2">
        <Text className="px-2 py-2 md:py-1.5 text-sm md:text-xs font-medium text-muted-foreground">
          {currentProjectId ? projects.find((p) => p.id === currentProjectId)?.name : "Recent History"}
        </Text>
        <ScrollView showsVerticalScrollIndicator={false} className="gap-1">
          {(() => {
            // Filter conversations based on current project
            const filteredConversations = currentProjectId
              ? conversations.filter((conv) =>
                  projects
                    .find((p) => p.id === currentProjectId)
                    ?.conversationIds.includes(conv.id)
                )
              : conversations;

            return filteredConversations.length === 0 ? (
              <View className="items-center justify-center py-8">
                <Text className="text-sm md:text-xs text-muted-foreground">
                  No conversations yet
                </Text>
              </View>
            ) : (
              filteredConversations.map((conv) => (
              <Pressable
                key={conv.id}
                onPress={() => handleSelectConversation(conv.id)}
                className={cn(
                  "group relative flex-row items-center gap-2 rounded-full py-2.5 md:py-2 px-3 md:px-2.5 transition-colors",
                  chatId?.id === conv.id
                    ? "bg-muted border border-border"
                    : "active:bg-muted/50"
                )}
              >
                <MessageSquare
                  size={16}
                  className={cn(
                    "text-muted-foreground",
                    chatId?.id === conv.id && "text-primary"
                  )}
                />
                <Text
                  className={cn(
                    "flex-1 text-sm md:text-xs text-foreground",
                    chatId?.id === conv.id && "font-medium"
                  )}
                  numberOfLines={1}
                >
                  {conv.title || "New conversation"}
                </Text>
                <Button
                  variant="ghost"
                  size="icon"
                  onPress={(e) => handleDeleteConversation(conv.id, e)}
                  className="h-6 md:h-5 w-6 md:w-5 rounded opacity-0 group-hover:opacity-100"
                >
                  <Trash2
                    size={14}
                    className="text-muted-foreground"
                  />
                </Button>
              </Pressable>
              ))
            );
          })()}
        </ScrollView>
      </View>

      {/* Footer with User or Auth Buttons */}
      <View className="border-t border-border/50 p-3 md:p-2">
        {isAuthenticated ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Pressable className="flex-row items-center gap-3 md:gap-2 rounded-full p-2 md:p-1.5 active:bg-muted">
                <Avatar className="h-8 w-8 md:h-7 md:w-7">
                  {user?.image ? (
                    <AvatarImage source={{ uri: user.image }} />
                  ) : null}
                  <AvatarFallback className="bg-primary">
                    <Text className="text-xs md:text-[10px] text-primary-foreground">{getUserInitials()}</Text>
                  </AvatarFallback>
                </Avatar>
                <View className="flex-1">
                  <Text className="text-sm md:text-xs font-medium text-foreground">
                    {user?.name || "User"}
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
                <Text className="text-sm font-medium text-foreground">{user?.name || "User"}</Text>
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
    </View>
  );
});
