import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { OxyProvider, useAuth } from '@oxyhq/services';
import { BloomThemeProvider } from '@oxyhq/bloom/theme';
import { DashboardLayout } from './components/layouts/DashboardLayout';
import { DashboardPage } from './pages/Dashboard';
import { KeysPage } from './pages/Keys';
import { ModelsPage } from './pages/Models';
import { MonitoringPage } from './pages/Monitoring';
import { UsagePage } from './pages/Usage';
import { PlansPage } from './pages/Plans';
import { CreditPackagesPage } from './pages/CreditPackages';
import { BillingPage } from './pages/Billing';
import { FeaturesPage } from './pages/Features';
import { LogsPage } from './pages/Logs';
import { LoginPage } from './pages/Login';
import { RealtimeProvider } from './lib/websocket/provider';
import { apiClient } from './lib/api/client';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 30000, // 30 seconds
    },
  },
});

const OXY_CLIENT_ID =
  import.meta.env.VITE_OXY_CLIENT_ID || 'oxy_dk_06488927793f96922ef4f366a9800547b34c6aec025fece3';

const OXY_API_URL = import.meta.env.VITE_OXY_URL || 'https://api.oxy.so';

function ApiAuthSetup({ children }: { children: React.ReactNode }) {
  const { oxyServices } = useAuth();

  // Set token getter synchronously so it's available before child queries fire.
  // Uses oxyServices.getAccessToken() to get the JWT (not raw session ID).
  apiClient.setTokenGetter(async () => oxyServices.getAccessToken() || null);

  return <>{children}</>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BloomThemeProvider mode="system" colorPreset="oxy">
        <OxyProvider baseURL={OXY_API_URL} clientId={OXY_CLIENT_ID} queryClient={queryClient}>
          <ApiAuthSetup>
            <RealtimeProvider>
              <BrowserRouter>
                <AppRoutes />
              </BrowserRouter>
            </RealtimeProvider>
          </ApiAuthSetup>
        </OxyProvider>
      </BloomThemeProvider>
    </QueryClientProvider>
  );
}

function AppRoutes() {
  const { user, isAuthenticated, isLoading } = useAuth();

  // Show loading state
  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center space-y-4">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto" />
          <p className="text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  // Check if user is authorized (only "nate" username allowed)
  const isAuthorized = user?.username?.toLowerCase() === 'nate';

  // Show login page if not authenticated or not authorized
  if (!isAuthenticated || !user || !isAuthorized) {
    return (
      <Routes>
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }

  // Show admin panel if authenticated and authorized
  return (
    <Routes>
      <Route path="/" element={<DashboardLayout />}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="keys" element={<KeysPage />} />
        <Route path="models" element={<ModelsPage />} />
        <Route path="plans" element={<PlansPage />} />
        <Route path="credit-packages" element={<CreditPackagesPage />} />
        <Route path="features" element={<FeaturesPage />} />
        <Route path="billing" element={<BillingPage />} />
        <Route path="monitoring" element={<MonitoringPage />} />
        <Route path="usage" element={<UsagePage />} />
        <Route path="logs" element={<LogsPage />} />
      </Route>
    </Routes>
  );
}

export default App;
