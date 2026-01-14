"use client"

import * as React from "react"
import {
    MoreHorizontal,
    Ghost,
    Search
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover"
import {
    Sidebar,
    SidebarContent,
    SidebarGroup,
    SidebarGroupContent,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
} from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"

import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select"

export function NavActions() {
    const [isOpen, setIsOpen] = React.useState(false)
    const [model, setModel] = React.useState("v1")

    // Cargar modelo inicial y escuchar cambios externos
    React.useEffect(() => {
        const saved = localStorage.getItem('alia-selected-model')
        if (saved) setModel(saved)

        const handleSync = () => {
            const current = localStorage.getItem('alia-selected-model')
            if (current) setModel(current)
        }

        window.addEventListener('storage', handleSync)
        return () => window.removeEventListener('storage', handleSync)
    }, [])

    const handleModelChange = (val: string) => {
        setModel(val)
        localStorage.setItem('alia-selected-model', val)
        window.dispatchEvent(new Event('alia-model-changed'))
    }

    const [isTemporary, setIsTemporary] = React.useState(false)

    React.useEffect(() => {
        const saved = localStorage.getItem('alia-temporary-chat') === 'true'
        setIsTemporary(saved)
    }, [])

    const toggleTemporary = () => {
        const newVal = !isTemporary
        setIsTemporary(newVal)
        localStorage.setItem('alia-temporary-chat', String(newVal))
        window.dispatchEvent(new Event('alia-temporary-chat-changed'))
    }

    return (
        <div className="flex items-center gap-2 text-sm">
            <Select value={model} onValueChange={handleModelChange}>
                <SelectTrigger className="h-7 w-fit min-w-[80px] border-none bg-transparent hover:bg-accent focus:ring-0 text-muted-foreground font-medium px-2 gap-1.5 transition-all">
                    <SelectValue placeholder="Select version" />
                </SelectTrigger>
                <SelectContent align="end">
                    <SelectItem value="v1">Alia V1</SelectItem>
                    <SelectItem value="v1-pro">Alia V1 Pro</SelectItem>
                    <SelectItem value="v1-pro-max">Alia V1 Pro Max</SelectItem>
                </SelectContent>
            </Select>
            <Button
                variant="ghost"
                size="icon"
                className={cn(
                    "h-7 w-7 transition-colors rounded-full",
                    isTemporary ? "text-primary bg-primary/10 hover:bg-primary/20" : "text-muted-foreground hover:text-foreground"
                )}
                onClick={toggleTemporary}
                title={isTemporary ? "Desactivar Chat Temporal" : "Activar Chat Temporal"}
            >
                <Ghost className={cn("h-4 w-4", isTemporary && "fill-current")} />
            </Button>
            <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                onClick={() => window.dispatchEvent(new Event('open-command-menu'))}
                title="Buscar o comandos (⌘K)"
            >
                <Search className="h-4 w-4" />
            </Button>
            <Popover open={isOpen} onOpenChange={setIsOpen}>
                <PopoverTrigger asChild>
                    <Button
                        variant="ghost"
                        size="icon"
                        className="data-[state=open]:bg-accent h-7 w-7"
                    >
                        <MoreHorizontal />
                    </Button>
                </PopoverTrigger>
                <PopoverContent
                    className="w-56 overflow-hidden rounded-lg p-0"
                    align="end"
                >
                    <Sidebar collapsible="none" className="bg-transparent">
                        <SidebarContent>
                            <div className="p-2 text-xs text-muted-foreground">
                                Alia Agent Platform
                            </div>
                        </SidebarContent>
                    </Sidebar>
                </PopoverContent>
            </Popover>
        </div>
    )
}
