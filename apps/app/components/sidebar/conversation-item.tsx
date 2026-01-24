import React from "react";
import { View, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { MessageSquare, Star as StarIcon } from "lucide-react-native";
import { cn } from "@/lib/utils";
import type { Conversation } from "@/lib/hooks/use-conversations";
import type { Project } from "@/lib/stores/projects-store";
import type { Folder } from "@/lib/stores/folders-store";
import { ConversationMenu } from "./conversation-menu";

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  isFavorite: boolean;
  currentProject?: Project;
  currentFolder?: Folder;
  projects: Project[];
  folders: Folder[];
  onSelect: (id: string) => void;
  onToggleFavorite: (id: string, e: any) => void;
  onMoveToProject: (convId: string, projectId: string | null, e: any) => void;
  onMoveToFolder: (convId: string, folderId: string | null, e: any) => void;
  onDelete: (id: string, e: any) => void;
  compact?: boolean;
  indented?: boolean;
}

export const ConversationItem = React.memo<ConversationItemProps>(({
  conversation,
  isActive,
  isFavorite,
  currentProject,
  currentFolder,
  projects,
  folders,
  onSelect,
  onToggleFavorite,
  onMoveToProject,
  onMoveToFolder,
  onDelete,
  compact = false,
  indented = false,
}) => {
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
        className={cn(
          "flex-1 flex-row items-center gap-2",
          compact ? "py-1.5 pl-2.5 pr-1" : "py-2.5 md:py-2 pl-3 md:pl-2.5 pr-1",
          !isActive && "active:bg-muted/50 rounded-full"
        )}
      >
        <MessageSquare
          size={compact ? 13 : 16}
          className={cn(
            "text-muted-foreground",
            isActive && "text-primary"
          )}
        />
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
        {isFavorite && (
          <StarIcon size={10} className="text-amber-500" fill="#f59e0b" />
        )}
      </Pressable>
      <ConversationMenu
        conversation={conversation}
        currentProject={currentProject}
        currentFolder={currentFolder}
        isFavorite={isFavorite}
        projects={projects}
        folders={folders}
        onToggleFavorite={onToggleFavorite}
        onMoveToProject={onMoveToProject}
        onMoveToFolder={onMoveToFolder}
        onDelete={onDelete}
      />
    </View>
  );
});

ConversationItem.displayName = "ConversationItem";
