import Svg, { Path } from "react-native-svg";
import { useColorScheme } from "@/lib/useColorScheme";

export interface MicrophoneIconProps {
  size?: number;
  /** Icon color. Defaults to the theme muted foreground, as the sibling glyph components do. */
  color?: string;
}

/**
 * `microphone-regular-24` — Shows.
 *
 * Generated from `scripts/icons/shell-sprites.svg`. Change `scripts/icons/manifest.ts`
 * and re-run `bun run generate:icons`; editing this file is reverted by the next run
 * and caught by `components/__tests__/generated-icons.test.ts`.
 */
export function MicrophoneIcon({ size = 18, color }: MicrophoneIconProps) {
  const { colors } = useColorScheme();
  const tint = color ?? colors.mutedForeground;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M18.585 13.412a.9.9 0 0 1 1.668.676 8.91 8.91 0 0 1-7.353 5.516V22a.9.9 0 0 1-1.8 0v-2.396a8.91 8.91 0 0 1-7.352-5.516.9.9 0 0 1 1.668-.676 7.104 7.104 0 0 0 13.169 0"
        fill={tint}
      />
      <Path
        d="M12 1.35a4.9 4.9 0 0 1 4.9 4.9v4.483a4.9 4.9 0 0 1-9.8 0V6.25a4.9 4.9 0 0 1 4.9-4.9m0 1.8a3.1 3.1 0 0 0-3.1 3.1v4.483a3.1 3.1 0 1 0 6.2 0V6.25a3.1 3.1 0 0 0-3.1-3.1"
        fill={tint}
        fillRule="evenodd"
        clipRule="evenodd"
      />
    </Svg>
  );
}
