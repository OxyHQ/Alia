import Svg, { Path } from "react-native-svg";
import { useColorScheme } from "@/lib/useColorScheme";

export interface LockShieldIconProps {
  size?: number;
  /** Icon color. Defaults to the theme muted foreground, as the sibling glyph components do. */
  color?: string;
}

/**
 * `lock-shield` — security and privacy.
 *
 * Generated from `scripts/icons/shell-sprites.svg`. Change `scripts/icons/manifest.ts`
 * and re-run `bun run generate:icons`; editing this file is reverted by the next run
 * and caught by `components/__tests__/generated-icons.test.ts`.
 */
export function LockShieldIcon({ size = 18, color }: LockShieldIconProps) {
  const { colors } = useColorScheme();
  const tint = color ?? colors.mutedForeground;
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20">
      <Path
        d="M12.88 13.24a1.417 1.417 0 1 1 0 2.834 1.417 1.417 0 0 1 0-2.835"
        fill={tint}
      />
      <Path
        d="M6.21 1.717a1.93 1.93 0 0 1 1.548 0l3.792 1.658a1.93 1.93 0 0 1 1.156 1.77v1.06q.087-.003.175-.004a3.91 3.91 0 0 1 3.911 3.911v.159a2.94 2.94 0 0 1 1.948 2.763v3.246a2.94 2.94 0 0 1-2.937 2.938H9.96a2.94 2.94 0 0 1-2.938-2.938v-1.064a1.3 1.3 0 0 1-.475-.08c-1.371-.474-2.687-1.17-3.667-2.202-.998-1.053-1.62-2.43-1.62-4.185V5.145c0-.767.454-1.462 1.157-1.77zm3.75 9.71c-.888 0-1.607.72-1.607 1.607v3.246c0 .888.72 1.608 1.607 1.608h5.843c.887 0 1.607-.72 1.607-1.608v-3.246c0-.887-.72-1.607-1.607-1.607zM7.225 2.936a.6.6 0 0 0-.482-.001L2.95 4.594a.6.6 0 0 0-.36.55V8.75c0 1.408.486 2.46 1.255 3.27.686.723 1.618 1.275 2.685 1.694l.466.172.005.002.021-.005v-.848c0-1.274.813-2.357 1.948-2.763v-.159c0-1.627.993-3.023 2.407-3.612V5.145a.6.6 0 0 0-.36-.551zM12.88 7.53a2.58 2.58 0 0 0-2.58 2.566h5.16a2.58 2.58 0 0 0-2.58-2.566"
        fill={tint}
        fillRule="evenodd"
        clipRule="evenodd"
      />
    </Svg>
  );
}
