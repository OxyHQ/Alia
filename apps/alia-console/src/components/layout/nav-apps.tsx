import { Link } from '@tanstack/react-router';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  Key01Icon,
  MoreHorizontalIcon,
  Settings01Icon,
  Delete02Icon,
  ChartLineData02Icon,
} from '@hugeicons/core-free-icons';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar';
import { useApps } from '@/hooks/use-developer';

interface NavAppsProps {
  onDeleteApp?: (appId: string) => void;
}

export function NavApps({ onDeleteApp }: NavAppsProps) {
  const { isMobile } = useSidebar();
  const { data: apps = [] } = useApps();

  if (apps.length === 0) {
    return null;
  }

  return (
    <SidebarGroup className="group-data-[collapsible=icon]:hidden">
      <SidebarGroupLabel>Your Apps</SidebarGroupLabel>
      <SidebarMenu>
        {apps.slice(0, 5).map((app) => (
          <SidebarMenuItem key={app._id}>
            <SidebarMenuButton asChild>
              <Link to="/apps/$appId" params={{ appId: app._id }}>
                <HugeiconsIcon icon={Key01Icon} size={16} />
                <span>{app.name}</span>
              </Link>
            </SidebarMenuButton>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuAction showOnHover>
                  <HugeiconsIcon icon={MoreHorizontalIcon} size={16} />
                  <span className="sr-only">More</span>
                </SidebarMenuAction>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                className="w-48 rounded-lg"
                side={isMobile ? 'bottom' : 'right'}
                align={isMobile ? 'end' : 'start'}
              >
                <DropdownMenuItem asChild>
                  <Link to="/apps/$appId" params={{ appId: app._id }}>
                    <HugeiconsIcon icon={Key01Icon} size={14} className="text-muted-foreground" />
                    <span>View Details</span>
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to="/apps/$appId/settings" params={{ appId: app._id }}>
                    <HugeiconsIcon icon={Settings01Icon} size={14} className="text-muted-foreground" />
                    <span>Settings</span>
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to="/apps/$appId/usage" params={{ appId: app._id }}>
                    <HugeiconsIcon
                      icon={ChartLineData02Icon}
                      size={14}
                      className="text-muted-foreground"
                    />
                    <span>Usage</span>
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive"
                  onClick={() => onDeleteApp?.(app._id)}
                >
                  <HugeiconsIcon icon={Delete02Icon} size={14} className="text-muted-foreground" />
                  <span>Delete</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        ))}
        {apps.length > 5 && (
          <SidebarMenuItem>
            <SidebarMenuButton asChild className="text-sidebar-foreground/70">
              <Link to="/apps">
                <HugeiconsIcon icon={MoreHorizontalIcon} size={16} className="text-sidebar-foreground/70" />
                <span>View all ({apps.length})</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        )}
      </SidebarMenu>
    </SidebarGroup>
  );
}
