import { Platform } from 'react-native';

export type AppColorName = 'purple' | 'green' | 'blue';

export interface AppColorPreset {
  name: AppColorName;
  hex: string;
  light: Record<string, string>;
  dark: Record<string, string>;
}

export const APP_COLOR_NAMES: AppColorName[] = ['purple', 'green', 'blue'];

export const APP_COLOR_PRESETS: Record<AppColorName, AppColorPreset> = {
  purple: {
    name: 'purple',
    hex: '#cb53e9',
    light: {
      '--background': '0 0% 100%',
      '--foreground': '0 0% 0%',
      '--surface': '0 0% 98%',
      '--surface-foreground': '0 0% 0%',
      '--popover': '0 0% 100%',
      '--popover-foreground': '0 0% 0%',
      '--primary': '288 77% 62%',
      '--primary-foreground': '0 0% 100%',
      '--secondary': '0 0% 96%',
      '--secondary-foreground': '0 0% 0%',
      '--muted': '0 0% 96%',
      '--muted-foreground': '0 0% 45%',
      '--accent': '0 0% 96%',
      '--accent-foreground': '0 0% 0%',
      '--destructive': '0 84% 60%',
      '--border': '0 0% 90%',
      '--input': '0 0% 90%',
      '--ring': '288 77% 62%',
      '--chart-1': '288 77% 85%',
      '--chart-2': '288 77% 75%',
      '--chart-3': '288 77% 65%',
      '--chart-4': '288 77% 75%',
      '--chart-5': '288 77% 65%',
      '--sidebar': '0 0% 98%',
      '--sidebar-foreground': '0 0% 0%',
      '--sidebar-primary': '288 77% 62%',
      '--sidebar-primary-foreground': '0 0% 100%',
      '--sidebar-accent': '0 0% 96%',
      '--sidebar-accent-foreground': '0 0% 0%',
      '--sidebar-border': '0 0% 90%',
      '--sidebar-ring': '288 77% 62%',
    },
    dark: {
      '--background': '230 62% 4%',
      '--foreground': '0 0% 100%',
      '--surface': '217 26% 17%',
      '--surface-foreground': '0 0% 100%',
      '--popover': '217 26% 17%',
      '--popover-foreground': '0 0% 100%',
      '--primary': '288 77% 62%',
      '--primary-foreground': '0 0% 100%',
      '--secondary': '217 26% 17%',
      '--secondary-foreground': '0 0% 100%',
      '--muted': '217 26% 23%',
      '--muted-foreground': '0 0% 70%',
      '--accent': '217 26% 23%',
      '--accent-foreground': '0 0% 100%',
      '--destructive': '0 84% 60%',
      '--border': '0 0% 100% / 10%',
      '--input': '0 0% 100% / 15%',
      '--ring': '288 77% 62%',
      '--chart-1': '288 77% 85%',
      '--chart-2': '288 77% 75%',
      '--chart-3': '288 77% 65%',
      '--chart-4': '288 77% 55%',
      '--chart-5': '288 77% 45%',
      '--sidebar': '230 40% 8%',
      '--sidebar-foreground': '0 0% 100%',
      '--sidebar-primary': '288 77% 62%',
      '--sidebar-primary-foreground': '0 0% 100%',
      '--sidebar-accent': '230 40% 8%',
      '--sidebar-accent-foreground': '0 0% 100%',
      '--sidebar-border': '0 0% 100% / 10%',
      '--sidebar-ring': '288 77% 62%',
    },
  },

  green: {
    name: 'green',
    hex: '#015a30',
    light: {
      '--background': '0 0% 100%',
      '--foreground': '0 0% 0%',
      '--surface': '150 10% 97%',
      '--surface-foreground': '0 0% 0%',
      '--popover': '0 0% 100%',
      '--popover-foreground': '0 0% 0%',
      '--primary': '153 100% 18%',
      '--primary-foreground': '0 0% 100%',
      '--secondary': '150 8% 95%',
      '--secondary-foreground': '0 0% 0%',
      '--muted': '150 8% 95%',
      '--muted-foreground': '150 5% 42%',
      '--accent': '150 8% 95%',
      '--accent-foreground': '0 0% 0%',
      '--destructive': '0 84% 60%',
      '--border': '150 8% 88%',
      '--input': '150 8% 88%',
      '--ring': '153 100% 18%',
      '--chart-1': '153 60% 85%',
      '--chart-2': '153 60% 75%',
      '--chart-3': '153 60% 65%',
      '--chart-4': '153 60% 75%',
      '--chart-5': '153 60% 65%',
      '--sidebar': '150 10% 97%',
      '--sidebar-foreground': '0 0% 0%',
      '--sidebar-primary': '153 100% 18%',
      '--sidebar-primary-foreground': '0 0% 100%',
      '--sidebar-accent': '150 8% 95%',
      '--sidebar-accent-foreground': '0 0% 0%',
      '--sidebar-border': '150 8% 88%',
      '--sidebar-ring': '153 100% 18%',
    },
    dark: {
      '--background': '153 50% 5%',
      '--foreground': '0 0% 100%',
      '--surface': '155 20% 18%',
      '--surface-foreground': '0 0% 100%',
      '--popover': '155 20% 18%',
      '--popover-foreground': '0 0% 100%',
      '--primary': '153 100% 18%',
      '--primary-foreground': '0 0% 100%',
      '--secondary': '155 20% 18%',
      '--secondary-foreground': '0 0% 100%',
      '--muted': '155 18% 20%',
      '--muted-foreground': '0 0% 70%',
      '--accent': '155 18% 20%',
      '--accent-foreground': '0 0% 100%',
      '--destructive': '0 84% 60%',
      '--border': '0 0% 100% / 10%',
      '--input': '0 0% 100% / 15%',
      '--ring': '153 100% 18%',
      '--chart-1': '153 60% 85%',
      '--chart-2': '153 60% 75%',
      '--chart-3': '153 60% 65%',
      '--chart-4': '153 60% 55%',
      '--chart-5': '153 60% 45%',
      '--sidebar': '153 30% 8%',
      '--sidebar-foreground': '0 0% 100%',
      '--sidebar-primary': '153 100% 18%',
      '--sidebar-primary-foreground': '0 0% 100%',
      '--sidebar-accent': '153 30% 8%',
      '--sidebar-accent-foreground': '0 0% 100%',
      '--sidebar-border': '0 0% 100% / 10%',
      '--sidebar-ring': '153 100% 18%',
    },
  },

  blue: {
    name: 'blue',
    hex: '#3b82f6',
    light: {
      '--background': '0 0% 100%',
      '--foreground': '0 0% 0%',
      '--surface': '214 10% 97%',
      '--surface-foreground': '0 0% 0%',
      '--popover': '0 0% 100%',
      '--popover-foreground': '0 0% 0%',
      '--primary': '217 91% 60%',
      '--primary-foreground': '0 0% 100%',
      '--secondary': '214 8% 95%',
      '--secondary-foreground': '0 0% 0%',
      '--muted': '214 8% 95%',
      '--muted-foreground': '214 5% 42%',
      '--accent': '214 8% 95%',
      '--accent-foreground': '0 0% 0%',
      '--destructive': '0 84% 60%',
      '--border': '214 8% 88%',
      '--input': '214 8% 88%',
      '--ring': '217 91% 60%',
      '--chart-1': '217 80% 85%',
      '--chart-2': '217 80% 75%',
      '--chart-3': '217 80% 65%',
      '--chart-4': '217 80% 75%',
      '--chart-5': '217 80% 65%',
      '--sidebar': '214 10% 97%',
      '--sidebar-foreground': '0 0% 0%',
      '--sidebar-primary': '217 91% 60%',
      '--sidebar-primary-foreground': '0 0% 100%',
      '--sidebar-accent': '214 8% 95%',
      '--sidebar-accent-foreground': '0 0% 0%',
      '--sidebar-border': '214 8% 88%',
      '--sidebar-ring': '217 91% 60%',
    },
    dark: {
      '--background': '217 50% 5%',
      '--foreground': '0 0% 100%',
      '--surface': '220 25% 18%',
      '--surface-foreground': '0 0% 100%',
      '--popover': '220 25% 18%',
      '--popover-foreground': '0 0% 100%',
      '--primary': '217 91% 60%',
      '--primary-foreground': '0 0% 100%',
      '--secondary': '220 25% 18%',
      '--secondary-foreground': '0 0% 100%',
      '--muted': '220 20% 21%',
      '--muted-foreground': '0 0% 70%',
      '--accent': '220 20% 21%',
      '--accent-foreground': '0 0% 100%',
      '--destructive': '0 84% 60%',
      '--border': '0 0% 100% / 10%',
      '--input': '0 0% 100% / 15%',
      '--ring': '217 91% 60%',
      '--chart-1': '217 80% 85%',
      '--chart-2': '217 80% 75%',
      '--chart-3': '217 80% 65%',
      '--chart-4': '217 80% 55%',
      '--chart-5': '217 80% 45%',
      '--sidebar': '217 30% 8%',
      '--sidebar-foreground': '0 0% 100%',
      '--sidebar-primary': '217 91% 60%',
      '--sidebar-primary-foreground': '0 0% 100%',
      '--sidebar-accent': '217 30% 8%',
      '--sidebar-accent-foreground': '0 0% 100%',
      '--sidebar-border': '0 0% 100% / 10%',
      '--sidebar-ring': '217 91% 60%',
    },
  },
};

const ALL_CSS_VAR_NAMES = Object.keys(APP_COLOR_PRESETS.purple.light);

export function getAppColorCSSVariables(
  preset: AppColorPreset,
  mode: 'light' | 'dark',
): Record<string, string> {
  return mode === 'light' ? preset.light : preset.dark;
}

export function applyAppColorToDocument(
  colorName: AppColorName,
  resolvedMode: 'light' | 'dark',
) {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return;

  if (colorName === 'purple') {
    // Purple is the default in global.css — remove any overrides
    ALL_CSS_VAR_NAMES.forEach((v) =>
      document.documentElement.style.removeProperty(v),
    );
    return;
  }

  const preset = APP_COLOR_PRESETS[colorName];
  const vars = getAppColorCSSVariables(preset, resolvedMode);
  Object.entries(vars).forEach(([key, value]) => {
    document.documentElement.style.setProperty(key, value);
  });
}
