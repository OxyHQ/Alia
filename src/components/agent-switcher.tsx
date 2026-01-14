"use client"

import * as React from "react"
import { ArrowUpDownIcon, Add01Icon } from '@hugeicons/core-free-icons'
import { createIcon } from '@/components/ui/hugeicon'

const ChevronsUpDown = createIcon(ArrowUpDownIcon)
const Plus = createIcon(Add01Icon)
import { useTranslations } from 'next-intl'

import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuShortcut,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
    useSidebar,
} from "@/components/ui/sidebar"

export function AgentSwitcher({
    agents,
}: {
    agents: {
        name: string
        logo: React.ElementType
        description: string
    }[]
}) {
    const { isMobile } = useSidebar()
    const [activeAgent, setActiveAgent] = React.useState(agents[0])
    const t = useTranslations('sidebar')

    if (!activeAgent) {
        return null
    }

    return (
        <SidebarMenu>
            <SidebarMenuItem>
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <SidebarMenuButton
                            size="lg"
                            className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                        >
                            <div className="bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-8 items-center justify-center squircle">
                                <activeAgent.logo className="size-4" />
                            </div>
                            <div className="grid flex-1 text-left text-sm leading-tight">
                                <span className="truncate font-medium">{activeAgent.name}</span>
                                <span className="truncate text-xs">{activeAgent.description}</span>
                            </div>
                            <ChevronsUpDown className="ml-auto" />
                        </SidebarMenuButton>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                        className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
                        align="start"
                        side={isMobile ? "bottom" : "right"}
                        sideOffset={4}
                    >
                        <DropdownMenuLabel className="text-muted-foreground text-xs">
                            {t('agents')}
                        </DropdownMenuLabel>
                        {agents.map((agent, index) => (
                            <DropdownMenuItem
                                key={agent.name}
                                onClick={() => setActiveAgent(agent)}
                                className="gap-2 p-2"
                            >
                                <div className="flex size-6 items-center justify-center squircle border">
                                    <agent.logo className="size-3.5 shrink-0" />
                                </div>
                                {agent.name}
                                <DropdownMenuShortcut>⌘{index + 1}</DropdownMenuShortcut>
                            </DropdownMenuItem>
                        ))}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem className="gap-2 p-2">
                            <div className="flex size-6 items-center justify-center squircle border bg-transparent">
                                <Plus className="size-4" />
                            </div>
                            <div className="text-muted-foreground font-medium">{t('createAgent')}</div>
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </SidebarMenuItem>
        </SidebarMenu>
    )
}
