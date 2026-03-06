import { HeadContent, Outlet, Scripts, createRootRoute } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WebOxyProvider } from '@oxyhq/auth';
import appCss from '../styles.css?url';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';

import config from '@/lib/config';

// Optimized QueryClient with better caching for performance
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes - reduce unnecessary refetches
      gcTime: 1000 * 60 * 30, // 30 minutes - keep data in cache longer
      retry: 1,
      refetchOnWindowFocus: false, // Don't refetch when user returns to tab
      refetchOnReconnect: 'always',
    },
    mutations: {
      retry: 1,
    },
  },
});

// Lazy load devtools for better initial load performance
const TanStackDevtools = lazy(() =>
  import('@tanstack/react-devtools').then((mod) => ({ default: mod.TanStackDevtools }))
);
const TanStackRouterDevtoolsPanel = lazy(() =>
  import('@tanstack/react-router-devtools').then((mod) => ({
    default: mod.TanStackRouterDevtoolsPanel,
  }))
);

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
      },
      {
        title: 'Alia Console',
      },
    ],
    links: [
      {
        rel: 'stylesheet',
        href: appCss,
      },
    ],
  }),

  component: RootComponent,
});

function RootComponent() {
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen bg-background font-sans antialiased">
        <QueryClientProvider client={queryClient}>
          <WebOxyProvider baseURL={config.oxyUrl}>
            <TooltipProvider delayDuration={300}>
              <Outlet />
              <Toaster position="bottom-right" richColors closeButton />
            </TooltipProvider>
          </WebOxyProvider>
        </QueryClientProvider>
        {import.meta.env.DEV && (
          <Suspense fallback={null}>
            <TanStackDevtools
              config={{
                position: 'bottom-right',
              }}
              plugins={[
                {
                  name: 'Tanstack Router',
                  render: <TanStackRouterDevtoolsPanel />,
                },
              ]}
            />
          </Suspense>
        )}
        <Scripts />
      </body>
    </html>
  );
}
