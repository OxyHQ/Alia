import type { JSX } from 'react'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  ArrowUp01Icon,
  Logout03Icon,
  Money01Icon,
  Notification01Icon,
  Setting06Icon,
} from '@hugeicons/core-free-icons'
import { useAuth } from '@oxyhq/services'
import { Link } from '@tanstack/react-router'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'

export function NavUser(): JSX.Element | null {
  const { isMobile } = useSidebar()
  const { user, signOut, oxyServices } = useAuth()

  if (!user) {
    return null
  }

  const handleSignOut = async (): Promise<void> => {
    await signOut()
    window.location.href = '/'
  }

  const getUserInitials = (): string =>
    (
      user.name?.displayName?.[0] ||
      user.username?.[0] ||
      user.email?.[0] ||
      'U'
    ).toUpperCase()

  const getAvatarUrl = (): string | undefined => {
    if (!user.avatar) return undefined
    if (user.avatar.startsWith('http')) return user.avatar
    return oxyServices.getFileDownloadUrl(user.avatar, 'thumb')
  }

  const getUserDisplayName = (): string =>
    user.name?.displayName || user.username || 'User'

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <Avatar className="h-8 w-8 rounded-lg">
                <AvatarImage src={getAvatarUrl()} alt={getUserDisplayName()} />
                <AvatarFallback className="rounded-lg">
                  {getUserInitials()}
                </AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">
                  {getUserDisplayName()}
                </span>
                <span className="truncate text-xs">{user.email}</span>
              </div>
              <HugeiconsIcon icon={ArrowUp01Icon} className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-[--radix-dropdown-menu-trigger-width] min-w-56 rounded-lg"
            side={isMobile ? 'bottom' : 'right'}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuLabel className="p-0 font-normal">
              <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                <Avatar className="h-8 w-8 rounded-lg">
                  <AvatarImage
                    src={getAvatarUrl()}
                    alt={getUserDisplayName()}
                  />
                  <AvatarFallback className="rounded-lg">
                    {getUserInitials()}
                  </AvatarFallback>
                </Avatar>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">
                    {getUserDisplayName()}
                  </span>
                  <span className="truncate text-xs">{user.email}</span>
                </div>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem asChild>
                <Link to="/billing">
                  <HugeiconsIcon icon={Money01Icon} size={16} />
                  Billing
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem>
                <HugeiconsIcon icon={Notification01Icon} size={16} />
                Notifications
              </DropdownMenuItem>
              <DropdownMenuItem>
                <HugeiconsIcon icon={Setting06Icon} size={16} />
                Settings
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={handleSignOut}
              className="text-destructive"
            >
              <HugeiconsIcon icon={Logout03Icon} size={16} />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
