import React from 'react';
import type { BloomIconComponent } from '@oxy.so/bloom/icons';

import type { IconComponent } from '@/lib/types/icon';

/**
 * One of Alia's glyphs, as a glyph Bloom will draw.
 *
 * The two families disagree on three prop names and nothing else. Alia's icons
 * take `{ size, color }` — `lib/types/icon.ts` explains why the colour is a
 * VALUE and not a class — and Bloom hands an icon `{ width, height, fill }`,
 * because its own Remix set is generated with those names. A square is a square
 * either way, so the adapter is the whole of the difference: one size in, one
 * size out.
 *
 * Memoised per source component, and that matters more than it looks. Bloom's
 * `SidebarItem` is `memo`'d and takes `icon` as a prop, so building the wrapper
 * at the call site would hand it a new component identity on every render —
 * which defeats the memo AND remounts the SVG underneath it, on a sidebar that
 * re-renders whenever a conversation list page lands. The cache keys on the
 * source component, which is a module-level constant in every case here, so
 * each glyph is wrapped exactly once for the life of the process.
 *
 * `width` is what is honoured when the two differ. Bloom always passes a
 * square (`metrics.row.icon` for both), and Alia's icons take one number, so
 * there is no shape here that could want anything else.
 */
const wrapped = new WeakMap<IconComponent, BloomIconComponent>();

export function bloomIcon(Icon: IconComponent): BloomIconComponent {
  const existing = wrapped.get(Icon);
  if (existing !== undefined) return existing;

  const Adapted: BloomIconComponent = ({ width, height, fill }) => (
    <Icon size={width ?? height} color={fill} />
  );
  Adapted.displayName = `bloomIcon(${Icon.displayName ?? Icon.name ?? 'Icon'})`;

  wrapped.set(Icon, Adapted);
  return Adapted;
}
