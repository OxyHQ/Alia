import Svg, { Path } from "react-native-svg";
import { useColorScheme } from "@/lib/useColorScheme";

export interface PencilIconProps {
  size?: number;
  /** Icon color. Defaults to the theme muted foreground, as the sibling glyph components do. */
  color?: string;
}

/**
 * `pencil` — writing style.
 *
 * Generated from `scripts/icons/shell-sprites.svg`. Change `scripts/icons/manifest.ts`
 * and re-run `bun run generate:icons`; editing this file is reverted by the next run
 * and caught by `components/__tests__/generated-icons.test.ts`.
 */
export function PencilIcon({ size = 18, color }: PencilIconProps) {
  const { colors } = useColorScheme();
  const tint = color ?? colors.mutedForeground;
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20">
      <Path
        d="M11.626 3.304c1.426-1.423 3.694-1.394 5.054-.009 1.403 1.355 1.45 3.633.01 5.073l-7 7h-.002a5.2 5.2 0 0 1-2.572 1.47v.002l-3.868.888-.001-.002c-.167.04-.505.073-.774-.196-.271-.27-.237-.61-.197-.777h-.002l.89-3.857A5.25 5.25 0 0 1 4.6 10.327zm-6.084 7.965c-.54.539-.917 1.19-1.081 1.922l-.001.003-.704 3.052 3.061-.703a3.88 3.88 0 0 0 1.92-1.102l5.657-5.66-3.182-3.183zm10.2-7.033c-.838-.863-2.266-.9-3.177.01l-.413.411 3.183 3.184.414-.413c.917-.917.874-2.34.009-3.176z"
        fill={tint}
      />
    </Svg>
  );
}
