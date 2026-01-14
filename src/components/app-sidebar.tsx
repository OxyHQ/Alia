"use client"

import * as React from "react"
import {
    Settings02Icon,
    SparklesIcon,
    UserGroupIcon,
    ArtificialIntelligence01Icon,
    CodeIcon,
    Share05Icon,
    Briefcase01Icon,
    Chat01Icon,
    MoreHorizontalIcon,
    Delete02Icon,
    CheckmarkBadge01Icon,
    Notification01Icon,
    ArrowUpDownIcon,
    CreditCardIcon,
    Logout01Icon,
} from "@hugeicons/core-free-icons"
import { createIcon } from "@/components/ui/hugeicon"

const Settings2 = createIcon(Settings02Icon)
const Sparkles = createIcon(SparklesIcon)
const Users = createIcon(UserGroupIcon)
const Bot = createIcon(ArtificialIntelligence01Icon)
const Code = createIcon(CodeIcon)
const Share2 = createIcon(Share05Icon)
const Briefcase = createIcon(Briefcase01Icon)
const MessageSquare = createIcon(Chat01Icon)
const MoreHorizontal = createIcon(MoreHorizontalIcon)
const Trash2 = createIcon(Delete02Icon)
const BadgeCheck = createIcon(CheckmarkBadge01Icon)
const Bell = createIcon(Notification01Icon)
const ChevronsUpDown = createIcon(ArrowUpDownIcon)
const CreditCard = createIcon(CreditCardIcon)
const LogOut = createIcon(Logout01Icon)
import { useTranslations } from 'next-intl'

import { NavHistory } from "@/components/nav-history"
import { NavUser } from "@/components/nav-user"
import { AgentSwitcher } from "@/components/agent-switcher"
import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarHeader,
    SidebarRail,
    SidebarGroup,
    SidebarMenu,
    SidebarMenuItem,
    SidebarMenuButton,
} from "@/components/ui/sidebar"

// Data for the sidebar
const AliaLogo = (props: React.ComponentProps<"img">) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { className, ...rest } = props
    return (
        // eslint-disable-next-line @next/next/no-img-element
        <img
            src="/icon-512-maskable.png"
            alt="Alia"
            className="size-full object-cover"
            {...rest}
        />
    )
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
    const t = useTranslations('sidebar')
    const tAgents = useTranslations('agents')
    const tUser = useTranslations('user')

    const user = {
        name: tUser('user'),
        email: "user@alia.onl",
        avatar: "https://github.com/shadcn.png",
    }

    const agents = [
        {
            name: tAgents('alia.name'),
            logo: AliaLogo,
            description: tAgents('alia.description'),
        },
        {
            name: tAgents('developer.name'),
            logo: Code,
            description: tAgents('developer.description'),
        },
        {
            name: tAgents('socialManager.name'),
            logo: Share2,
            description: tAgents('socialManager.description'),
        },
        {
            name: tAgents('business.name'),
            logo: Briefcase,
            description: tAgents('business.description'),
        },
    ]

    return (
        <Sidebar collapsible="icon" {...props}>
            <SidebarHeader>
                <AgentSwitcher agents={agents} />
            </SidebarHeader>
            <SidebarContent>
                <SidebarGroup>
                    <SidebarMenu>
                        <SidebarMenuItem>
                            <SidebarMenuButton asChild tooltip={t('newChat')}>
                                <a href="/">
                                    <Sparkles />
                                    <span>{t('newChat')}</span>
                                </a>
                            </SidebarMenuButton>
                        </SidebarMenuItem>
                        <SidebarMenuItem>
                            <SidebarMenuButton asChild tooltip={t('agentsMenu')}>
                                <a href="/agents">
                                    <Users />
                                    <span>{t('agentsMenu')}</span>
                                </a>
                            </SidebarMenuButton>
                        </SidebarMenuItem>
                        <SidebarMenuItem>
                            <SidebarMenuButton asChild tooltip={t('adminDashboard')}>
                                <a href="/admin">
                                    <Settings2 />
                                    <span>{t('adminDashboard')}</span>
                                </a>
                            </SidebarMenuButton>
                        </SidebarMenuItem>
                    </SidebarMenu>
                </SidebarGroup>

                <NavHistory />
            </SidebarContent>
            <SidebarFooter>
                <NavUser user={user} />
            </SidebarFooter>
            <SidebarRail />
        </Sidebar>
    )
}
