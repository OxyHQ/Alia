import React from "react";
import { View, Pressable, ActivityIndicator } from "react-native";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useColorScheme } from "@/lib/useColorScheme";
import type { Conversation } from "@/lib/hooks/use-conversations";
import type { Project } from "@/lib/stores/projects-store";
import type { Folder } from "@/lib/stores/folders-store";
import { useStore } from "@/lib/globalStore";
import { ConversationMenu } from "./conversation-menu";

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  isFavorite: boolean;
  isPinned: boolean;
  currentProject?: Project;
  currentFolder?: Folder;
  projects: Project[];
  folders: Folder[];
  onSelect: (id: string) => void;
  onToggleFavorite: (id: string, e: any) => void;
  onTogglePin: (id: string, e: any) => void;
  onMoveToProject: (convId: string, projectId: string | null, e: any) => void;
  onMoveToFolder: (convId: string, folderId: string | null, e: any) => void;
  onDelete: (id: string, e: any) => void;
  onPrefetch?: (id: string) => void;
  compact?: boolean;
  indented?: boolean;
}

export const ConversationItem = React.memo<ConversationItemProps>(({
  conversation,
  isActive,
  isFavorite,
  isPinned,
  currentProject,
  currentFolder,
  projects,
  folders,
  onSelect,
  onToggleFavorite,
  onTogglePin,
  onMoveToProject,
  onMoveToFolder,
  onDelete,
  onPrefetch,
  compact = false,
  indented = false,
}) => {
  const { colors } = useColorScheme();
  const isStreaming = useStore((s) => s.streamingChatId === conversation.id);

  const handlePrefetch = React.useCallback(() => {
    onPrefetch?.(conversation.id);
  }, [onPrefetch, conversation.id]);

  return (
    <View
      className={cn(
        "flex-row items-center gap-1 rounded-full group",
        indented && "ml-4",
        isActive ? "bg-muted border border-border" : ""
      )}
    >
      <Pressable
        onPress={() => onSelect(conversation.id)}
        onPressIn={handlePrefetch}
        // @ts-ignore web-only prop
        onHoverIn={handlePrefetch}
        className={cn(
          "flex-1 flex-row items-center gap-2",
          compact ? "py-1.5 pl-2.5 pr-1" : "py-2.5 md:py-2 pl-3 md:pl-2.5 pr-1",
          !isActive && "active:bg-muted/50 rounded-full"
        )}
      >
        {isStreaming && (
          <ActivityIndicator size={16} color={colors.mutedForeground} />
        )}
        <Text
          className={cn(
            "flex-1 text-foreground",
            compact ? "text-xs" : "text-sm md:text-xs",
            isActive && "font-medium"
          )}
          numberOfLines={1}
        >
          {conversation.title || "New conversation"}
        </Text>
      </Pressable>
      <ConversationMenu
        conversation={conversation}
        currentProject={currentProject}
        currentFolder={currentFolder}
        isFavorite={isFavorite}
        isPinned={isPinned}
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
});

ConversationItem.displayName = "ConversationItem";
