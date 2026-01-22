"use client";

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { OxyServices, createCrossDomainAuth } from '@oxyhq/services';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://api.oxy.so';

const oxyServices = new OxyServices({ baseURL: API_URL });
const auth = createCrossDomainAuth(oxyServices);

interface User {
  _id: string;
  username?: string;
  name?: {
    first?: string;
    last?: string;
  };
  email?: string;
  avatar?: string;
}

interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  oxyServices: OxyServices;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const initAuth = async () => {
      try {
        const session = await auth.initialize();
        if (session?.user) {
          setUser(session.user as User);
        }
      } catch (error) {
        console.error('Auth initialization failed:', error);
      } finally {
        setIsLoading(false);
      }
    };
    initAuth();
  }, []);

  const signIn = useCallback(async () => {
    try {
      const session = await auth.signIn();
      if (session?.user) {
        setUser(session.user as User);
      }
    } catch (error) {
      console.error('Sign in failed:', error);
      throw error;
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      await oxyServices.logout();
      setUser(null);
    } catch (error) {
      console.error('Sign out failed:', error);
      throw error;
    }
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated: !!user,
        isLoading,
        signIn,
        signOut,
        oxyServices,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
