import { useQuery } from '@tanstack/react-query';
import { generateAPIUrl } from '../generate-api-url';
import { useAuthStore } from '../stores/auth-store';

export interface CreditsInfo {
  credits: number;
  freeCredits: number;
  dailyRefresh: number;
  lastRefresh: string;
}

function getAPIHeaders(): HeadersInit {
  const token = useAuthStore.getState().token;
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

async function fetchCredits(): Promise<CreditsInfo> {
  const apiUrl = generateAPIUrl('/credits');
  const response = await fetch(apiUrl, {
    method: 'GET',
    headers: getAPIHeaders(),
  });

  if (!response.ok) {
    throw new Error('Failed to fetch credits');
  }

  return await response.json();
}

export function useCredits() {
  return useQuery({
    queryKey: ['credits'],
    queryFn: fetchCredits,
    staleTime: 1000 * 60, // 1 minute
    retry: 2,
  });
}
