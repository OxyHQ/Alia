import { Platform } from 'react-native';

export type AccentColorName = 'default' | 'blue' | 'green' | 'yellow' | 'pink' | 'orange';

export interface AccentPreset {
  name: AccentColorName;
  primary: string;
  hex: string;
  hue: number;
  saturation: number;
}

export const ACCENT_PRESETS: Record<AccentColorName, AccentPreset> = {
  default: { name: 'default', primary: '288 77% 62%', hex: '#ca52e9', hue: 288, saturation: 77 },
  blue:    { name: 'blue',    primary: '217 91% 60%', hex: '#3b82f6', hue: 217, saturation: 91 },
  green:   { name: 'green',   primary: '142 71% 45%', hex: '#22c55e', hue: 142, saturation: 71 },
  yellow:  { name: 'yellow',  primary: '45 93% 47%',  hex: '#eab308', hue: 45,  saturation: 93 },
  pink:    { name: 'pink',    primary: '330 81% 60%', hex: '#ec4899', hue: 330, saturation: 81 },
  orange:  { name: 'orange',  primary: '25 95% 53%',  hex: '#f97316', hue: 25,  saturation: 95 },
};

export const ACCENT_COLOR_NAMES: AccentColorName[] = ['default', 'blue', 'green', 'yellow', 'pink', 'orange'];

export function getAccentCSSVariables(
  preset: AccentPreset,
  mode: 'light' | 'dark'
): Record<string, string> {
  const { primary, hue, saturation } = preset;
  const chartLightness = mode === 'light'
    ? [85, 75, 65, 75, 65]
    : [85, 75, 65, 55, 45];

  return {
    '--primary': primary,
    '--ring': primary,
    '--sidebar-primary': primary,
    '--sidebar-ring': primary,
    '--chart-1': `${hue} ${saturation}% ${chartLightness[0]}%`,
    '--chart-2': `${hue} ${saturation}% ${chartLightness[1]}%`,
    '--chart-3': `${hue} ${saturation}% ${chartLightness[2]}%`,
    '--chart-4': `${hue} ${saturation}% ${chartLightness[3]}%`,
    '--chart-5': `${hue} ${saturation}% ${chartLightness[4]}%`,
  };
}

const CSS_VAR_NAMES = [
  '--primary', '--ring', '--sidebar-primary', '--sidebar-ring',
  '--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5',
];

export function applyAccentToDocument(accentColor: AccentColorName, resolvedMode: 'light' | 'dark') {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return;

  if (accentColor === 'default') {
    CSS_VAR_NAMES.forEach(v => document.documentElement.style.removeProperty(v));
    return;
  }

  const preset = ACCENT_PRESETS[accentColor];
  const vars = getAccentCSSVariables(preset, resolvedMode);
  Object.entries(vars).forEach(([key, value]) => {
    document.documentElement.style.setProperty(key, value);
  });
}
