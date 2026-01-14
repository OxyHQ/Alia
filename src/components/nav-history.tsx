"use client"

import { useEffect, useState } from "react"
import { useSession } from "next-auth/react"
import { MessageSquare, MoreHorizontal, Trash2 } from "lucide-react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { useTranslations } from 'next-intl'

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
    const { data: session, status: authStatus } = useSession()
    const isAuthenticated = authStatus === 'authenticated'
    const pathname = usePathname()
    const router = useRouter()
    const t = useTranslations('sidebar')
    const tCommon = useTranslations('common')

    const fetchConversations = async () => {
        if (!isAuthenticated) {
            const localConvs = JSON.parse(localStorage.getItem('alia-conversations') || '[]')
            setConversations(localConvs)
            return
        }

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

        const handleUpdate = () => fetchConversations()
        window.addEventListener('chat-updated', handleUpdate)
        return () => window.removeEventListener('chat-updated', handleUpdate)
    }, [])

    const handleDelete = async (id: string, e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();

        if (!confirm(t('deleteConfirmation'))) return

        if (!isAuthenticated) {
            const localConvs = JSON.parse(localStorage.getItem('alia-conversations') || '[]')
            const filtered = localConvs.filter((c: any) => c._id !== id)
            localStorage.setItem('alia-conversations', JSON.stringify(filtered))
            fetchConversations()
            if (pathname === `/c/${id}`) {
                router.push('/')
            }
            return
        }

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
            <SidebarGroupLabel>{t('recentHistory')}</SidebarGroupLabel>
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
                                    <span className="sr-only">{tCommon('more')}</span>
                                </SidebarMenuAction>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent
                                className="w-48 rounded-lg"
                                align="start"
                                side="bottom"
                            >
                                <DropdownMenuItem onClick={(e) => handleDelete(item._id, e as any)} className="text-red-500 focus:text-red-500">
                                    <Trash2 className="text-red-500 mr-2 h-4 w-4" />
                                    <span>{tCommon('delete')}</span>
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </SidebarMenuItem>
                ))}
            </SidebarMenu>
        </SidebarGroup>
    )
}
