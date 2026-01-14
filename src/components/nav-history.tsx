"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { useRouter, usePathname } from "next/navigation"
import { useSession } from "next-auth/react"
import { useTranslations } from 'next-intl'
import { toast } from "sonner"
import {
    SidebarGroup,
    SidebarGroupLabel,
    SidebarMenu,
    SidebarMenuItem,
    SidebarMenuButton,
    SidebarMenuAction,
    SidebarMenuSub,
    SidebarMenuSubItem,
    useSidebar,
} from "@/components/ui/sidebar"
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog"
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { HugeiconsIcon } from "@hugeicons/react"
import {
    PlusSignIcon,
    Message01Icon,
    FolderAddIcon,
    FolderOpenIcon,
    FolderIcon,
    ArrowRight01Icon,
    MoreHorizontalIcon,
    PaintBoardIcon,
    Delete02Icon,
    PencilEdit02Icon
} from "@hugeicons/core-free-icons"

import { useChatHistory } from "@/hooks/use-chat-history"
import { useFolders } from "@/hooks/use-folders"
import { useGroupedChats } from "@/hooks/use-filtered-chats"
import { ChatItem } from "@/components/nav-history-item"
import { ChatHistory, ChatFolder, FOLDER_COLORS, FolderColor } from "@/lib/types"

// Color classes for folders
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

