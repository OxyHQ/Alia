"use client"

import * as React from "react"
import {
    Calculator,
    Calendar,
    CreditCard,
    Plus,
    Settings,
    Smile,
    User,
    Search,
    MessageSquare,
    Zap,
    History
} from "lucide-react"
import { useRouter } from "next/navigation"
import { useTranslations } from 'next-intl'

import {
    CommandDialog,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
    CommandSeparator,
    CommandShortcut,
} from "@/components/ui/command"

interface Conversation {
    _id: string
    title: string
}

export function CommandMenu() {
    const [open, setOpen] = React.useState(false)
    const [conversations, setConversations] = React.useState<Conversation[]>([])
    const router = useRouter()
    const t = useTranslations('commandMenu')

    React.useEffect(() => {
        const down = (e: KeyboardEvent) => {
            if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                setOpen((open) => !open)
            }
        }

        const handleOpen = () => setOpen(true)

        document.addEventListener("keydown", down)
        window.addEventListener('open-command-menu', handleOpen)
        return () => {
            document.removeEventListener("keydown", down)
            window.removeEventListener('open-command-menu', handleOpen)
        }
    }, [])

    React.useEffect(() => {
        if (open) {
            const fetchConversations = async () => {
                try {
                    const res = await fetch('/api/conversations')
                    if (res.ok) {
                        const data = await res.json()
                        setConversations(data.slice(0, 10)) // Solo las últimas 10
                    }
                } catch (e) {
                    console.error("Error fetching history for command menu", e)
                }
            }
            fetchConversations()
        }
    }, [open])

    const runCommand = React.useCallback((command: () => void) => {
        setOpen(false)
        command()
    }, [])

    return (
        <CommandDialog open={open} onOpenChange={setOpen}>
            <CommandInput placeholder={t('placeholder')} />
            <CommandList className="max-h-[min(450px,80vh)]">
                <CommandEmpty>{t('noResults')}</CommandEmpty>
                <CommandGroup heading={t('suggestions')}>
                    <CommandItem
                        onSelect={() => runCommand(() => router.push("/"))}
                    >
                        <Plus className="mr-2 h-4 w-4" />
                        <span>{t('newConversation')}</span>
                        <CommandShortcut>⌘N</CommandShortcut>
                    </CommandItem>
                    <CommandItem
                        onSelect={() => runCommand(() => router.push("/settings"))}
                    >
                        <Settings className="mr-2 h-4 w-4" />
                        <span>{t('settings')}</span>
                        <CommandShortcut>⌘S</CommandShortcut>
                    </CommandItem>
                </CommandGroup>
                <CommandSeparator />
                {conversations.length > 0 && (
                    <CommandGroup heading={t('recentConversations')}>
                        {conversations.map((conv) => (
                            <CommandItem
                                key={conv._id}
                                onSelect={() => runCommand(() => router.push(`/c/${conv._id}`))}
                            >
                                <MessageSquare className="mr-2 h-4 w-4 text-muted-foreground" />
                                <span className="truncate">{conv.title}</span>
                            </CommandItem>
                        ))}
                    </CommandGroup>
                )}
                <CommandSeparator />
                <CommandGroup heading={t('actions')}>
                    <CommandItem onSelect={() => runCommand(() => {
                        localStorage.setItem('alia-temporary-chat', 'true')
                        window.dispatchEvent(new Event('alia-temporary-chat-changed'))
                        router.push('/')
                    })}>
                        <Zap className="mr-2 h-4 w-4 text-yellow-500" />
                        <span>{t('startTemporaryChat')}</span>
                    </CommandItem>
                </CommandGroup>
            </CommandList>
        </CommandDialog>
    )
}
