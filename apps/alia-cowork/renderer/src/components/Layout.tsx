"use client"

import * as React from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  MinusSignIcon,
  Cancel01Icon,
  PinIcon,
  Pin02Icon,
  Settings01Icon,
  Home01Icon,
  Message01Icon,
  FolderOpenIcon,
  CommandIcon,
  InformationCircleIcon,
} from "@hugeicons/core-free-icons"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarShortcut,
  MenubarTrigger,
} from "@/components/ui/menubar"
import { useAuth } from "@/contexts/AuthContext"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarInset,
  useSidebar,
} from "@/components/ui/sidebar"

// Navigation items for sidebar
const navItems = [
  { id: "chat", label: "Chat", icon: Message01Icon },
  { id: "files", label: "Files", icon: FolderOpenIcon },
  { id: "commands", label: "Commands", icon: CommandIcon },
]

interface LayoutProps {
  children: React.ReactNode
  currentView?: string
  onViewChange?: (view: string) => void
}

function AppSidebar({ currentView, onViewChange }: { currentView?: string; onViewChange?: (view: string) => void }) {
  const { state } = useSidebar()

  return (
    <Sidebar collapsible="icon" variant="sidebar">
      <SidebarHeader className="border-b">
        <div className="flex items-center gap-2 px-1">
          <img src="alia-logo.png" alt="Alia" className="size-6 rounded-full" />
          {state === "expanded" && (
            <span className="font-semibold text-sm">Alia Cowork</span>
          )}
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => (
                <SidebarMenuItem key={item.id}>
                  <SidebarMenuButton
                    tooltip={item.label}
                    isActive={currentView === item.id}
                    onClick={() => onViewChange?.(item.id)}
                  >
                    <HugeiconsIcon icon={item.icon} strokeWidth={2} className="size-4" />
                    <span>{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="border-t">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Settings"
              isActive={currentView === "settings"}
              onClick={() => onViewChange?.("settings")}
            >
              <HugeiconsIcon icon={Settings01Icon} strokeWidth={2} className="size-4" />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}

interface TitleBarProps {
  onViewChange?: (view: string) => void
}

function TitleBar({ onViewChange }: TitleBarProps) {
  const [isPinned, setIsPinned] = React.useState(false)
  const [isFullScreen, setIsFullScreen] = React.useState(false)
  const { toggleSidebar, state: sidebarState } = useSidebar()
  const { signOut, user } = useAuth()

  const togglePin = async () => {
    const newState = await window.api?.toggleAlwaysOnTop()
    setIsPinned(newState)
  }

  const handleFullScreen = async () => {
    const newState = await window.api?.fullscreen()
    setIsFullScreen(newState)
  }

  // Listen for fullscreen changes from main process
  React.useEffect(() => {
    const unsubscribe = window.api?.onFullScreenChanged((isFs) => {
      setIsFullScreen(isFs)
    })
    return () => unsubscribe?.()
  }, [])

  return (
    <div className="flex items-center justify-between h-10 px-2 border-b bg-background/80 backdrop-blur shrink-0">
      <div className="flex items-center gap-1">
        {/* App Menu */}
        <Menubar className="border-0 bg-transparent p-0 h-auto gap-0">
          <MenubarMenu>
            <MenubarTrigger className="px-3 py-1.5 text-sm font-medium">File</MenubarTrigger>
            <MenubarContent className="z-[100]">
              <MenubarItem onClick={() => window.api?.clearChat?.()}>
                New Chat <MenubarShortcut>Ctrl+N</MenubarShortcut>
              </MenubarItem>
              <MenubarSeparator />
              <MenubarItem onClick={() => onViewChange?.("settings")}>
                Settings <MenubarShortcut>Ctrl+,</MenubarShortcut>
              </MenubarItem>
              <MenubarSeparator />
              {user && (
                <>
                  <MenubarItem onClick={signOut}>
                    Sign Out
                  </MenubarItem>
                  <MenubarSeparator />
                </>
              )}
              <MenubarItem onClick={() => window.api?.close()}>
                Exit <MenubarShortcut>Alt+F4</MenubarShortcut>
              </MenubarItem>
            </MenubarContent>
          </MenubarMenu>
          <MenubarMenu>
            <MenubarTrigger className="px-3 py-1.5 text-sm font-medium">Edit</MenubarTrigger>
            <MenubarContent className="z-[100]">
              <MenubarItem disabled>
                Undo <MenubarShortcut>Ctrl+Z</MenubarShortcut>
              </MenubarItem>
              <MenubarItem disabled>
                Redo <MenubarShortcut>Ctrl+Y</MenubarShortcut>
              </MenubarItem>
              <MenubarSeparator />
              <MenubarItem disabled>
                Cut <MenubarShortcut>Ctrl+X</MenubarShortcut>
              </MenubarItem>
              <MenubarItem disabled>
                Copy <MenubarShortcut>Ctrl+C</MenubarShortcut>
              </MenubarItem>
              <MenubarItem disabled>
                Paste <MenubarShortcut>Ctrl+V</MenubarShortcut>
              </MenubarItem>
            </MenubarContent>
          </MenubarMenu>
          <MenubarMenu>
            <MenubarTrigger className="px-3 py-1.5 text-sm font-medium">View</MenubarTrigger>
            <MenubarContent className="z-[100]">
              <MenubarItem onClick={toggleSidebar}>
                {sidebarState === "expanded" ? "Collapse" : "Expand"} Sidebar <MenubarShortcut>Ctrl+B</MenubarShortcut>
              </MenubarItem>
              <MenubarItem onClick={handleFullScreen}>
                {isFullScreen ? "Exit" : "Enter"} Full Screen <MenubarShortcut>F11</MenubarShortcut>
              </MenubarItem>
              <MenubarSeparator />
              <MenubarItem onClick={() => window.api?.zoomIn()}>
                Zoom In <MenubarShortcut>Ctrl++</MenubarShortcut>
              </MenubarItem>
              <MenubarItem onClick={() => window.api?.zoomOut()}>
                Zoom Out <MenubarShortcut>Ctrl+-</MenubarShortcut>
              </MenubarItem>
              <MenubarItem onClick={() => window.api?.zoomReset()}>
                Reset Zoom <MenubarShortcut>Ctrl+0</MenubarShortcut>
              </MenubarItem>
            </MenubarContent>
          </MenubarMenu>
          <MenubarMenu>
            <MenubarTrigger className="px-3 py-1.5 text-sm font-medium">Help</MenubarTrigger>
            <MenubarContent className="z-[100]">
              <MenubarItem onClick={() => window.open('https://docs.alia.onl', '_blank')}>
                Documentation
              </MenubarItem>
              <MenubarItem onClick={() => window.open('https://github.com/alia-ai/cowork/issues', '_blank')}>
                Report Issue
              </MenubarItem>
              <MenubarSeparator />
              <MenubarItem onClick={() => window.api?.showAbout()}>
                About Alia Cowork
              </MenubarItem>
            </MenubarContent>
          </MenubarMenu>
        </Menubar>
      </div>

      {/* Draggable spacer - only when not fullscreen */}
      {!isFullScreen && <div className="flex-1 h-full app-drag" />}
      {isFullScreen && <div className="flex-1" />}

      {/* Window Controls */}
      <div className="flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="size-8" onClick={togglePin}>
              <HugeiconsIcon icon={isPinned ? Pin02Icon : PinIcon} strokeWidth={2} className={cn("size-4", isPinned && "text-primary")} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{isPinned ? "Unpin window" : "Pin on top"}</TooltipContent>
        </Tooltip>
        <Button variant="ghost" size="icon" className="size-8" onClick={() => window.api?.minimize()}>
          <HugeiconsIcon icon={MinusSignIcon} strokeWidth={2} className="size-4" />
        </Button>
        <Button variant="ghost" size="icon" className="size-8 hover:bg-destructive hover:text-destructive-foreground" onClick={() => window.api?.close()}>
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-4" />
        </Button>
      </div>
    </div>
  )
}

export function Layout({ children, currentView = "chat", onViewChange }: LayoutProps) {
  return (
    <SidebarProvider defaultOpen={false}>
      <div className="flex h-screen w-full flex-col bg-background text-foreground overflow-hidden">
        <TitleBar onViewChange={onViewChange} />
        <div className="flex flex-1 overflow-hidden">
          <AppSidebar currentView={currentView} onViewChange={onViewChange} />
          <SidebarInset className="flex flex-col overflow-hidden">
            {children}
          </SidebarInset>
        </div>
      </div>
    </SidebarProvider>
  )
}

export default Layout
