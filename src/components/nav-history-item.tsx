import * as React from "react"
import { useTranslations } from 'next-intl'
import {
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarMenuAction,
    SidebarMenuSubButton,
    SidebarMenuSubItem
} from "@/components/ui/sidebar"
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    DropdownMenuSub,
    DropdownMenuSubTrigger,
    DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu"
import { ChatHistory, ChatFolder, FOLDER_COLORS } from "@/lib/types"
import { HugeiconsIcon } from "@hugeicons/react"
import {
    Message01Icon,
    StarIcon,
    MoreHorizontalIcon,
    PencilEdit02Icon,
    PaintBoardIcon,
    FolderAddIcon,
    FolderIcon,
    Share08Icon,
    ArrowUpRight01Icon,
    Delete02Icon,
    StarOffIcon
} from "@hugeicons/core-free-icons"
import { cn } from "@/lib/utils"

// Color classes for folders (updated for Tailwind)
const FOLDER_COLOR_CLASSES: Record<string, { icon: string; bg: string }> = {
    gray: { icon: "text-gray-500", bg: "bg-gray-500/10" },
    red: { icon: "text-red-500", bg: "bg-red-500/10" },
    orange: { icon: "text-orange-500", bg: "bg-orange-500/10" },
    yellow: { icon: "text-yellow-500", bg: "bg-yellow-500/10" },
    green: { icon: "text-green-500", bg: "bg-green-500/10" },
    blue: { icon: "text-blue-500", bg: "bg-blue-500/10" },
    purple: { icon: "text-purple-500", bg: "bg-purple-500/10" },
    pink: { icon: "text-pink-500", bg: "bg-pink-500/10" },
};

interface ChatItemProps {
    chat: ChatHistory;
    isActive: boolean;
    onLoad: (id: string) => void;
    onRename: (chat: ChatHistory) => void;
    onIconColor: (chat: ChatHistory) => void;
    onMoveToFolder: (chatId: string, folderId: string | null) => void;
    onNewFolder: (chat: ChatHistory) => void;
    onFavorite: (chat: ChatHistory) => void;
    onShare: (chat: ChatHistory) => void;
    onDelete: (id: string) => void;
    onOpenInNewTab: (id: string) => void;
    isMobile: boolean;
    isInFolder?: boolean;
    chatFolders: ChatFolder[];
}

export const ChatItem: React.FC<ChatItemProps> = React.memo(({
    chat,
    isActive,
    onLoad,
    onRename,
    onIconColor,
    onMoveToFolder,
    onNewFolder,
    onFavorite,
    onShare,
    onDelete,
    onOpenInNewTab,
    isMobile,
    isInFolder = false,
    chatFolders,
}) => {
    const t = useTranslations('sidebar');
    const tCommon = useTranslations('common');

    const ButtonComponent = isInFolder ? SidebarMenuSubButton : SidebarMenuButton;
    const ItemComponent = isInFolder ? SidebarMenuSubItem : SidebarMenuItem;
    const iconColorClass = chat.iconColor ? FOLDER_COLOR_CLASSES[chat.iconColor]?.icon : "";

    return (
        <ItemComponent>
            <ButtonComponent
                isActive={isActive}
                onClick={() => onLoad(chat.id)}
                className="group/chat-button"
            >
                {chat.isFavorite ? (
                    <HugeiconsIcon icon={StarIcon} className={cn(isInFolder ? "h-3 w-3" : "h-4 w-4", "text-yellow-500 fill-yellow-500")} />
                ) : (
                    <HugeiconsIcon icon={Message01Icon} className={cn(isInFolder ? "h-3 w-3" : "h-4 w-4", iconColorClass)} />
                )}
                <span className="truncate">{chat.title}</span>
            </ButtonComponent>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <SidebarMenuAction showOnHover className="mr-0.5">
                        <HugeiconsIcon icon={MoreHorizontalIcon} className={isInFolder ? "h-3 w-3" : "h-4 w-4"} />
                    </SidebarMenuAction>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                    className="w-56 rounded-lg"
                    side={isMobile ? "bottom" : "right"}
                    align={isMobile ? "end" : "start"}
                >
                    <DropdownMenuItem onClick={() => onRename(chat)}>
                        <HugeiconsIcon icon={PencilEdit02Icon} className="text-muted-foreground mr-2 h-4 w-4" />
                        <span>Rename</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onIconColor(chat)}>
                        {/* Simplified for now, just trigger dialog or sub-menu */}
                        <HugeiconsIcon icon={PaintBoardIcon} className="text-muted-foreground mr-2 h-4 w-4" />
                        <span>Icon Color</span>
                    </DropdownMenuItem>

                    <DropdownMenuItem onClick={() => onFavorite(chat)}>
                        {chat.isFavorite ? (
                            <>
                                <HugeiconsIcon icon={StarOffIcon} className="text-muted-foreground mr-2 h-4 w-4" />
                                <span>Remove from favorites</span>
                            </>
                        ) : (
                            <>
                                <HugeiconsIcon icon={StarIcon} className="text-muted-foreground mr-2 h-4 w-4" />
                                <span>Add to favorites</span>
                            </>
                        )}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuSub>
                        <DropdownMenuSubTrigger>
                            <HugeiconsIcon icon={FolderAddIcon} className="text-muted-foreground mr-2 h-4 w-4" />
                            <span>Move to folder</span>
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent className="w-48">
                            <DropdownMenuItem onClick={() => onNewFolder(chat)}>
                                <HugeiconsIcon icon={FolderAddIcon} className="text-muted-foreground mr-2 h-4 w-4" />
                                <span>New folder...</span>
                            </DropdownMenuItem>
                            {chatFolders.length > 0 && <DropdownMenuSeparator />}
                            {chatFolders.map((folder) => {
                                const colorClass = FOLDER_COLOR_CLASSES[folder.color] || FOLDER_COLOR_CLASSES.gray;
                                return (
                                    <DropdownMenuItem
                                        key={folder.id}
                                        onClick={() => onMoveToFolder(chat.id, folder.id)}
                                        disabled={chat.folderId === folder.id}
                                    >
                                        <HugeiconsIcon icon={FolderIcon} className={cn("mr-2 h-4 w-4", colorClass.icon)} />
                                        <span>{folder.name}</span>
                                    </DropdownMenuItem>
                                );
                            })}
                            {chat.folderId && (
                                <>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem onClick={() => onMoveToFolder(chat.id, null)}>
                                        <HugeiconsIcon icon={FolderIcon} className="text-muted-foreground mr-2 h-4 w-4" />
                                        <span>Remove from folder</span>
                                    </DropdownMenuItem>
                                </>
                            )}
                        </DropdownMenuSubContent>
                    </DropdownMenuSub>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => onShare(chat)}>
                        <HugeiconsIcon icon={Share08Icon} className="text-muted-foreground mr-2 h-4 w-4" />
                        <span>Share</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onOpenInNewTab(chat.id)}>
                        <HugeiconsIcon icon={ArrowUpRight01Icon} className="text-muted-foreground mr-2 h-4 w-4" />
                        <span>Open in new tab</span>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                        onClick={() => onDelete(chat.id)}
                        className="text-destructive focus:text-destructive"
                    >
                        <HugeiconsIcon icon={Delete02Icon} className="text-destructive mr-2 h-4 w-4" />
                        <span>Delete</span>
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </ItemComponent>
    );
});

ChatItem.displayName = "ChatItem";
