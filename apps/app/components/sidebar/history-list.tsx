import React from "react";
import { View, ActivityIndicator } from "react-native";
import { Text } from "@/components/ui/text";
import { FlashList } from "@shopify/flash-list";
import { MessageSquare, Star as StarIcon } from "lucide-react-native";
import { Pressable } from "react-native";
import type { Conversation } from "@/lib/hooks/use-conversations";
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
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  onSelect: (id: string) => void;
  onToggleFavorite: (id: string, e: any) => void;
  onMoveToProject: (convId: string, projectId: string | null, e: any) => void;
  onMoveToFolder: (convId: string, folderId: string | null, e: any) => void;
  onDelete: (id: string, e: any) => void;
  onLoadMore: () => void;
  getConversationProject: (id: string) => Project | undefined;
  getConversationFolder: (id: string) => Folder | undefined;
}

export const HistoryList = React.memo<HistoryListProps>(({
  data,
  currentChatId,
  favoriteIds,
  projects,
  folders,
  hasNextPage,
  isFetchingNextPage,
  onSelect,
  onToggleFavorite,
  onMoveToProject,
  onMoveToFolder,
  onDelete,
  onLoadMore,
  getConversationProject,
  getConversationFolder,
}) => {
  const renderItem = React.useCallback(({ item }: { item: ConversationListItem }) => {
    if (item.type === 'header') {
      return (
        <View style={{ paddingHorizontal: 8, paddingVertical: 4, marginTop: 4 }}>
          <Text style={{ fontSize: 11, fontWeight: '600', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 0.5 }}>
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
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 2,
          borderRadius: 9999,
          backgroundColor: isActive ? '#f3f4f6' : 'transparent',
          borderWidth: isActive ? 1 : 0,
          borderColor: isActive ? '#e5e7eb' : 'transparent',
        }}
      >
        <Pressable
          onPress={() => onSelect(conv.id)}
          style={{
            flex: 1,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            paddingVertical: 6,
            paddingLeft: 10,
            paddingRight: 4,
            borderRadius: 9999,
          }}
        >
          <MessageSquare
            size={14}
            color={isActive ? '#3b82f6' : '#6b7280'}
          />
          <Text
            style={{
              flex: 1,
              fontSize: 13,
              color: '#1f2937',
              fontWeight: isActive ? '500' : '400',
            }}
            numberOfLines={1}
          >
            {conv.title || "New conversation"}
          </Text>
          {isConvFavorite && (
            <StarIcon size={10} color="#f59e0b" fill="#f59e0b" />
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
  }, [currentChatId, favoriteIds, projects, folders, onSelect, onToggleFavorite, onMoveToProject, onMoveToFolder, onDelete, getConversationProject, getConversationFolder]);

  if (data.length === 0) {
    return null;
  }

  return (
    <View style={{ minHeight: 200 }}>
      <FlashList
        data={data}
        renderItem={renderItem}
        estimatedItemSize={35}
        onEndReached={() => {
          if (hasNextPage && !isFetchingNextPage) {
            onLoadMore();
          }
        }}
        onEndReachedThreshold={0.5}
        ListFooterComponent={
          isFetchingNextPage ? (
            <View style={{ paddingVertical: 12, alignItems: 'center' }}>
              <ActivityIndicator size="small" />
            </View>
          ) : null
        }
        // @ts-ignore - FlashList types issue
      />
    </View>
  );
});

HistoryList.displayName = "HistoryList";
