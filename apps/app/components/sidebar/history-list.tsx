import React from "react";
import { View, ActivityIndicator, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { MessageSquare, Star as StarIcon } from "lucide-react-native";
import { cn } from "@/lib/utils";
import type { ConversationListItem } from "@/lib/utils/conversation-grouping";
import type { Project } from "@/lib/stores/projects-store";
import type { Folder } from "@/lib/stores/folders-store";
import { ConversationMenu } from "./conversation-menu";

interface HistoryListProps {
  data: ConversationListItem[];
  currentChatId?: string;
  favoriteIds: string[];
  projects: Project[];
  folders: Folder[];
  isFetchingNextPage?: boolean;
  onSelect: (id: string) => void;
  onToggleFavorite: (id: string, e: any) => void;
  onMoveToProject: (convId: string, projectId: string | null, e: any) => void;
  onMoveToFolder: (convId: string, folderId: string | null, e: any) => void;
  onDelete: (id: string, e: any) => void;
  getConversationProject: (id: string) => Project | undefined;
  getConversationFolder: (id: string) => Folder | undefined;
}

export const HistoryList = React.memo<HistoryListProps>(({
  data,
  currentChatId,
  favoriteIds,
  projects,
  folders,
  isFetchingNextPage,
  onSelect,
  onToggleFavorite,
  onMoveToProject,
  onMoveToFolder,
  onDelete,
  getConversationProject,
  getConversationFolder,
}) => {
  if (data.length === 0) {
    return null;
  }

  return (
    <>
      {data.map((item, index) => {
        if (item.type === 'header') {
          return (
            <View key={`header-${item.group}`} className="px-2 py-1 mt-1">
              <Text className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                {item.group}
              </Text>
            </View>
          );
        }

        const conv = item.conversation!;
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
              className={cn(
                "flex-1 flex-row items-center gap-2 py-1.5 pl-2.5 pr-1",
                !isActive && "active:bg-muted/50 rounded-full"
              )}
            >
              <MessageSquare
                size={13}
                className={cn(
                  "text-muted-foreground",
                  isActive && "text-primary"
                )}
              />
              <Text
                className={cn(
                  "flex-1 text-xs text-foreground",
                  isActive && "font-medium"
                )}
                numberOfLines={1}
              >
                {conv.title || "New conversation"}
              </Text>
              {isConvFavorite && (
                <StarIcon size={10} className="text-amber-500" fill="#f59e0b" />
              )}
            </Pressable>
            <ConversationMenu
              conversation={conv}
              currentProject={convProject}
              currentFolder={convFolder}
              isFavorite={isConvFavorite}
              projects={projects}
              folders={folders}
              onToggleFavorite={onToggleFavorite}
              onMoveToProject={onMoveToProject}
              onMoveToFolder={onMoveToFolder}
              onDelete={onDelete}
            />
          </View>
        );
      })}

      {isFetchingNextPage && (
        <View className="py-3 items-center">
          <ActivityIndicator size="small" />
        </View>
      )}
    </>
  );
});

HistoryList.displayName = "HistoryList";
