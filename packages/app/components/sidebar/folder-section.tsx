import React from "react";
import { View, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import * as DropdownMenu from "@/components/ui/dropdown-menu";
import {
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  Folder as FolderIcon,
} from "lucide-react-native";
import type { Conversation } from "@/lib/hooks/use-conversations";
import type { Folder } from "@/lib/stores/folders-store";
import type { Project } from "@/lib/stores/projects-store";
import { ConversationItem } from "./conversation-item";
import type { StopPropagationEvent } from '@/lib/types/events';

const ICON_MAP: Record<string, any> = {
  Folder: FolderIcon,
  FolderIcon,
};

interface FolderSectionProps {
  folder: Folder;
  conversations: Conversation[];
  currentChatId?: string;
  favoriteIds: string[];
  pinnedIds: string[];
  projects: Project[];
  folders: Folder[];
  onToggle: (id: string) => void;
  onEdit: (folder: Folder, e: StopPropagationEvent) => void;
  onDelete: (id: string, e: StopPropagationEvent) => void;
  onToggleFavorite: (folder: Folder, e: StopPropagationEvent) => void;
  onSelectConversation: (id: string) => void;
  onToggleFavoriteConversation: (id: string, e: StopPropagationEvent) => void;
  onTogglePinConversation: (id: string, e: StopPropagationEvent) => void;
  onMoveToProject: (convId: string, projectId: string | null, e: StopPropagationEvent) => void;
  onMoveToFolder: (convId: string, folderId: string | null, e: StopPropagationEvent) => void;
  onDeleteConversation: (id: string, e: StopPropagationEvent) => void;
  onPrefetchConversation?: (id: string) => void;
  getConversationProject: (id: string) => Project | undefined;
  getConversationFolder: (id: string) => Folder | undefined;
}

export const FolderSection = React.memo<FolderSectionProps>(({
  folder,
  conversations,
  currentChatId,
  favoriteIds,
  pinnedIds,
  projects,
  folders,
  onToggle,
  onEdit,
  onDelete,
  onToggleFavorite,
  onSelectConversation,
  onToggleFavoriteConversation,
  onTogglePinConversation,
  onMoveToProject,
  onMoveToFolder,
  onDeleteConversation,
  onPrefetchConversation,
  getConversationProject,
  getConversationFolder,
}) => {
  const Icon = ICON_MAP[folder.icon || "Folder"] || FolderIcon;

  return (
    <View className="gap-0.5">
      {/* Folder Header */}
      <View className="flex-row items-center gap-1 rounded-xl group hover:bg-muted">
        <Pressable
          onPress={() => onToggle(folder.id)}
          className="flex-1 h-9 flex-row items-center gap-2 px-2 active:bg-muted/50 rounded-xl"
        >
          <Icon
            size={16}
            className="text-muted-foreground"
            color={folder.color}
          />
          <Text
            className="flex-1 text-sm text-foreground font-medium"
            numberOfLines={1}
          >
            {folder.name}
          </Text>
          <Text className="text-xs text-muted-foreground mr-1">
            {conversations.length}
          </Text>
          {folder.isExpanded ? (
            <ChevronDown size={12} className="text-muted-foreground" />
          ) : (
            <ChevronRight size={12} className="text-muted-foreground" />
          )}
        </Pressable>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            <Pressable className="h-6 w-6 items-center justify-center rounded-lg mr-1 web:opacity-0 web:group-hover:opacity-100 active:bg-muted/70">
              <MoreHorizontal size={12} className="text-muted-foreground" />
            </Pressable>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content>
            <DropdownMenu.Item key="favorite" onSelect={() => onToggleFavorite(folder, {})}>
              <DropdownMenu.ItemIcon ios={{ name: folder.isFavorite ? "star.fill" : "star" }} />
              <DropdownMenu.ItemTitle>
                {folder.isFavorite ? "Unfavorite" : "Favorite"}
              </DropdownMenu.ItemTitle>
            </DropdownMenu.Item>
            <DropdownMenu.Item key="edit" onSelect={() => onEdit(folder, {})}>
              <DropdownMenu.ItemIcon ios={{ name: "pencil" }} />
              <DropdownMenu.ItemTitle>Edit Folder</DropdownMenu.ItemTitle>
            </DropdownMenu.Item>
            <DropdownMenu.Separator />
            <DropdownMenu.Item key="delete" destructive onSelect={() => onDelete(folder.id, {})}>
              <DropdownMenu.ItemIcon ios={{ name: "trash" }} />
              <DropdownMenu.ItemTitle>Delete Folder</DropdownMenu.ItemTitle>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </View>

      {/* Folder Conversations */}
      {folder.isExpanded && conversations
        .sort((a, b) => (favoriteIds.includes(b.id) ? 1 : 0) - (favoriteIds.includes(a.id) ? 1 : 0))
        .map((conv) => (
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
            onSelect={onSelectConversation}
            onToggleFavorite={onToggleFavoriteConversation}
            onTogglePin={onTogglePinConversation}
            onMoveToProject={onMoveToProject}
            onMoveToFolder={onMoveToFolder}
            onDelete={onDeleteConversation}
            onPrefetch={onPrefetchConversation}
            indented
          />
        ))}
    </View>
  );
});

FolderSection.displayName = "FolderSection";
