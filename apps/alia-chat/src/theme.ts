import { useMemo } from 'react';
import { useColorScheme } from 'react-native';

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
  primary10: string;
  isDark: boolean;
}

const COLORS: Omit<AliaColors, 'isDark'> = {
  text: 'hsl(var(--foreground))',
  background: 'hsl(var(--background))',
  card: 'hsl(var(--surface))',
  inputBackground: 'hsl(var(--input))',
  border: 'hsl(var(--border))',
  secondaryText: 'hsl(var(--muted-foreground))',
  icon: 'hsl(var(--muted-foreground))',
  tint: 'hsl(var(--primary))',
  muted: 'hsl(var(--muted))',
  mutedForeground: 'hsl(var(--muted-foreground))',
  primary: 'hsl(var(--primary))',
  primary10: 'hsl(var(--primary) / 0.1)',
};

export function useAliaColors(): AliaColors {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  return useMemo(() => ({ ...COLORS, isDark }), [isDark]);
}
