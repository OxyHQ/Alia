import { Outlet, createFileRoute } from '@tanstack/react-router';
import { RequireOxyAuth, useAuth } from '@oxyhq/services';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { AppSidebar } from '@/components/layout/app-sidebar';
import { Separator } from '@/components/ui/separator';
import { CommandMenuTrigger } from '@/components/command-menu';
import { Button } from '@/components/ui/button';
import { setTokenGetter, setWorkspaceGetter } from '@/lib/api/client';

export const Route = createFileRoute('/_layout')({
  component: LayoutComponent,
});

function ApiAuthSetup({ children }: { children: React.ReactNode }) {
  const { oxyServices } = useAuth();

  // Set token getter synchronously during render to avoid race condition
  // where child effects (React Query) fire before this parent's useEffect
  setTokenGetter(async () => oxyServices.getAccessToken());

  // Set workspace getter — reads current workspace from localStorage
  setWorkspaceGetter(() => {
    if (typeof window === 'undefined') return 'personal';
    return localStorage.getItem('alia-current-workspace') || 'personal';
  });

  return <>{children}</>;
}

function LoadingScreen() {
  return (
    <div className="flex items-center justify-center h-screen">
      <div className="text-muted-foreground">Loading...</div>
    </div>
  );
}

function SignInScreen() {
  const { signIn } = useAuth();

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-4">
      <div className="text-muted-foreground">Sign in to continue</div>
      <Button onClick={() => void signIn()}>Sign in with Oxy</Button>
    </div>
  );
}

function AuthGuard({ children }: { children: React.ReactNode }) {
  // Shared SDK signed-out gate. It keys on the SDK readiness state
  // (`canUsePrivateApi` / `isPrivateApiPending`), so private data never loads
  // before the device-first cold boot resolves and the signed-out wall never
  // flashes. `signIn()` opens the in-app "Sign in with Oxy" dialog — a modal,
  // never a navigation.
  return (
    <RequireOxyAuth
      prompt="hard"
      loadingFallback={<LoadingScreen />}
      signedOutFallback={<SignInScreen />}
    >
      {children}
    </RequireOxyAuth>
  );
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
