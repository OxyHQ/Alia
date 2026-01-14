"use client"

import { useEffect, useState } from "react"
import { MessageSquare, MoreHorizontal, Trash2 } from "lucide-react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"

import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
    SidebarGroup,
    SidebarGroupLabel,
    SidebarMenu,
    SidebarMenuAction,
    SidebarMenuButton,
    SidebarMenuItem,
} from "@/components/ui/sidebar"

interface Conversation {
    _id: string
    title: string
    updatedAt: string
}

export function NavHistory() {
    const [conversations, setConversations] = useState<Conversation[]>([])
    const pathname = usePathname()
    const router = useRouter()

    const fetchConversations = async () => {
        try {
            const res = await fetch('/api/conversations')
            if (res.ok) {
                const data = await res.json()
                setConversations(data)
            }
        } catch (e) {
            console.error("Error fetching history", e)
        }
    }

    useEffect(() => {
        fetchConversations()

        // Escuchar eventos para recargar historial
        const handleUpdate = () => fetchConversations()
        window.addEventListener('chat-updated', handleUpdate)
        return () => window.removeEventListener('chat-updated', handleUpdate)
    }, [])

    const handleDelete = async (id: string, e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation(); // Evitar click en enlace

        if (!confirm('Eliminar conversación?')) return

        try {
            await fetch(`/api/conversations/${id}`, { method: 'DELETE' })
            fetchConversations()
            if (pathname === `/c/${id}`) {
                router.push('/')
            }
        } catch (e) {
            console.error(e)
        }
    }

    return (
        <SidebarGroup className="group-data-[collapsible=icon]:hidden">
            <SidebarGroupLabel>Recent History</SidebarGroupLabel>
            <SidebarMenu>
                {conversations.map((item) => (
                    <SidebarMenuItem key={item._id}>
                        <SidebarMenuButton asChild isActive={pathname === `/c/${item._id}`}>
                            <Link href={`/c/${item._id}`}>
                                <MessageSquare className="w-4 h-4 text-muted-foreground" />
                                <span className="truncate">{item.title}</span>
                            </Link>
                        </SidebarMenuButton>
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <SidebarMenuAction showOnHover>
                                    <MoreHorizontal />
                                    <span className="sr-only">More</span>
                                </SidebarMenuAction>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent
                                className="w-48 rounded-lg"
                                align="start"
                                side="bottom"
                            >
                                <DropdownMenuItem onClick={(e) => handleDelete(item._id, e as any)} className="text-red-500 focus:text-red-500">
                                    <Trash2 className="text-red-500 mr-2 h-4 w-4" />
                                    <span>Delete</span>
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </SidebarMenuItem>
                ))}
            </SidebarMenu>
        </SidebarGroup>
    )
}
