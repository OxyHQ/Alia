"use client"

import * as React from "react"
import {
    Settings2,
    Sparkles,
    Users,
    Bot,
    Code,
    Share2,
    Briefcase
} from "lucide-react"

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

const data = {
    user: {
        name: "Usuario",
        email: "user@alia.onl",
        avatar: "/avatars/shadcn.jpg",
    },
    agents: [
        {
            name: "Alia",
            logo: AliaLogo,
            description: "Asistente inteligente para todo",
        },
        {
            name: "Alia Developer",
            logo: Code,
            description: "Experto en programación y sistemas",
        },
        {
            name: "Alia Social Manager",
            logo: Share2,
            description: "Estratega de redes y contenido",
        },
        {
            name: "Alia Business",
            logo: Briefcase,
            description: "Analista de negocios y mercado",
        },
    ],
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
    return (
        <Sidebar collapsible="icon" {...props}>
            <SidebarHeader>
                <AgentSwitcher agents={data.agents} />
            </SidebarHeader>
            <SidebarContent>
                <SidebarGroup>
                    <SidebarMenu>
                        <SidebarMenuItem>
                            <SidebarMenuButton asChild tooltip="Nuevo Chat">
                                <a href="/">
                                    <Sparkles />
                                    <span>Nuevo Chat</span>
                                </a>
                            </SidebarMenuButton>
                        </SidebarMenuItem>
                        <SidebarMenuItem>
                            <SidebarMenuButton asChild tooltip="Agentes">
                                <a href="/agents">
                                    <Users />
                                    <span>Agentes</span>
                                </a>
                            </SidebarMenuButton>
                        </SidebarMenuItem>
                        <SidebarMenuItem>
                            <SidebarMenuButton asChild tooltip="Admin Dashboard">
                                <a href="/admin">
                                    <Settings2 />
                                    <span>Admin Dashboard</span>
                                </a>
                            </SidebarMenuButton>
                        </SidebarMenuItem>
                    </SidebarMenu>
                </SidebarGroup>

                <NavHistory />
            </SidebarContent>
            <SidebarFooter>
                <NavUser user={data.user} />
            </SidebarFooter>
            <SidebarRail />
        </Sidebar>
    )
}
