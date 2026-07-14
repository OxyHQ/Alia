import React from "react";
import { View, ActivityIndicator } from "react-native";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import { useTranslation } from "@/hooks/useTranslation";
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
  const { t } = useTranslation();

  // Bucket by recency for the reference-style date separators. `data` arrives
  // sorted by updatedAt desc, so bucket order matches render order.
  const groups = React.useMemo(() => {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfYesterday = startOfToday - 86_400_000;
    const startOfWeek = startOfToday - 6 * 86_400_000;
    const buckets = [
      { label: t('sidebar.today'), items: [] as Conversation[] },
      { label: t('sidebar.yesterday'), items: [] as Conversation[] },
      { label: t('sidebar.previous7Days'), items: [] as Conversation[] },
      { label: t('sidebar.earlier'), items: [] as Conversation[] },
    ];
    for (const conv of data) {
      const ts = conv.updatedAt.getTime();
      if (ts >= startOfToday) buckets[0].items.push(conv);
      else if (ts >= startOfYesterday) buckets[1].items.push(conv);
      else if (ts >= startOfWeek) buckets[2].items.push(conv);
      else buckets[3].items.push(conv);
    }
    return buckets.filter((b) => b.items.length > 0);
  }, [data, t]);

  if (data.length === 0) {
    return null;
  }

  return (
    <>
      {groups.map((group) => (
        <React.Fragment key={group.label}>
          <View className="flex-row items-center gap-2 pt-3 pb-1 px-2 opacity-80">
            <Text className="text-[11px] text-muted-foreground select-none shrink-0">
              {group.label}
            </Text>
            <View className="h-px bg-border flex-1" />
          </View>
          {group.items.map((conv) => (
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
            />
          ))}
        </React.Fragment>
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
