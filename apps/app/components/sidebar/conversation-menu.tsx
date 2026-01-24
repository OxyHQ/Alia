import React from "react";
import { View } from "react-native";
import { Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  MoreHorizontal,
  Trash2,
  FolderOpen,
  Edit,
  Star as StarIcon,
} from "lucide-react-native";
import type { Conversation } from "@/lib/hooks/use-conversations";
import type { Project } from "@/lib/stores/projects-store";
import type { Folder } from "@/lib/stores/folders-store";

const ICON_MAP: Record<string, any> = {
  FolderOpen,
};

interface ConversationMenuProps {
  conversation: Conversation;
  currentProject?: Project;
  currentFolder?: Folder;
  isFavorite: boolean;
  projects: Project[];
  folders: Folder[];
  onToggleFavorite: (id: string, e: any) => void;
  onMoveToProject: (convId: string, projectId: string | null, e: any) => void;
  onMoveToFolder: (convId: string, folderId: string | null, e: any) => void;
  onDelete: (id: string, e: any) => void;
}

export const ConversationMenu = React.memo<ConversationMenuProps>(({
  conversation,
  currentProject,
  currentFolder,
  isFavorite,
  projects,
  folders,
  onToggleFavorite,
  onMoveToProject,
  onMoveToFolder,
  onDelete,
}) => {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Pressable className="h-8 w-8 items-center justify-center rounded-full mr-1 active:bg-muted/70 opacity-0 group-hover:opacity-100">
          <MoreHorizontal size={14} className="text-muted-foreground" />
        </Pressable>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="end" className="w-56">
        <DropdownMenuItem onPress={(e) => onToggleFavorite(conversation.id, e)}>
          <StarIcon
            size={16}
            className="text-muted-foreground"
            fill={isFavorite ? "#f59e0b" : "none"}
            style={isFavorite ? { color: "#f59e0b" } : {}}
          />
          <Text className="text-sm">
            {isFavorite ? "Unfavorite" : "Favorite"}
          </Text>
        </DropdownMenuItem>
        <DropdownMenuSeparator />

        {/* Move to Project */}
        <View className="px-2 py-1.5">
          <Text className="text-xs font-medium text-muted-foreground">
            Move to Project
          </Text>
        </View>
        <DropdownMenuItem
          onPress={(e) => onMoveToProject(conversation.id, null, e)}
        >
          <FolderOpen size={16} className="text-muted-foreground" />
          <Text className="text-sm flex-1">No Project</Text>
          {!currentProject && (
            <View className="h-2 w-2 rounded-full bg-primary" />
          )}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {projects.map((project) => {
          const ProjectIcon = ICON_MAP[project.icon || "FolderOpen"] || FolderOpen;
          return (
            <DropdownMenuItem
              key={project.id}
              onPress={(e) => onMoveToProject(conversation.id, project.id, e)}
            >
              <ProjectIcon
                size={16}
                className="text-muted-foreground"
                style={{ color: project.color }}
              />
              <Text className="text-sm flex-1" numberOfLines={1}>
                {project.name}
              </Text>
              {currentProject?.id === project.id && (
                <View className="h-2 w-2 rounded-full bg-primary" />
              )}
            </DropdownMenuItem>
          );
        })}

        <DropdownMenuSeparator />

        {/* Move to Folder */}
        <View className="px-2 py-1.5">
          <Text className="text-xs font-medium text-muted-foreground">
            Move to Folder
          </Text>
        </View>
        <DropdownMenuItem
          onPress={(e) => onMoveToFolder(conversation.id, null, e)}
        >
          <FolderOpen size={16} className="text-muted-foreground" />
          <Text className="text-sm flex-1">No Folder</Text>
          {!currentFolder && (
            <View className="h-2 w-2 rounded-full bg-primary" />
          )}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {folders.map((folder) => {
          const FolderIcon = ICON_MAP[folder.icon || "FolderOpen"] || FolderOpen;
          return (
            <DropdownMenuItem
              key={folder.id}
              onPress={(e) => onMoveToFolder(conversation.id, folder.id, e)}
            >
              <FolderIcon
                size={16}
                className="text-muted-foreground"
                style={{ color: folder.color }}
              />
              <Text className="text-sm flex-1" numberOfLines={1}>
                {folder.name}
              </Text>
              {currentFolder?.id === folder.id && (
                <View className="h-2 w-2 rounded-full bg-primary" />
              )}
            </DropdownMenuItem>
          );
        })}

        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onPress={(e) => onDelete(conversation.id, e)}
        >
          <Trash2 size={16} className="text-destructive" />
          <Text className="text-sm">Delete Conversation</Text>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

ConversationMenu.displayName = "ConversationMenu";
