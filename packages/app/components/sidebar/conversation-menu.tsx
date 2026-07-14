import React from "react";
import { Pressable, View } from "react-native";
import * as DropdownMenu from "@/components/ui/dropdown-menu";
import { MoreHorizontal, Pin, Star } from "lucide-react-native";
import type { Conversation } from "@/lib/hooks/use-conversations";
import type { Project } from "@/lib/stores/projects-store";
import type { Folder } from "@/lib/stores/folders-store";
import type { StopPropagationEvent } from '@/lib/types/events';

interface ConversationMenuProps {
  conversation: Conversation;
  currentProject?: Project;
  currentFolder?: Folder;
  isFavorite: boolean;
  isPinned: boolean;
  projects: Project[];
  folders: Folder[];
  onToggleFavorite: (id: string, e: StopPropagationEvent) => void;
  onTogglePin: (id: string, e: StopPropagationEvent) => void;
  onMoveToProject: (convId: string, projectId: string | null, e: StopPropagationEvent) => void;
  onMoveToFolder: (convId: string, folderId: string | null, e: StopPropagationEvent) => void;
  onDelete: (id: string, e: StopPropagationEvent) => void;
}

export const ConversationMenu = React.memo<ConversationMenuProps>(({
  conversation,
  currentProject,
  currentFolder,
  isFavorite,
  isPinned,
  projects,
  folders,
  onToggleFavorite,
  onTogglePin,
  onMoveToProject,
  onMoveToFolder,
  onDelete,
}) => {
  const [isOpen, setIsOpen] = React.useState(false);

  return (
    <DropdownMenu.Root onOpenChange={setIsOpen}>
      <DropdownMenu.Trigger>
        <View className="relative h-6 w-6 items-center justify-center mr-1">
          {(isPinned || isFavorite) && !isOpen && (
            <View className="absolute inset-0 items-center justify-center web:group-hover:opacity-0">
              {isPinned ? (
                <Pin size={14} className={isFavorite ? "text-amber-500" : "text-muted-foreground"} />
              ) : (
                <Star size={14} className="text-amber-500" fill="#f59e0b" />
              )}
            </View>
          )}
          <Pressable className={`h-6 w-6 items-center justify-center rounded-lg active:bg-muted/70 ${isOpen ? "opacity-100" : "web:opacity-0 web:group-hover:opacity-100"}`}>
            <MoreHorizontal size={14} className="text-muted-foreground" />
          </Pressable>
        </View>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content>
        <DropdownMenu.Item key="favorite" onSelect={() => onToggleFavorite(conversation.id, {})}>
          <DropdownMenu.ItemIcon ios={{ name: isFavorite ? "star.fill" : "star" }} />
          <DropdownMenu.ItemTitle>
            {isFavorite ? "Unfavorite" : "Favorite"}
          </DropdownMenu.ItemTitle>
        </DropdownMenu.Item>
        <DropdownMenu.Item key="pin" onSelect={() => onTogglePin(conversation.id, {})}>
          <DropdownMenu.ItemIcon ios={{ name: isPinned ? "pin.slash" : "pin" }} />
          <DropdownMenu.ItemTitle>
            {isPinned ? "Unpin" : "Pin"}
          </DropdownMenu.ItemTitle>
        </DropdownMenu.Item>
        <DropdownMenu.Separator />

        {/* Move to Project */}
        <DropdownMenu.Label>Move to Project</DropdownMenu.Label>
        <DropdownMenu.Item
          key="no-project"
          onSelect={() => onMoveToProject(conversation.id, null, {})}
        >
          <DropdownMenu.ItemIcon ios={{ name: !currentProject ? "checkmark" : "folder" }} />
          <DropdownMenu.ItemTitle>No Project</DropdownMenu.ItemTitle>
        </DropdownMenu.Item>
        {projects.map((project) => (
          <DropdownMenu.Item
            key={`project-${project.id}`}
            onSelect={() => onMoveToProject(conversation.id, project.id, {})}
          >
            <DropdownMenu.ItemIcon ios={{ name: currentProject?.id === project.id ? "checkmark" : "folder" }} />
            <DropdownMenu.ItemTitle>{project.name}</DropdownMenu.ItemTitle>
          </DropdownMenu.Item>
        ))}

        <DropdownMenu.Separator />

        {/* Move to Folder */}
        <DropdownMenu.Label>Move to Folder</DropdownMenu.Label>
        <DropdownMenu.Item
          key="no-folder"
          onSelect={() => onMoveToFolder(conversation.id, null, {})}
        >
          <DropdownMenu.ItemIcon ios={{ name: !currentFolder ? "checkmark" : "folder" }} />
          <DropdownMenu.ItemTitle>No Folder</DropdownMenu.ItemTitle>
        </DropdownMenu.Item>
        {folders.map((folder) => (
          <DropdownMenu.Item
            key={`folder-${folder.id}`}
            onSelect={() => onMoveToFolder(conversation.id, folder.id, {})}
          >
            <DropdownMenu.ItemIcon ios={{ name: currentFolder?.id === folder.id ? "checkmark" : "folder" }} />
            <DropdownMenu.ItemTitle>{folder.name}</DropdownMenu.ItemTitle>
          </DropdownMenu.Item>
        ))}

        <DropdownMenu.Separator />
        <DropdownMenu.Item key="delete" destructive onSelect={() => onDelete(conversation.id, {})}>
          <DropdownMenu.ItemIcon ios={{ name: "trash" }} />
          <DropdownMenu.ItemTitle>Delete Conversation</DropdownMenu.ItemTitle>
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
});

ConversationMenu.displayName = "ConversationMenu";
