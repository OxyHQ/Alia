import Svg, { Path } from "react-native-svg";
import { useColorScheme } from "@/lib/useColorScheme";

export interface ProjectsIconProps {
  size?: number;
  /** Icon color. Defaults to the theme muted foreground, as the sibling glyph components do. */
  color?: string;
}

/**
 * `sidebar-projects` — Projects.
 *
 * Generated from `scripts/icons/shell-sprites.svg`. Change `scripts/icons/manifest.ts`
 * and re-run `bun run generate:icons`; editing this file is reverted by the next run
 * and caught by `components/__tests__/generated-icons.test.ts`.
 */
export function ProjectsIcon({ size = 18, color }: ProjectsIconProps) {
  const { colors } = useColorScheme();
  const tint = color ?? colors.mutedForeground;
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20">
      <Path
        d="M6.95 2.668c.633 0 1.25.2 1.763.573l1.065.775c.285.207.628.32.981.32h4.2a3 3 0 0 1 2.997 2.997v7a3 3 0 0 1-2.998 2.998H5.041a3 3 0 0 1-2.998-2.998V5.666a3 3 0 0 1 2.998-2.998zM3.372 9.832v4.501c0 .922.747 1.668 1.668 1.668h9.917c.922 0 1.668-.746 1.668-1.668v-4.5zm1.668-5.834c-.92 0-1.668.747-1.668 1.668v2.836h13.253V7.333c0-.921-.746-1.668-1.668-1.668H10.76a3 3 0 0 1-1.764-.574l-1.064-.773a1.67 1.67 0 0 0-.982-.32z"
        fill={tint}
      />
    </Svg>
  );
}
