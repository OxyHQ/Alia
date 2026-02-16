"use client";

import React from 'react';
import { WebOxyProvider, useAuth as useOxyAuth } from '@oxyhq/auth';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://api.oxy.so';

export function AuthProvider({ children }: { children: React.ReactNode }) {
  return (
    <WebOxyProvider baseURL={API_URL}>
      {children}
    </WebOxyProvider>
  );
}

export function useAuth() {
  return useOxyAuth();
}
