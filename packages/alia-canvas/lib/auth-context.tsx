"use client";

import React from 'react';
import { WebOxyProvider, useAuth as useOxyAuth } from '@oxyhq/auth';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://api.oxy.so';
const OXY_CLIENT_ID =
  process.env.NEXT_PUBLIC_OXY_CLIENT_ID ?? 'oxy_dk_06488927793f96922ef4f366a9800547b34c6aec025fece3';

export function AuthProvider({ children }: { children: React.ReactNode }) {
  return (
    <WebOxyProvider baseURL={API_URL} clientId={OXY_CLIENT_ID}>
      {children}
    </WebOxyProvider>
  );
}

export function useAuth() {
  return useOxyAuth();
}
