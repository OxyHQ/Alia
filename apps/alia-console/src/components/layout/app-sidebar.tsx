import { HugeiconsIcon } from '@hugeicons/react';
import {
  Home09Icon,
  Key01Icon,
  ChartLineData01Icon,
  AiBrain01Icon,
  SourceCodeIcon,
  Doc01Icon,
  Money01Icon,
  Login01Icon,
  Settings01Icon,
  CommandIcon,
} from '@hugeicons/core-free-icons';
import { useAuth } from '@oxyhq/auth';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
} from '@/components/ui/sidebar';
import { Button } from '@/components/ui/button';
import { NavMain } from './nav-main';
import { NavApps } from './nav-apps';
import { NavUser } from './nav-user';
import { SidebarHeaderBrand } from './sidebar-header';

const mainNavItems = [
  {
    title: 'Dashboard',
    url: '/dashboard',
    icon: Home09Icon,
  },
  {
    title: 'Playground',
    url: '/playground',
    icon: CommandIcon,
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
    title: 'Billing',
    url: '/billing',
    icon: Money01Icon,
  },
];

const resourceNavItems = [
  {
    title: 'Models',
    url: '/models',
    icon: AiBrain01Icon,
  },
  {
    title: 'Documentation',
    url: '/documentation',
    icon: Doc01Icon,
    items: [
      { title: 'Quick Start', url: '/documentation/quickstart' },
      { title: 'Authentication', url: '/documentation/authentication' },
      { title: 'Chat Completions', url: '/documentation/chat-completions' },
      { title: 'Models', url: '/documentation/models' },
      { title: 'SDKs', url: '/documentation/sdks' },
    ],
  },
  {
    title: 'Examples',
    url: '/examples',
    icon: SourceCodeIcon,
  },
];

const settingsNavItems = [
  {
    title: 'Settings',
    url: '/settings',
    icon: Settings01Icon,
    items: [
      { title: 'Workspace', url: '/settings/workspace' },
    ],
  },
];

export function AppSidebar() {
  const { isAuthenticated, signIn } = useAuth();

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarHeaderBrand />
      </SidebarHeader>

      <SidebarContent>
        <NavMain items={mainNavItems} label="Platform" />
        <NavApps />
        <NavMain items={resourceNavItems} label="Resources" />
        <NavMain items={settingsNavItems} label="Settings" />
      </SidebarContent>

      <SidebarFooter>
        {isAuthenticated ? (
          <NavUser />
        ) : (
          <Button variant="ghost" className="w-full justify-start gap-2 px-2" onClick={signIn}>
            <HugeiconsIcon icon={Login01Icon} size={18} />
            <span>Sign in</span>
          </Button>
        )}
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
