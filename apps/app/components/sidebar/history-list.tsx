import React from "react";
import { View, ActivityIndicator, Pressable } from "react-native";
import { useColorScheme } from "@/lib/useColorScheme";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import type { Conversation } from "@/lib/hooks/use-conversations";
import type { Project } from "@/lib/stores/projects-store";
import type { Folder } from "@/lib/stores/folders-store";
import { ConversationMenu } from "./conversation-menu";

interface HistoryListProps {
  data: Conversation[];
  currentChatId?: string;
  favoriteIds: string[];
  pinnedIds: string[];
  projects: Project[];
  folders: Folder[];
  isFetchingNextPage?: boolean;
  onSelect: (id: string) => void;
  onToggleFavorite: (id: string, e: any) => void;
  onTogglePin: (id: string, e: any) => void;
  onMoveToProject: (convId: string, projectId: string | null, e: any) => void;
  onMoveToFolder: (convId: string, folderId: string | null, e: any) => void;
  onDelete: (id: string, e: any) => void;
  onPrefetch?: (id: string) => void;
  getConversationProject: (id: string) => Project | undefined;
  getConversationFolder: (id: string) => Folder | undefined;
}

export const HistoryList = React.memo<HistoryListProps>(({
  data,
  currentChatId,
  favoriteIds,
  pinnedIds,
  projects,
  folders,
  isFetchingNextPage,
  onSelect,
  onToggleFavorite,
  onTogglePin,
  onMoveToProject,
  onMoveToFolder,
  onDelete,
  onPrefetch,
  getConversationProject,
  getConversationFolder,
}) => {
  const { colors } = useColorScheme();
  if (data.length === 0) {
    return null;
  }

  return (
    <>
      {data.map((conv) => {
        const convProject = getConversationProject(conv.id);
        const convFolder = getConversationFolder(conv.id);
        const isConvFavorite = favoriteIds.includes(conv.id);
        const isActive = currentChatId === conv.id;

        return (
          <View
            key={conv.id}
            className={cn(
              "flex-row items-center gap-1 rounded-full group",
              isActive && "bg-muted border border-border"
            )}
          >
            <Pressable
              onPress={() => onSelect(conv.id)}
              onPressIn={() => onPrefetch?.(conv.id)}
              // @ts-ignore web-only prop
              onHoverIn={() => onPrefetch?.(conv.id)}
              className={cn(
                "flex-1 flex-row items-center gap-2 py-1.5 pl-2.5 pr-1",
                !isActive && "active:bg-muted/50 rounded-full"
              )}
            >
              <Text
                className={cn(
                  "flex-1 text-xs text-foreground",
                  isActive && "font-medium"
                )}
                numberOfLines={1}
              >
                {conv.title || "New conversation"}
              </Text>
            </Pressable>
            <ConversationMenu
              conversation={conv}
              currentProject={convProject}
              currentFolder={convFolder}
              isFavorite={isConvFavorite}
              isPinned={pinnedIds.includes(conv.id)}
              projects={projects}
              folders={folders}
              onToggleFavorite={onToggleFavorite}
              onTogglePin={onTogglePin}
              onMoveToProject={onMoveToProject}
              onMoveToFolder={onMoveToFolder}
              onDelete={onDelete}
            />
          </View>
        );
      })}

      {isFetchingNextPage && (
        <View className="py-3 items-center">
          <ActivityIndicator size="small" color={colors.mutedForeground} />
        </View>
      )}
    </>
  );
});

HistoryList.displayName = "HistoryList";
