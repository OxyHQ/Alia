/**
 * OxyHQ Authentication Context
 * Provides cross-domain SSO authentication using WebOxyProvider
 * Only allows username "nate" as admin
 */

import { useEffect, useState, createContext, useContext, type ReactNode } from 'react';
import { WebOxyProvider, useAuth as useOxyAuth } from '@oxyhq/services/web';
import type { MinimalUserData } from '@oxyhq/services/web';
import { apiClient } from '@/lib/api/client';

// ==================== Auth Context (extends Oxy's useAuth) ====================

interface AuthContextType {
  user: MinimalUserData | null;
  loading: boolean;
  isAuthorized: boolean; // Only true if username === 'nate'
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  error: string | null;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  return (
    <WebOxyProvider baseURL="https://api.oxy.so">
      <AuthProviderInner>{children}</AuthProviderInner>
    </WebOxyProvider>
  );
}

function AuthProviderInner({ children }: { children: ReactNode }) {
  const { user, isAuthenticated, signIn: oxySignIn, signOut: oxySignOut, isLoading } = useOxyAuth();
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Check if user is authorized (username must be 'nate')
  const checkAuthorization = (user: MinimalUserData | null): boolean => {
    if (!user) return false;
    return user.username.toLowerCase() === 'nate';
  };

  // Get access token for API requests (from Oxy session)
  const getAccessToken = (): string | null => {
    // Oxy stores session in localStorage
    // The access token should be available from the Oxy SDK
    // For now, we'll try to get it from localStorage
    try {
      const oxyData = localStorage.getItem('oxy-session');
      if (oxyData) {
        const parsed = JSON.parse(oxyData);
        return parsed.accessToken || parsed.sessionId || null;
      }
    } catch (e) {
      console.error('[Auth] Failed to get access token:', e);
    }
    return null;
  };

  // Set up API client to use Oxy token
  useEffect(() => {
    apiClient.setTokenGetter(getAccessToken);
  }, []);

  // Check authorization whenever user changes
  useEffect(() => {
    if (isAuthenticated && user) {
      const authorized = checkAuthorization(user);
      setIsAuthorized(authorized);

      if (!authorized) {
        console.warn('[Auth] User not authorized:', user.username);
        setError(`Access denied. Only admin users can access this panel. (Your username: ${user.username})`);
        // Auto sign out unauthorized users after a delay
        setTimeout(() => {
          oxySignOut();
        }, 3000);
      } else {
        setError(null);
        console.log('[Auth] User authorized:', user.username);
      }
    } else {
      setIsAuthorized(false);
      setError(null);
    }
  }, [isAuthenticated, user, oxySignOut]);

  // Listen for unauthorized events from API client
  useEffect(() => {
    const handleUnauthorized = () => {
      console.log('[Auth] Unauthorized API call - signing out');
      oxySignOut();
    };

    window.addEventListener('auth:unauthorized', handleUnauthorized);
    return () => window.removeEventListener('auth:unauthorized', handleUnauthorized);
  }, [oxySignOut]);

  const signIn = async () => {
    setError(null);
    try {
      await oxySignIn();
      // Authorization check will happen in the useEffect above
    } catch (err) {
      console.error('[Auth] Sign in failed:', err);
      setError(err instanceof Error ? err.message : 'Sign in failed');
      throw err;
    }
  };

  const signOut = async () => {
    setError(null);
    try {
      await oxySignOut();
    } catch (err) {
      console.error('[Auth] Sign out failed:', err);
      setError(err instanceof Error ? err.message : 'Sign out failed');
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading: isLoading,
        isAuthorized,
        signIn,
        signOut,
        error,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}

// ==================== Convenience Hooks ====================

/**
 * Custom hook for current user data
 */
export function useCurrentUser() {
  const { user } = useAuth();
  return user;
}

/**
 * Custom hook for authentication state
 */
export function useAuthState() {
  const { user, loading, isAuthorized } = useAuth();
  return {
    isAuthenticated: !!user && isAuthorized,
    isLoading: loading,
    user,
  };
}

/**
 * Custom hook for protected routes
 * Automatically triggers sign-in if not authenticated
 */
export function useRequireAuth() {
  const { user, loading, isAuthorized, signIn } = useAuth();

  useEffect(() => {
    if (!loading && (!user || !isAuthorized)) {
      signIn();
    }
  }, [loading, user, isAuthorized, signIn]);

  return { user, loading, isAuthorized };
}
