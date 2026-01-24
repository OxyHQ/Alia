import React from "react";
import { View, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  Edit,
  Trash2,
  Star as StarIcon,
  Folder as FolderIcon,
} from "lucide-react-native";
import type { Conversation } from "@/lib/hooks/use-conversations";
import type { Folder } from "@/lib/stores/folders-store";
import type { Project } from "@/lib/stores/projects-store";
import { ConversationItem } from "./conversation-item";

const ICON_MAP: Record<string, any> = {
  Folder: FolderIcon,
  FolderIcon,
};

interface FolderSectionProps {
  folder: Folder;
  conversations: Conversation[];
  currentChatId?: string;
  favoriteIds: string[];
  projects: Project[];
  folders: Folder[];
  onToggle: (id: string) => void;
  onEdit: (folder: Folder, e: any) => void;
  onDelete: (id: string, e: any) => void;
  onToggleFavorite: (folder: Folder, e: any) => void;
  onSelectConversation: (id: string) => void;
  onToggleFavoriteConversation: (id: string, e: any) => void;
  onMoveToProject: (convId: string, projectId: string | null, e: any) => void;
  onMoveToFolder: (convId: string, folderId: string | null, e: any) => void;
  onDeleteConversation: (id: string, e: any) => void;
  getConversationProject: (id: string) => Project | undefined;
  getConversationFolder: (id: string) => Folder | undefined;
}

export const FolderSection = React.memo<FolderSectionProps>(({
  folder,
  conversations,
  currentChatId,
  favoriteIds,
  projects,
  folders,
  onToggle,
  onEdit,
  onDelete,
  onToggleFavorite,
  onSelectConversation,
  onToggleFavoriteConversation,
  onMoveToProject,
  onMoveToFolder,
  onDeleteConversation,
  getConversationProject,
  getConversationFolder,
}) => {
  const Icon = ICON_MAP[folder.icon || "Folder"] || FolderIcon;

  return (
    <View className="gap-0.5">
      {/* Folder Header */}
      <View className="flex-row items-center gap-1 rounded-lg group">
        <Pressable
          onPress={() => onToggle(folder.id)}
          className="flex-1 flex-row items-center gap-2 py-1.5 px-2 active:bg-muted/50 rounded-lg"
        >
          <Icon
            size={14}
            className="text-muted-foreground"
            style={{ color: folder.color }}
          />
          <Text
            className="flex-1 text-xs text-foreground font-medium"
            numberOfLines={1}
          >
            {folder.name}
          </Text>
          {folder.isFavorite && (
            <StarIcon size={10} className="text-amber-500" fill="#f59e0b" />
          )}
          <Text className="text-xs text-muted-foreground mr-1">
            {conversations.length}
          </Text>
          {folder.isExpanded ? (
            <ChevronDown size={12} className="text-muted-foreground" />
          ) : (
            <ChevronRight size={12} className="text-muted-foreground" />
          )}
        </Pressable>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Pressable className="h-7 w-7 items-center justify-center rounded-full mr-1 active:bg-muted/70">
              <MoreHorizontal size={12} className="text-muted-foreground" />
            </Pressable>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="bottom" align="end" className="w-48">
            <DropdownMenuItem onPress={(e) => onToggleFavorite(folder, e)}>
              <StarIcon size={16} className="text-muted-foreground" />
              <Text className="text-sm">
                {folder.isFavorite ? "Unfavorite" : "Favorite"}
              </Text>
            </DropdownMenuItem>
            <DropdownMenuItem onPress={(e) => onEdit(folder, e)}>
              <Edit size={16} className="text-muted-foreground" />
              <Text className="text-sm">Edit Folder</Text>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onPress={(e) => onDelete(folder.id, e)}
            >
              <Trash2 size={16} className="text-destructive" />
              <Text className="text-sm">Delete Folder</Text>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
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
            currentProject={getConversationProject(conv.id)}
            currentFolder={getConversationFolder(conv.id)}
            projects={projects}
            folders={folders}
            onSelect={onSelectConversation}
            onToggleFavorite={onToggleFavoriteConversation}
            onMoveToProject={onMoveToProject}
            onMoveToFolder={onMoveToFolder}
            onDelete={onDeleteConversation}
            compact
            indented
          />
        ))}
    </View>
  );
});

FolderSection.displayName = "FolderSection";
