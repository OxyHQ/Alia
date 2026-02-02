import { useEffect } from 'react';
import { createFileRoute, Outlet } from '@tanstack/react-router';
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

  // Set token getter synchronously during render to avoid race condition
  // where child effects (React Query) fire before this parent's useEffect
  setTokenGetter(() => authManager.getAccessToken());

  return <>{children}</>;
}

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isReady, signIn } = useAuth();

  useEffect(() => {
    if (isReady && !isAuthenticated) {
      signIn();
    }
  }, [isReady, isAuthenticated, signIn]);

  if (!isReady || !isAuthenticated) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  return <>{children}</>;
}

function LayoutComponent() {
  return (
    <ApiAuthSetup>
      <AuthGuard>
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
      </AuthGuard>
    </ApiAuthSetup>
  );
}
