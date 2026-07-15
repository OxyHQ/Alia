import React from "react";
import { View, Pressable, ActivityIndicator } from "react-native";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useColorScheme } from "@/lib/useColorScheme";
import type { Conversation } from "@/lib/hooks/use-conversations";
import type { Project } from "@/lib/stores/projects-store";
import type { Folder } from "@/lib/stores/folders-store";
import { useStore } from "@/lib/stores/global-store";
import { ConversationMenu } from "./conversation-menu";
import type { StopPropagationEvent } from '@/lib/types/events';

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
  onToggleFavorite: (id: string, e: StopPropagationEvent) => void;
  onTogglePin: (id: string, e: StopPropagationEvent) => void;
  onMoveToProject: (convId: string, projectId: string | null, e: StopPropagationEvent) => void;
  onMoveToFolder: (convId: string, folderId: string | null, e: StopPropagationEvent) => void;
  onDelete: (id: string, e: StopPropagationEvent) => void;
  onPrefetch?: (id: string) => void;
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
        "flex-row items-center gap-1 rounded-xl group hover:bg-muted",
        indented && "ml-4",
        isActive && "bg-muted"
      )}
    >
      <Pressable
        onPress={() => onSelect(conversation.id)}
        onPressIn={handlePrefetch}
        onHoverIn={handlePrefetch}
        className={cn(
          "flex-1 h-9 flex-row items-center gap-2 pl-2.5 pr-1 rounded-xl",
          !isActive && "active:bg-muted/50"
        )}
      >
        {isStreaming && (
          <ActivityIndicator size={16} color={colors.mutedForeground} />
        )}
        <Text
          className={cn(
            "flex-1 text-sm",
            isActive ? "text-foreground font-medium" : "text-muted-foreground group-hover:text-foreground"
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
