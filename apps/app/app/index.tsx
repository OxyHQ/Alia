import { Redirect } from 'expo-router';
import { useAuthStore } from '@/lib/stores/auth-store';

export default function Index() {
  // Use selector to avoid worklet serialization issues
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);

  // Redirect to chat if authenticated, otherwise to login
  if (isAuthenticated) {
    return <Redirect href="/(chat)" />;
  }

  return <Redirect href="/login" />;
}
