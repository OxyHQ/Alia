import { createFileRoute, Outlet } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useAuth } from '@oxyhq/auth';
import { SidebarProvider, SidebarInset, SidebarTrigger } from '@/components/ui/sidebar';
import { AppSidebar } from '@/components/layout/app-sidebar';
import { Separator } from '@/components/ui/separator';
import { CommandMenuTrigger } from '@/components/command-menu';
import { setTokenGetter } from '@/lib/api/client';

export const Route = createFileRoute('/_layout')({
  component: LayoutComponent,
});

function ApiAuthSetup({ children }: { children: React.ReactNode }) {
  const { authManager } = useAuth();

  useEffect(() => {
    setTokenGetter(() => authManager.getAccessToken());
  }, [authManager]);

  return <>{children}</>;
}

function LayoutComponent() {
  return (
    <ApiAuthSetup>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset className="flex flex-col h-screen">
          <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-2 h-4" />
            <CommandMenuTrigger />
            <div className="flex-1" />
          </header>
          <main className="flex-1 flex flex-col overflow-auto">
            <Outlet />
          </main>
        </SidebarInset>
      </SidebarProvider>
    </ApiAuthSetup>
  );
}
