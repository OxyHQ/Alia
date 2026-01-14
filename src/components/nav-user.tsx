"use client"

import * as React from "react"
import {
    BadgeCheck,
    Bell,
    ChevronsUpDown,
    CreditCard,
    LogOut,
    Sparkles,
} from "lucide-react"
import { useTranslations } from 'next-intl'

import {
    Avatar,
    AvatarFallback,
    AvatarImage,
} from "@/components/ui/avatar"
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
    useSidebar,
} from "@/components/ui/sidebar"
import { SettingsDialog } from "@/components/settings-dialog"

import { useSession, signOut } from "next-auth/react"

export function NavUser({
    user: initialUser,
}: {
    user: {
        name: string
        email: string
        avatar: string
    }
}) {
    const { data: session } = useSession()
    const { isMobile } = useSidebar()
    const [settingsOpen, setSettingsOpen] = React.useState(false)
    const [initialSection, setInitialSection] = React.useState<"account" | "billing">("account")
    const t = useTranslations('user')

    const user = session?.user ? {
        name: session.user.name || initialUser.name,
        email: session.user.email || initialUser.email,
        avatar: session.user.image || initialUser.avatar
    } : initialUser

    const openSettings = (section: "account" | "billing") => {
        setInitialSection(section)
        setSettingsOpen(true)
    }

    // Si no hay sesión, podríamos mostrar un botón de "Iniciar sesión"
    // Pero por ahora, NavUser se muestra siempre, así que usaremos los datos de la sesión si existen.

    return (
        <div className="relative">
            <SidebarMenu>
                <SidebarMenuItem>
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <SidebarMenuButton
                                size="lg"
                                className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                            >
                                <Avatar className="h-8 w-8 rounded-lg">
                                    <AvatarImage src={user.avatar} alt={user.name} />
                                    <AvatarFallback className="rounded-lg">
                                        {user.name?.slice(0, 2).toUpperCase() || "AI"}
                                    </AvatarFallback>
                                </Avatar>
                                <div className="grid flex-1 text-left text-sm leading-tight">
                                    <span className="truncate font-medium">{user.name}</span>
                                    <span className="truncate text-xs">{user.email}</span>
                                </div>
                                <ChevronsUpDown className="ml-auto size-4" />
                            </SidebarMenuButton>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
                            side={isMobile ? "bottom" : "right"}
                            align="end"
                            sideOffset={4}
                        >
                            <DropdownMenuLabel className="p-0 font-normal">
                                <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                                    <Avatar className="h-8 w-8 rounded-lg">
                                        <AvatarImage src={user.avatar} alt={user.name} />
                                        <AvatarFallback className="rounded-lg">
                                            {user.name?.slice(0, 2).toUpperCase() || "AI"}
                                        </AvatarFallback>
                                    </Avatar>
                                    <div className="grid flex-1 text-left text-sm leading-tight">
                                        <span className="truncate font-medium">{user.name}</span>
                                        <span className="truncate text-xs">{user.email}</span>
                                    </div>
                                </div>
                            </DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            <DropdownMenuGroup>
                                <DropdownMenuItem onSelect={() => openSettings("billing")}>
                                    <Sparkles />
                                    {t('upgradeToPro')}
                                </DropdownMenuItem>
                            </DropdownMenuGroup>
                            <DropdownMenuSeparator />
                            <DropdownMenuGroup>
                                <DropdownMenuItem onSelect={() => openSettings("account")}>
                                    <BadgeCheck />
                                    {t('account')}
                                </DropdownMenuItem>
                                <DropdownMenuItem onSelect={() => openSettings("billing")}>
                                    <CreditCard />
                                    {t('billing')}
                                </DropdownMenuItem>
                                <DropdownMenuItem>
                                    <Bell />
                                    {t('notifications')}
                                </DropdownMenuItem>
                            </DropdownMenuGroup>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onSelect={() => signOut()}>
                                <LogOut />
                                {t('logOut')}
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </SidebarMenuItem>
            </SidebarMenu>

            <SettingsDialog
                open={settingsOpen}
                onOpenChange={setSettingsOpen}
                initialSection={initialSection}
            />
        </div>
    )
}
