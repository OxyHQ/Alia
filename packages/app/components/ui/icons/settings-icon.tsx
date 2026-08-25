import Svg, { Path } from "react-native-svg";
import { useColorScheme } from "@/lib/useColorScheme";

export interface SettingsIconProps {
  size?: number;
  /** Icon color. Defaults to the theme muted foreground, as the sibling glyph components do. */
  color?: string;
}

/**
 * `settings-cog` — Settings.
 *
 * Generated from `scripts/icons/shell-sprites.svg`. Change `scripts/icons/manifest.ts`
 * and re-run `bun run generate:icons`; editing this file is reverted by the next run
 * and caught by `components/__tests__/generated-icons.test.ts`.
 */
export function SettingsIcon({ size = 18, color }: SettingsIconProps) {
  const { colors } = useColorScheme();
  const tint = color ?? colors.mutedForeground;
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20">
      <Path
        d="M10 6.587a3.417 3.417 0 1 1 0 6.834 3.417 3.417 0 0 1 0-6.834m0 1.33A2.087 2.087 0 1 0 10 12.091 2.087 2.087 0 0 0 10 7.917"
        fill={tint}
      />
      <Path
        d="M10.746 1.49a1.7 1.7 0 0 1 1.474.851l.986 1.718a.37.37 0 0 0 .318.184h1.983a1.7 1.7 0 0 1 1.472.848l.736 1.277a1.7 1.7 0 0 1 .006 1.688l-1.105 1.945 1.105 1.944a1.7 1.7 0 0 1-.006 1.687l-.736 1.277a1.7 1.7 0 0 1-1.472.85h-1.983a.37.37 0 0 0-.318.182l-.987 1.718a1.7 1.7 0 0 1-1.473.851H9.253a1.7 1.7 0 0 1-1.472-.852l-.988-1.717a.37.37 0 0 0-.317-.183H4.493a1.7 1.7 0 0 1-1.472-.85l-.736-1.275a1.7 1.7 0 0 1-.006-1.688L3.385 10 2.279 8.056a1.7 1.7 0 0 1 .006-1.688l.737-1.277a1.7 1.7 0 0 1 1.471-.85l1.983.002c.131 0 .253-.07.318-.184l.987-1.718a1.7 1.7 0 0 1 1.473-.851zM9.254 2.82a.37.37 0 0 0-.32.184l-.988 1.72c-.303.526-.864.849-1.47.849H4.493a.37.37 0 0 0-.32.183l-.736 1.277a.37.37 0 0 0-.002.366l1.291 2.27q.064.116.082.245l.005.087a.7.7 0 0 1-.087.33l-1.29 2.271a.37.37 0 0 0 .001.366l.737 1.276a.37.37 0 0 0 .32.184h1.982c.606 0 1.167.323 1.47.85l.989 1.719a.37.37 0 0 0 .319.184h1.492a.37.37 0 0 0 .32-.184l.988-1.72c.303-.526.864-.849 1.47-.849h1.983a.37.37 0 0 0 .32-.184l.735-1.276a.37.37 0 0 0 .002-.367l-1.29-2.27a.67.67 0 0 1 0-.66l1.29-2.272a.37.37 0 0 0 0-.366l-.738-1.277a.37.37 0 0 0-.32-.183h-1.982a1.7 1.7 0 0 1-1.47-.85c-.322-.558-.72-1.253-.988-1.719a.37.37 0 0 0-.319-.184z"
        fill={tint}
      />
    </Svg>
  );
}
