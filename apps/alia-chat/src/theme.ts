import { useMemo } from 'react';
import { useColorScheme } from 'react-native';

const COLORS = {
  light: {
    text: '#11181C',
    background: '#fff',
    card: '#F2F2F7',
    inputBackground: '#F5F5F5',
    border: '#E5E5EA',
    secondaryText: '#8E8E93',
    icon: '#687076',
    tint: '#0a7ea4',
    muted: '#F4F4F5',
    mutedForeground: '#71717A',
    primary: '#0a7ea4',
  },
  dark: {
    text: '#ECEDEE',
    background: '#000000',
    card: '#1C1C1E',
    inputBackground: '#333333',
    border: '#2C2C2E',
    secondaryText: '#8E8E93',
    icon: '#9BA1A6',
    tint: '#fff',
    muted: '#27272A',
    mutedForeground: '#A1A1AA',
    primary: '#38BDF8',
  },
} as const;

export interface AliaColors {
  text: string;
  background: string;
  card: string;
  inputBackground: string;
  border: string;
  secondaryText: string;
  icon: string;
  tint: string;
  muted: string;
  mutedForeground: string;
  primary: string;
  isDark: boolean;
}

export function useAliaColors(): AliaColors {
  const scheme = useColorScheme();
  const key = scheme === 'dark' ? 'dark' : 'light';
  return useMemo(() => ({
    ...COLORS[key],
    isDark: key === 'dark',
  }), [key]);
}
