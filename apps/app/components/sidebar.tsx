import React from "react";
import { View, Pressable, ScrollView, Image } from "react-native";
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
} from "lucide-react-native";
import { useStore } from "@/lib/globalStore";
import { generateUUID } from "@/lib/utils";
import { useRouter } from "expo-router";
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
  const conversations = useStore((state) => state.conversations);

  const handleNewChat = React.useCallback(() => {
    const newChatId = generateUUID();
    useStore.getState().setChatId({ id: newChatId, from: "newChat" });
    router.push("/");
  }, [router]);

  const handleLogoPress = React.useCallback(() => {
    router.push("/");
  }, [router]);

  const handleSelectConversation = React.useCallback((id: string) => {
    router.push(`/c/${id}`);
  }, [router]);

  const handleDeleteConversation = React.useCallback((id: string, e: any) => {
    e.stopPropagation();
    useStore.getState().deleteConversation(id);
  }, []);

  return (
    <View className="flex-1 bg-background">
      {/* Header with Logo */}
      <View className="border-b border-border/50 p-4">
        <Pressable onPress={handleLogoPress} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
          <Image
            source={require("@/assets/images/logo.png")}
            style={{ width: "100%", height: 60 }}
            resizeMode="contain"
          />
        </Pressable>
      </View>

      {/* New Chat Button */}
      <View className="p-3">
        <Button
          onPress={handleNewChat}
          variant="outline"
          className="flex-row items-center justify-center gap-2 rounded-xl w-full"
        >
          <Sparkles size={16} className="text-primary" />
          <Text className="text-sm font-medium">
            New Chat
          </Text>
        </Button>
      </View>

      {/* Navigation Links */}
      <View className="px-3 pb-3 gap-1">
        <Button
          variant="ghost"
          className="flex-row items-center justify-start gap-2 rounded-lg px-2 w-full"
        >
          <Users size={16} className="text-muted-foreground" />
          <Text className="text-sm">Agents</Text>
        </Button>
        <Button
          variant="ghost"
          className="flex-row items-center justify-start gap-2 rounded-lg px-2 w-full"
        >
          <Settings2 size={16} className="text-muted-foreground" />
          <Text className="text-sm">
            Admin Dashboard
          </Text>
        </Button>
      </View>

      {/* Recent History */}
      <View className="flex-1 px-3">
        <Text className="px-2 py-2 text-xs font-medium text-muted-foreground">
          Recent History
        </Text>
        <ScrollView showsVerticalScrollIndicator={false} className="gap-1">
          {conversations.length === 0 ? (
            <View className="items-center justify-center py-8">
              <Text className="text-xs text-muted-foreground">
                No conversations yet
              </Text>
            </View>
          ) : (
            conversations.map((conv) => (
              <Pressable
                key={conv.id}
                onPress={() => handleSelectConversation(conv.id)}
                className={cn(
                  "group relative flex-row items-center gap-2 rounded-lg p-2.5 transition-colors",
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
                    "flex-1 text-sm text-foreground",
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
                  className="h-6 w-6 rounded opacity-0 group-hover:opacity-100"
                >
                  <Trash2
                    size={14}
                    className="text-muted-foreground"
                  />
                </Button>
              </Pressable>
            ))
          )}
        </ScrollView>
      </View>

      {/* Footer with User */}
      <View className="border-t border-border/50 p-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Pressable className="flex-row items-center gap-3 rounded-xl p-2 active:bg-muted">
              <Avatar className="h-8 w-8">
                <AvatarImage source={{ uri: "https://github.com/shadcn.png" }} />
                <AvatarFallback className="bg-primary">
                  <Text className="text-xs text-primary-foreground">U</Text>
                </AvatarFallback>
              </Avatar>
              <View className="flex-1">
                <Text className="text-sm font-medium text-foreground">
                  User
                </Text>
                <Text className="text-xs text-muted-foreground">
                  user@alia.onl
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
              <Text className="text-sm font-medium text-foreground">User</Text>
              <Text className="text-xs text-muted-foreground">user@alia.onl</Text>
            </View>
            <DropdownMenuSeparator />
            <DropdownMenuItem>
              <Sparkle size={16} className="text-muted-foreground" />
              <Text className="text-sm">Upgrade to Pro</Text>
            </DropdownMenuItem>
            <DropdownMenuItem>
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
            <DropdownMenuItem variant="destructive">
              <LogOut size={16} className="text-destructive" />
              <Text className="text-sm">Log out</Text>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </View>
    </View>
  );
});
