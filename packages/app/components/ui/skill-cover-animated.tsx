import React from "react";
import { useReducedMotion } from "react-native-reanimated";
import SkillCoverCanvas from "./skill-cover-canvas";
import SkillCoverStaticGrid from "./skill-cover-static";
import type { SkillCoverCanvasProps } from "./skill-cover-palette";

/**
 * The animated cover — the ONE place motion is allowed in.
 *
 * `SkillCover` reaches this module only through a lazy `import()`, and only
 * when a consumer passed `animated` on a native platform: the detail page's
 * single focused cover, never a shelf (#545). So this file may import the
 * graphics runtime statically, and nothing that mounts a static cover ever
 * loads it.
 *
 * Reduced motion is honoured here, at the last gate, because the person who
 * asked their OS for it did not ask per screen. `useReducedMotion` reads the
 * OS setting once and is a plain boolean; under it the cover is exactly the
 * static grid the catalogue shows, not a slower animation.
 *
 * `./skill-cover-canvas` resolves to the skia implementation on native and to
 * the static grid on web, so even a web consumer that somehow reached this
 * module would get no canvas.
 */
export default function SkillCoverAnimatedCanvas(props: SkillCoverCanvasProps) {
  const reducedMotion = useReducedMotion();
  if (reducedMotion) {
    return <SkillCoverStaticGrid {...props} />;
  }
  return <SkillCoverCanvas {...props} animated />;
}
