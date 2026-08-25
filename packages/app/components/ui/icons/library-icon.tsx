import Svg, { Path } from "react-native-svg";
import { useColorScheme } from "@/lib/useColorScheme";

export interface LibraryIconProps {
  size?: number;
  /** Icon color. Defaults to the theme muted foreground, as the sibling glyph components do. */
  color?: string;
}

/**
 * `sidebar-library` — the Library.
 *
 * Generated from `scripts/icons/shell-sprites.svg`. Change `scripts/icons/manifest.ts`
 * and re-run `bun run generate:icons`; editing this file is reverted by the next run
 * and caught by `components/__tests__/generated-icons.test.ts`.
 */
export function LibraryIcon({ size = 18, color }: LibraryIconProps) {
  const { colors } = useColorScheme();
  const tint = color ?? colors.mutedForeground;
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20">
      <Path
        d="M14.402 2.648a2.2 2.2 0 0 1 2.547 1.783l1.782 10.11a2.2 2.2 0 0 1-1.782 2.547l-1.494.263a2.2 2.2 0 0 1-2.547-1.782l-.856-4.86v4.424a2.2 2.2 0 0 1-2.199 2.199H8.337a2.2 2.2 0 0 1-1.534-.626 2.2 2.2 0 0 1-1.533.626H3.754a2.2 2.2 0 0 1-2.199-2.199V4.867c0-1.214.985-2.198 2.199-2.198H5.27a2.2 2.2 0 0 1 1.533.624 2.2 2.2 0 0 1 1.534-.624h1.516c.746 0 1.405.372 1.802.94.317-.354.75-.608 1.254-.697zm1.237 2.014a.87.87 0 0 0-1.005-.704l-1.495.263a.87.87 0 0 0-.704 1.006l1.784 10.11a.87.87 0 0 0 1.005.705l1.494-.264a.867.867 0 0 0 .704-1.005zM3.754 3.999a.87.87 0 0 0-.868.868v10.266c0 .48.388.869.868.869H5.27c.48 0 .868-.39.868-.869V4.867a.87.87 0 0 0-.868-.868zm4.583 0a.87.87 0 0 0-.868.868v10.266c0 .48.388.868.868.869h1.516c.48 0 .868-.39.868-.869V4.867a.87.87 0 0 0-.868-.868z"
        fill={tint}
      />
    </Svg>
  );
}
