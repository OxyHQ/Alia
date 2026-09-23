import React from "react";
import { Pressable, View } from "react-native";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@oxy.so/bloom/dropdown-menu";
import {
  Check,
  Folder as FolderIcon,
  Pin,
  Star,
  Trash2,
} from "lucide-react-native";
import { DotsHorizontalIcon } from "@/components/ui/icons/dots-horizontal-icon";
import { useColorScheme } from "@/lib/useColorScheme";
import type { Conversation } from "@/lib/hooks/use-conversations";
import type { Project } from "@/lib/stores/projects-store";
import type { Folder } from "@/lib/stores/folders-store";
import type { StopPropagationEvent } from "@/lib/types/events";
import { useTranslation } from "@/lib/hooks/use-translation";

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
  onMoveToProject: (
    convId: string,
    projectId: string | null,
    e: StopPropagationEvent,
  ) => void;
  onMoveToFolder: (
    convId: string,
    folderId: string | null,
    e: StopPropagationEvent,
  ) => void;
  onDelete: (id: string, e: StopPropagationEvent) => void;
}

export const ConversationMenu = React.memo<ConversationMenuProps>(
  ({
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
    const { colors } = useColorScheme();
    const { t } = useTranslation();

    return (
      <DropdownMenu onOpenChange={setIsOpen}>
        <View className="relative flex-row items-center justify-center mr-1">
          {(isPinned || isFavorite) && !isOpen && (
            <View className="items-center justify-center ">
              {isPinned ? (
                <Pin
                  size={14}
                  color={isFavorite ? colors.primary : colors.mutedForeground}
                />
              ) : (
                <Star size={14} color={colors.primary} fill={colors.primary} />
              )}
            </View>
          )}
          {/* Hidden until hover on web, but never hidden from a keyboard: it is
              a real button, so `focus-visible` reveals it the moment Tab lands
              on it, and the name says what it opens. */}
          <DropdownMenuTrigger asChild>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("chat.conversationOptions")}
              aria-expanded={isOpen}
              className={`h-6 w-6 items-center justify-center rounded-lg active:bg-muted/70 `}
            >
              <DotsHorizontalIcon size={14} color={colors.mutedForeground} />
            </Pressable>
          </DropdownMenuTrigger>
        </View>
        <DropdownMenuContent>
          <DropdownMenuItem
            key="favorite"
            leading={<Star size={16} color={colors.mutedForeground} />}
            onPress={() => onToggleFavorite(conversation.id, {})}
          >
            {isFavorite ? "Unfavorite" : "Favorite"}
          </DropdownMenuItem>
          <DropdownMenuItem
            key="pin"
            leading={<Pin size={16} color={colors.mutedForeground} />}
            onPress={() => onTogglePin(conversation.id, {})}
          >
            {isPinned ? "Unpin" : "Pin"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />

          {/* Move to Project */}
          <DropdownMenuLabel>Move to Project</DropdownMenuLabel>
          <DropdownMenuItem
            key="no-project"
            leading={
              currentProject ? (
                <FolderIcon size={16} color={colors.mutedForeground} />
              ) : (
                <Check size={16} color={colors.mutedForeground} />
              )
            }
            onPress={() => onMoveToProject(conversation.id, null, {})}
          >
            No Project
          </DropdownMenuItem>
          {projects.map((project) => (
            <DropdownMenuItem
              key={`project-${project.id}`}
              leading={
                currentProject?.id === project.id ? (
                  <Check size={16} color={colors.mutedForeground} />
                ) : (
                  <FolderIcon size={16} color={colors.mutedForeground} />
                )
              }
              onPress={() => onMoveToProject(conversation.id, project.id, {})}
            >
              {project.name}
            </DropdownMenuItem>
          ))}

          <DropdownMenuSeparator />

          {/* Move to Folder */}
          <DropdownMenuLabel>Move to Folder</DropdownMenuLabel>
          <DropdownMenuItem
            key="no-folder"
            leading={
              currentFolder ? (
                <FolderIcon size={16} color={colors.mutedForeground} />
              ) : (
                <Check size={16} color={colors.mutedForeground} />
              )
            }
            onPress={() => onMoveToFolder(conversation.id, null, {})}
          >
            No Folder
          </DropdownMenuItem>
          {folders.map((folder) => (
            <DropdownMenuItem
              key={`folder-${folder.id}`}
              leading={
                currentFolder?.id === folder.id ? (
                  <Check size={16} color={colors.mutedForeground} />
                ) : (
                  <FolderIcon size={16} color={colors.mutedForeground} />
                )
              }
              onPress={() => onMoveToFolder(conversation.id, folder.id, {})}
            >
              {folder.name}
            </DropdownMenuItem>
          ))}

          <DropdownMenuSeparator />
          <DropdownMenuItem
            key="delete"
            leading={<Trash2 size={16} color={colors.error} />}
            tone="danger"
            onPress={() => onDelete(conversation.id, {})}
          >
            Delete Conversation
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  },
);

ConversationMenu.displayName = "ConversationMenu";
