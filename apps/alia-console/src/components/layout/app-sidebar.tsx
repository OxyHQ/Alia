import { Link, useLocation } from '@tanstack/react-router';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  Home09Icon,
  Key01Icon,
  ChartLineData01Icon,
  AiBrain01Icon,
  SourceCodeIcon,
  Doc01Icon,
  Money01Icon,
  Setting06Icon,
  ArrowDown01Icon,
  Logout03Icon,
  Login01Icon,
} from '@hugeicons/core-free-icons';
import { useAuth } from '@oxyhq/services/web';
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
  SidebarSeparator,
} from '@/components/ui/sidebar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import config from '@/lib/config';

const navigationItems = [
  {
    title: 'Dashboard',
    url: '/dashboard',
    icon: Home09Icon,
  },
  {
    title: 'API Keys',
    url: '/apps',
    icon: Key01Icon,
  },
  {
    title: 'Usage',
    url: '/usage',
    icon: ChartLineData01Icon,
  },
  {
    title: 'Models',
    url: '/models',
    icon: AiBrain01Icon,
  },
  {
    title: 'Documentation',
    url: '/documentation',
    icon: Doc01Icon,
  },
  {
    title: 'Examples',
    url: '/examples',
    icon: SourceCodeIcon,
  },
];

export function AppSidebar() {
  const location = useLocation();
  const { user, isAuthenticated, signOut } = useAuth();

  const handleSignIn = () => {
    // Redirect to Oxy login
    window.location.href = `${config.oxyUrl}/login?redirect=${encodeURIComponent(window.location.href)}`;
  };

  const handleSignOut = async () => {
    await signOut();
    window.location.href = '/';
  };

  const getUserInitials = () => {
    if (!user?.name) return user?.username?.[0]?.toUpperCase() || 'U';
    const name = user.name as { first?: string; last?: string };
    if (name.first && name.last) {
      return `${name.first[0]}${name.last[0]}`.toUpperCase();
    }
    return (name.first?.[0] || user?.username?.[0] || 'U').toUpperCase();
  };

  const getUserDisplayName = () => {
    if (!user) return 'User';
    const name = user.name as { first?: string; last?: string } | undefined;
    if (name?.first) {
      return name.last ? `${name.first} ${name.last}` : name.first;
    }
    return user.username || 'User';
  };

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  size="lg"
                  className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                >
                  <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                    <HugeiconsIcon icon={AiBrain01Icon} size={18} />
                  </div>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-semibold">Alia Console</span>
                    <span className="truncate text-xs text-muted-foreground">Developer Portal</span>
                  </div>
                  <HugeiconsIcon icon={ArrowDown01Icon} className="ml-auto" size={16} />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                className="w-[--radix-dropdown-menu-trigger-width] min-w-56 rounded-lg"
                align="start"
                side="bottom"
                sideOffset={4}
              >
                <DropdownMenuItem>
                  <span>Personal Account</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {navigationItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton
                    asChild
                    isActive={location.pathname.startsWith(item.url)}
                    tooltip={item.title}
                  >
                    <Link to={item.url}>
                      <HugeiconsIcon icon={item.icon} size={18} />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarSeparator />
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              isActive={location.pathname === '/billing'}
              tooltip="Billing"
            >
              <Link to="/billing">
                <HugeiconsIcon icon={Money01Icon} size={18} />
                <span>Billing</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>

          {isAuthenticated ? (
            <SidebarMenuItem>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <SidebarMenuButton
                    size="lg"
                    className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                  >
                    <Avatar className="size-8 rounded-lg">
                      {user?.avatar && <AvatarImage src={user.avatar} />}
                      <AvatarFallback className="rounded-lg">
                        {getUserInitials()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="grid flex-1 text-left text-sm leading-tight">
                      <span className="truncate font-semibold">{getUserDisplayName()}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {user?.email || ''}
                      </span>
                    </div>
                    <HugeiconsIcon icon={Setting06Icon} className="ml-auto" size={16} />
                  </SidebarMenuButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  className="w-[--radix-dropdown-menu-trigger-width] min-w-56 rounded-lg"
                  align="end"
                  side="top"
                  sideOffset={4}
                >
                  <DropdownMenuItem>
                    <span>Settings</span>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={handleSignOut} className="text-destructive">
                    <HugeiconsIcon icon={Logout03Icon} size={16} />
                    <span>Sign out</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          ) : (
            <SidebarMenuItem>
              <Button
                variant="ghost"
                className="w-full justify-start gap-2 px-2"
                onClick={handleSignIn}
              >
                <HugeiconsIcon icon={Login01Icon} size={18} />
                <span>Sign in</span>
              </Button>
            </SidebarMenuItem>
          )}
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
