import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { DashboardLayout } from './components/layouts/DashboardLayout';
import { DashboardPage } from './pages/Dashboard';
import { KeysPage } from './pages/Keys';
import { ModelsPage } from './pages/Models';
import { MonitoringPage } from './pages/Monitoring';
import { LoginPage } from './pages/Login';
import { RealtimeProvider } from './lib/websocket/provider';
import { AuthProvider, useAuth } from './lib/auth/context';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 30000, // 30 seconds
    },
  },
});

function App() {
  return (
    <AuthProvider>
      <RealtimeProvider>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <AppRoutes />
          </BrowserRouter>
        </QueryClientProvider>
      </RealtimeProvider>
    </AuthProvider>
  );
}

function AppRoutes() {
  const { user, isAuthorized, loading } = useAuth();

  // Show loading state
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center space-y-4">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto" />
          <p className="text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  // Show login page if not authenticated or not authorized
  if (!user || !isAuthorized) {
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
        <Route path="monitoring" element={<MonitoringPage />} />
      </Route>
    </Routes>
  );
}

export default App;
