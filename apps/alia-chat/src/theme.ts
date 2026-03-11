import { useMemo } from 'react';
import { Platform, useColorScheme } from 'react-native';

// ── Fallback colors (used on native or when CSS vars aren't available) ──────

const FALLBACK_COLORS = {
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
    background: '#151515',
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

// ── CSS variable reading (web only) ─────────────────────────────────────────

/** Convert HSL space-separated value "275 50% 5%" to "hsl(275, 50%, 5%)".
 *  Also handles alpha syntax "0 0% 100% / 10%" → "hsla(0, 0%, 100%, 0.1)".
 *  Returns non-HSL values (hex, rgb, etc.) unchanged. */
function hslVarToCSS(value: string): string {
  if (value.startsWith('hsl') || value.startsWith('rgb') || value.startsWith('#') || value.startsWith('oklch')) {
    return value;
  }
  const parts = value.split('/').map((s) => s.trim());
  if (parts.length === 2) {
    const alpha = parseFloat(parts[1]) / 100;
    return `hsla(${parts[0].replace(/ /g, ', ')}, ${alpha})`;
  }
  return `hsl(${value.replace(/ /g, ', ')})`;
}

/** Read all needed CSS variables from :root in a single getComputedStyle call */
function readCSSColors(fallbacks: typeof FALLBACK_COLORS['light']): Omit<AliaColors, 'isDark'> {
  if (Platform.OS !== 'web' || typeof document === 'undefined') {
    return { ...fallbacks };
  }
  const style = getComputedStyle(document.documentElement);
  const get = (name: string, fallback: string): string => {
    const v = style.getPropertyValue(name).trim();
    return v ? hslVarToCSS(v) : fallback;
  };
  return {
    text: get('--foreground', fallbacks.text),
    background: get('--background', fallbacks.background),
    card: get('--surface', fallbacks.card),
    inputBackground: get('--input', fallbacks.inputBackground),
    border: get('--border', fallbacks.border),
    secondaryText: get('--muted-foreground', fallbacks.secondaryText),
    icon: get('--muted-foreground', fallbacks.icon),
    tint: get('--primary', fallbacks.tint),
    muted: get('--muted', fallbacks.muted),
    mutedForeground: get('--muted-foreground', fallbacks.mutedForeground),
    primary: get('--primary', fallbacks.primary),
  };
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useAliaColors(): AliaColors {
  const scheme = useColorScheme();
  const key = scheme === 'dark' ? 'dark' : 'light';
  const fb = FALLBACK_COLORS[key];

  return useMemo(() => ({
    ...readCSSColors(fb),
    isDark: key === 'dark',
  }), [key, fb]);
}
