import Svg, { Path } from "react-native-svg";
import { useColorScheme } from "@/lib/useColorScheme";

export interface SkillsIconProps {
  size?: number;
  /** Icon color. Defaults to the theme muted foreground, as the sibling glyph components do. */
  color?: string;
}

/**
 * `skills` — Skills.
 *
 * Generated from `scripts/icons/shell-sprites.svg`. Change `scripts/icons/manifest.ts`
 * and re-run `bun run generate:icons`; editing this file is reverted by the next run
 * and caught by `components/__tests__/generated-icons.test.ts`.
 */
export function SkillsIcon({ size = 18, color }: SkillsIconProps) {
  const { colors } = useColorScheme();
  const tint = color ?? colors.mutedForeground;
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20">
      <Path
        d="M9.548 1.862a3.17 3.17 0 0 1 3.373.105l2.182 1.47a3.17 3.17 0 0 1 1.396 2.625v6.646a3.17 3.17 0 0 1-1.564 2.73l-4.6 2.7a3.17 3.17 0 0 1-3.372-.106l-2.066-1.394a3.17 3.17 0 0 1-1.396-2.624V7.227c0-1.122.595-2.161 1.562-2.73zm-.116 12.126a2 2 0 0 1-.141.07v3.098a2 2 0 0 0 .372-.166l4.6-2.699c.56-.33.905-.932.906-1.583v-2.094zm-4.6.026c0 .61.303 1.18.808 1.521l2.068 1.395q.122.081.252.14v-3.058a2 2 0 0 1-.127-.075l-3.001-2.031zm4.6-4.756a2 2 0 0 1-.141.071v3.198L15 9.17a.7.7 0 0 1 .168-.067V6.062q-.002-.087-.011-.172zm-4.6-2.031v3.072l3.128 2.12V9.281a2 2 0 0 1-.127-.075l-3-2.027zm7.346-4.157a1.84 1.84 0 0 0-1.956-.061L5.737 5.645a1.8 1.8 0 0 0-.373.289l3.215 2.172a.17.17 0 0 0 .178.006l5.803-3.413a2 2 0 0 0-.201-.159z"
        fill={tint}
      />
    </Svg>
  );
}
