import type React from 'react';

/**
 * Anything the app draws as an icon.
 *
 * `color`, not a NativeWind class. The app's own glyphs are an `Svg` whose fill
 * can only be a value, so a row that styled its icon by class would work for a
 * lucide icon and silently do nothing for one of ours — and the two sit in the
 * same lists. Taking the colour the same way is what lets a row hold either.
 * This is the SVG-prop case `AGENTS.md` sends to `useColorScheme().colors`.
 *
 * Lucide's `LucideIcon` satisfies it, so a list may hold both while the set is
 * being replaced glyph by glyph.
 */
export type IconComponent = React.ComponentType<{ size?: number; color?: string }>;
