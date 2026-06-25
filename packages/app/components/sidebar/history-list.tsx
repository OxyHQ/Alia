import React from "react";
import { View, ActivityIndicator } from "react-native";
import { useColorScheme } from "@/lib/useColorScheme";
import type { Conversation } from "@/lib/hooks/use-conversations";
import type { Project } from "@/lib/stores/projects-store";
import type { Folder } from "@/lib/stores/folders-store";
import { ConversationItem } from "./conversation-item";
import type { StopPropagationEvent } from '@/lib/types/events';

interface HistoryListProps {
  data: Conversation[];
  currentChatId?: string;
  favoriteIds: string[];
  pinnedIds: string[];
  projects: Project[];
  folders: Folder[];
  isFetchingNextPage?: boolean;
  onSelect: (id: string) => void;
  onToggleFavorite: (id: string, e: StopPropagationEvent) => void;
  onTogglePin: (id: string, e: StopPropagationEvent) => void;
  onMoveToProject: (convId: string, projectId: string | null, e: StopPropagationEvent) => void;
  onMoveToFolder: (convId: string, folderId: string | null, e: StopPropagationEvent) => void;
  onDelete: (id: string, e: StopPropagationEvent) => void;
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
      {data.map((conv) => (
        <ConversationItem
          key={conv.id}
          conversation={conv}
          isActive={currentChatId === conv.id}
          isFavorite={favoriteIds.includes(conv.id)}
          isPinned={pinnedIds.includes(conv.id)}
          currentProject={getConversationProject(conv.id)}
          currentFolder={getConversationFolder(conv.id)}
          projects={projects}
          folders={folders}
          onSelect={onSelect}
          onToggleFavorite={onToggleFavorite}
          onTogglePin={onTogglePin}
          onMoveToProject={onMoveToProject}
          onMoveToFolder={onMoveToFolder}
          onDelete={onDelete}
          onPrefetch={onPrefetch}
          compact
        />
      ))}

      {isFetchingNextPage && (
        <View className="py-3 items-center">
          <ActivityIndicator size="small" color={colors.mutedForeground} />
        </View>
      )}
    </>
  );
});

HistoryList.displayName = "HistoryList";
