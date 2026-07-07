import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OxyProvider } from "@oxyhq/services";
import { BloomThemeProvider } from "@oxyhq/bloom/theme";
import { ThemeProvider } from "@/components/theme-provider";
import { AuthGuard } from "@/components/auth-guard";
import { DesktopOnlyGuard } from "@/components/desktop-only-guard";
import { WorkflowEditor } from "@/components/workflow/workflow-editor";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60 * 1000,
      refetchOnWindowFocus: false,
    },
  },
});

const OXY_API_URL: string = import.meta.env.VITE_OXY_URL || "https://api.oxy.so";
const OXY_CLIENT_ID: string =
  import.meta.env.VITE_OXY_CLIENT_ID || "oxy_dk_06488927793f96922ef4f366a9800547b34c6aec025fece3";

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BloomThemeProvider mode="system" colorPreset="oxy">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <OxyProvider baseURL={OXY_API_URL} clientId={OXY_CLIENT_ID} queryClient={queryClient}>
            <AuthGuard>
              <DesktopOnlyGuard>
                <WorkflowEditor />
              </DesktopOnlyGuard>
            </AuthGuard>
          </OxyProvider>
        </ThemeProvider>
      </BloomThemeProvider>
    </QueryClientProvider>
  );
}