export function NavHistory() {
    const router = useRouter()
    const pathname = usePathname()
    const { data: session } = useSession()
    const userId = (session?.user as any)?.id // Adjust based on your auth user type

    // Hooks
    const { chats, loading: chatsLoading, updateChat, deleteChat, reload: reloadChats } = useChatHistory()
    const { folders, loading: foldersLoading, createFolder, updateFolder, deleteFolder, refreshFolders } = useFolders(userId)
    const chatsByFolder = useGroupedChats(chats)
    const { isMobile } = useSidebar()
    const t = useTranslations('sidebar')

    // Dialog States
    const [renameChatDialog, setRenameChatDialog] = React.useState(false)
    const [folderDialog, setFolderDialog] = React.useState(false)
    const [folderColorDialog, setFolderColorDialog] = React.useState(false)
    const [renameFolderDialog, setRenameFolderDialog] = React.useState(false)

    const [selectedChat, setSelectedChat] = React.useState<ChatHistory | null>(null)
    const [selectedFolder, setSelectedFolder] = React.useState<ChatFolder | null>(null)

    const [newTitle, setNewTitle] = React.useState("")
    const [newFolderName, setNewFolderName] = React.useState("")
    const [newFolderColor, setNewFolderColor] = React.useState<FolderColor>("gray")

    // --- Actions ---

    const handleLoadChat = React.useCallback((id: string) => {
        router.push(`/c/${id}`) // Using /c/[id] based on original nav-history
    }, [router])

    const handleNewChat = React.useCallback(() => {
        router.push('/') // Or /ai depending on routes. Original nav-history went to /.
        // Maybe trigger a clear event?
        window.dispatchEvent(new CustomEvent("new-chat"))
    }, [router])

    // Chat Actions
    const onRenameChat = (chat: ChatHistory) => {
        setSelectedChat(chat)
        setNewTitle(chat.title)
        setRenameChatDialog(true)
    }

    const performRenameChat = async () => {
        if (!selectedChat || !newTitle.trim()) return
        await updateChat(selectedChat.id, { title: newTitle.trim() })
        setRenameChatDialog(false)
        toast.success("Chat renamed")
    }

    const onIconColorChat = async (chat: ChatHistory) => {
        // Just cycle or random for now, or open dialog. 
        // Let's implement a simple cycle for simplicity or implement full dialog later.
        // For now, let's just show toast "Not implemented" or simple logic.
        // Actually, let's just allow clearing or setting a default color.
        // If we want a dialog we need another state.
        // Gaila had a dropdown submenu. NavHistoryItem has a submenu for this? 
        // No, current NavHistoryItem implementation calls onIconColor.
        // I'll make it random for demo or add a quick color picker dialog.
        // Let's just update to 'blue' as a test or implement a small dialog.
        // Reuse folder color dialog?
        // Let's toggle favorite as a placeholder for "Icon Color" logic 
        // or just ignore for now as it wasn't in original requirements explicitly but Gaila had it.
        // I'll skip complex icon color for chats for this moment to fetch the main goal "folders".
    }

    const onFavoriteChat = async (chat: ChatHistory) => {
        await updateChat(chat.id, { isFavorite: !chat.isFavorite })
        toast.success(chat.isFavorite ? "Removed from favorites" : "Added to favorites")
    }

    const onShareChat = (chat: ChatHistory) => {
        const url = `${window.location.origin}/share/${chat.id}`
        navigator.clipboard.writeText(url)
        toast.success("Link copied to clipboard")
    }

    const onDeleteChat = async (id: string) => {
        if (!confirm("Are you sure?")) return
        await deleteChat(id)
        if (pathname === `/c/${id}`) {
            router.push('/')
        }
        toast.success("Chat deleted")
    }

    const onOpenInNewTab = (id: string) => {
        window.open(`/c/${id}`, '_blank')
    }

    // Folder Actions
    const onMoveToFolder = async (chatId: string, folderId: string | null) => {
        await updateChat(chatId, { folderId }) // Ensure types match (string | null)
        toast.success(folderId ? "Moved to folder" : "Removed from folder")
    }

    const onNewFolder = (chat?: ChatHistory) => {
        if (chat) setSelectedChat(chat)
        setNewFolderName("")
        setNewFolderColor("gray")
        setFolderDialog(true)
    }

    const performCreateFolder = async () => {
        if (!newFolderName.trim()) return
        try {
            const folder = await createFolder(newFolderName.trim(), newFolderColor)
            if (selectedChat) {
                await updateChat(selectedChat.id, { folderId: folder.id })
            }
            setFolderDialog(false)
            setSelectedChat(null)
            toast.success("Folder created")
            refreshFolders()
        } catch (e) {
            toast.error("Failed to create folder")
        }
    }

    const onRenameFolder = (folder: ChatFolder) => {
        setSelectedFolder(folder)
        setNewFolderName(folder.name)
        setRenameFolderDialog(true)
    }

    const performRenameFolder = async () => {
        if (!selectedFolder || !newFolderName.trim()) return
        try {
            await updateFolder(selectedFolder.id, { name: newFolderName.trim() })
            setRenameFolderDialog(false)
            setSelectedFolder(null)
            toast.success("Folder renamed")
        } catch (e) {
            toast.error("Failed to rename folder")
        }
    }

    const handleChangeFolderColor = (folder: ChatFolder) => {
        setSelectedFolder(folder)
        setNewFolderColor(folder.color)
        setFolderColorDialog(true)
    }

    const performChangeFolderColor = async (color: string) => {
        if (!selectedFolder) return
        try {
            await updateFolder(selectedFolder.id, { color: color as any })
            setFolderColorDialog(false)
            setSelectedFolder(null)
            toast.success("Folder color updated")
        } catch (e) {
            toast.error("Failed to update color")
        }
    }

    const onDeleteFolder = async (folder: ChatFolder) => {
        if (!confirm(`Delete folder "${folder.name}"? Chats inside will be moved to root.`)) return
        await deleteFolder(folder.id)
        // Optimistically chats should be updated or backend should handle this cleanup (we did it in DELETE endpoint)
        // But local state needs refresh. 
        // Chats with this folderId needs to be updated.
        // The backend unsets folderId. Clientside cache needs invalidate.
        reloadChats()
        toast.success("Folder deleted")
    }

    const toggleFolderOpen = async (folder: ChatFolder, isOpen: boolean) => {
        // We only persist this locally in valid session if we had a field for it in DB.
        // For now, let's just rely on local state or implement isOpen in folders hooks?
        // useFolders doesn't have local UI state for open/close separately from data.
        // But `Collapsible` creates its own state if we don't control it. Only `defaultOpen`.
        // If we want to persist, we need to store it. Gaila had `updateFolderOpen`.
        // Let's assume we don't persist open state to DB for now to keep simple, 
        // or just rely on Collapsible's uncontrolled state if possible. 
        // Or we can use `open` prop if we track it.
        // To keep it simple, I'll let Collapsible manage state or add a local state map.
        // Controlled approach:
        // We can't easily modify the folder object in hook without DB update if we want persistence.
        // I will use Uncontrolled Collapsible (letting user open/close freely during session).
        // But wait, `chatsByFolder` re-renders might reset it?
        // No, `Collapsible` state is preserved if key is stable. Folder ID is stable.
    }

    if (!session) {
        // Fallback for non-authenticated simplified/local view logic could be added here
        // For now, it will work with local storage hooks.
    }

    return (
        <>
            <SidebarGroup className="group-data-[collapsible=icon]:hidden">
                <SidebarGroupLabel>Chats</SidebarGroupLabel>
                <SidebarMenu>
                    <SidebarMenuItem>
                        <SidebarMenuButton onClick={handleNewChat} className="text-muted-foreground/70">
                            <HugeiconsIcon icon={PlusSignIcon} className="h-4 w-4" />
                            <span>New Conversation</span>
                        </SidebarMenuButton>
                    </SidebarMenuItem>

                    {chatsLoading || foldersLoading ? (
                        <SidebarMenuItem>
                            <SidebarMenuButton disabled>
                                <span className="text-xs">Loading...</span>
                            </SidebarMenuButton>
                        </SidebarMenuItem>
                    ) : (
                        <>
                            {/* Folders */}
                            {folders.map(folder => {
                                const folderChats = chatsByFolder[folder.id] || [];
                                const colorClass = FOLDER_COLOR_CLASSES[folder.color] || FOLDER_COLOR_CLASSES.gray;

                                return (
                                    <Collapsible key={folder.id} className="group/collapsible">
                                        <SidebarMenuItem>
                                            <CollapsibleTrigger asChild>
                                                <SidebarMenuButton className="text-sidebar-foreground/80">
                                                    <HugeiconsIcon icon={FolderOpenIcon} className={cn("hidden group-data-[state=open]/collapsible:block", colorClass.icon)} />
                                                    <HugeiconsIcon icon={FolderIcon} className={cn("group-data-[state=open]/collapsible:hidden", colorClass.icon)} />
                                                    <span>{folder.name}</span>
                                                    {folderChats.length > 0 && <span className="ml-1 text-xs text-muted-foreground">({folderChats.length})</span>}
                                                    <HugeiconsIcon icon={ArrowRight01Icon} className="ml-auto h-4 w-4 transition-transform group-data-[state=open]/collapsible:rotate-90" />
                                                </SidebarMenuButton>
                                            </CollapsibleTrigger>
                                            <DropdownMenu>
                                                <DropdownMenuTrigger asChild>
                                                    <SidebarMenuAction showOnHover>
                                                        <HugeiconsIcon icon={MoreHorizontalIcon} className="h-4 w-4" />
                                                    </SidebarMenuAction>
                                                </DropdownMenuTrigger>
                                                <DropdownMenuContent side={isMobile ? "bottom" : "right"} align="start">
                                                    <DropdownMenuItem onClick={() => onRenameFolder(folder)}>
                                                        <HugeiconsIcon icon={PencilEdit02Icon} className="mr-2 h-4 w-4 text-muted-foreground" />
                                                        <span>Rename</span>
                                                    </DropdownMenuItem>
                                                    <DropdownMenuItem onClick={() => handleChangeFolderColor(folder)}>
                                                        <HugeiconsIcon icon={PaintBoardIcon} className="mr-2 h-4 w-4 text-muted-foreground" />
                                                        <span>Color</span>
                                                    </DropdownMenuItem>
                                                    <DropdownMenuSeparator />
                                                    <DropdownMenuItem onClick={() => onDeleteFolder(folder)} className="text-destructive">
                                                        <HugeiconsIcon icon={Delete02Icon} className="mr-2 h-4 w-4" />
                                                        <span>Delete</span>
                                                    </DropdownMenuItem>
                                                </DropdownMenuContent>
                                            </DropdownMenu>

                                            <CollapsibleContent>
                                                <SidebarMenuSub>
                                                    {folderChats.length === 0 ? (
                                                        <SidebarMenuSubItem>
                                                            <span className="text-muted-foreground/50 text-xs px-2 py-1.5">Empty folder</span>
                                                        </SidebarMenuSubItem>
                                                    ) : (
                                                        folderChats.map(chat => (
                                                            <ChatItem
                                                                key={chat.id}
                                                                chat={chat}
                                                                isActive={pathname === `/c/${chat.id}`}
                                                                onLoad={handleLoadChat}
                                                                onRename={onRenameChat}
                                                                onIconColor={onIconColorChat}
                                                                onMoveToFolder={onMoveToFolder}
                                                                onNewFolder={onNewFolder}
                                                                onFavorite={onFavoriteChat}
                                                                onShare={onShareChat}
                                                                onDelete={onDeleteChat}
                                                                onOpenInNewTab={onOpenInNewTab}
                                                                isMobile={isMobile}
                                                                isInFolder
                                                                chatFolders={folders}
                                                            />
                                                        ))
                                                    )}
                                                </SidebarMenuSub>
                                            </CollapsibleContent>
                                        </SidebarMenuItem>
                                    </Collapsible>
                                )
                            })}

                            {/* Root Chats */}
                            {chatsByFolder[""]?.map(chat => (
                                <ChatItem
                                    key={chat.id}
                                    chat={chat}
                                    isActive={pathname === `/c/${chat.id}`}
                                    onLoad={handleLoadChat}
                                    onRename={onRenameChat}
                                    onIconColor={onIconColorChat}
                                    onMoveToFolder={onMoveToFolder}
                                    onNewFolder={onNewFolder}
                                    onFavorite={onFavoriteChat}
                                    onShare={onShareChat}
                                    onDelete={onDeleteChat}
                                    onOpenInNewTab={onOpenInNewTab}
                                    isMobile={isMobile}
                                    chatFolders={folders}
                                />
                            ))}
                        </>
                    )}
                </SidebarMenu>
            </SidebarGroup>

            {/* Rename Chat Dialog */}
            <Dialog open={renameChatDialog} onOpenChange={setRenameChatDialog}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Rename Chat</DialogTitle>
                    </DialogHeader>
                    <div className="py-4 space-y-4">
                        <Input
                            value={newTitle}
                            onChange={e => setNewTitle(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && performRenameChat()}
                        />
                        <div className="flex justify-end gap-2">
                            <Button variant="outline" onClick={() => setRenameChatDialog(false)}>Cancel</Button>
                            <Button onClick={performRenameChat}>Save</Button>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>

            {/* Create Folder Dialog */}
            <Dialog open={folderDialog} onOpenChange={setFolderDialog}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>New Folder</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                        <div className="space-y-2">
                            <Label>Name</Label>
                            <Input
                                value={newFolderName}
                                onChange={e => setNewFolderName(e.target.value)}
                                placeholder="Folder Name"
                                onKeyDown={e => e.key === 'Enter' && performCreateFolder()}
                            />
                        </div>
                        <div className="space-y-2">
                            <Label>Color</Label>
                            <div className="flex flex-wrap gap-2">
                                {FOLDER_COLORS.map(({ value, label }) => {
                                    const colorClass = FOLDER_COLOR_CLASSES[value];
                                    return (
                                        <Button
                                            key={value}
                                            variant={newFolderColor === value ? "default" : "outline"}
                                            size="sm"
                                            className="gap-2 h-8"
                                            onClick={() => setNewFolderColor(value)}
                                        >
                                            <HugeiconsIcon icon={FolderIcon} className={cn("h-4 w-4", colorClass.icon)} />
                                            {/* <span className="sr-only">{label}</span> */}
                                        </Button>
                                    );
                                })}
                            </div>
                        </div>
                        <div className="flex justify-end gap-2">
                            <Button variant="outline" onClick={() => setFolderDialog(false)}>Cancel</Button>
                            <Button onClick={performCreateFolder}>Create</Button>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>

            {/* Rename Folder Dialog */}
            <Dialog open={renameFolderDialog} onOpenChange={setRenameFolderDialog}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Rename Folder</DialogTitle>
                    </DialogHeader>
                    <div className="py-4 space-y-4">
                        <Input
                            value={newFolderName}
                            onChange={e => setNewFolderName(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && performRenameFolder()}
                        />
                        <div className="flex justify-end gap-2">
                            <Button variant="outline" onClick={() => setRenameFolderDialog(false)}>Cancel</Button>
                            <Button onClick={performRenameFolder}>Save</Button>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>

            {/* Folder Color Dialog */}
            <Dialog open={folderColorDialog} onOpenChange={setFolderColorDialog}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Folder Color</DialogTitle>
                    </DialogHeader>
                    <div className="py-4 space-y-4">
                        <div className="flex flex-wrap gap-2">
                            {FOLDER_COLORS.map(({ value, label }) => {
                                const colorClass = FOLDER_COLOR_CLASSES[value];
                                return (
                                    <Button
                                        key={value}
                                        variant="outline"
                                        size="sm"
                                        className="gap-2 h-8"
                                        onClick={() => performChangeFolderColor(value)}
                                    >
                                        <HugeiconsIcon icon={FolderIcon} className={cn("h-4 w-4", colorClass.icon)} />
                                        <span>{label}</span>
                                    </Button>
                                );
                            })}
                        </div>
                    </div>
                </DialogContent>
            </Dialog>
        </>
    )
}
