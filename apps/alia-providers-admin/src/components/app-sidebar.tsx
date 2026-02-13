import {
  LayoutDashboard,
  Key,
  Boxes,
  Activity,
  BarChart3,
  CreditCard,
  Coins,
  Receipt,
  Server,
  Sparkles,
} from 'lucide-react';
import { NavMain } from '@/components/nav-main';
import { NavUser } from '@/components/nav-user';
import { ConnectionStatus } from '@/components/ConnectionStatus';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar';

const navItems = [
  { title: 'Dashboard', url: '/dashboard', icon: LayoutDashboard },
  { title: 'API Keys', url: '/keys', icon: Key },
  { title: 'Models', url: '/models', icon: Boxes },
  { title: 'Plans', url: '/plans', icon: CreditCard },
  { title: 'Features', url: '/features', icon: Sparkles },
  { title: 'Credit Packages', url: '/credit-packages', icon: Coins },
  { title: 'Billing', url: '/billing', icon: Receipt },
  { title: 'Monitoring', url: '/monitoring', icon: Activity },
  { title: 'Usage', url: '/usage', icon: BarChart3 },
];

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <a href="/dashboard">
                <div className="bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg">
                  <Server className="size-4" />
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">Alia Providers</span>
                  <span className="truncate text-xs">Admin Panel</span>
                </div>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={navItems} />
      </SidebarContent>
      <SidebarFooter>
        <div className="px-2 group-data-[collapsible=icon]:hidden">
          <ConnectionStatus />
        </div>
        <NavUser />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
