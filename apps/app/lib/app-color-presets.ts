import { APP_COLOR_PRESETS, type AppColorName } from '@oxyhq/bloom';

/**
 * Return the scoped CSS variables for a color preset / resolved mode pair,
 * shaped for NativeWind's `vars()` helper. Bloom owns the preset palette;
 * this helper exists only to bridge Bloom's token map into a per-subtree
 * NativeWind variable scope on native (web is handled by Bloom directly via
 * `applyColorPresetVars` writing to `document.documentElement`).
 */
export function getScopedColorCSSVariables(
  preset: AppColorName,
  mode: 'light' | 'dark',
): Record<string, string> {
  const config = APP_COLOR_PRESETS[preset];
  return mode === 'dark' ? config.dark : config.light;
}
