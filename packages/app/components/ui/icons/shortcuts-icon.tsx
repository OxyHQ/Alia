import Svg, { Path } from "react-native-svg";
import { useColorScheme } from "@/lib/useColorScheme";

export interface ShortcutsIconProps {
  size?: number;
  /** Icon color. Defaults to the theme muted foreground, as the sibling glyph components do. */
  color?: string;
}

/**
 * `shortcuts` — the keyboard shortcuts dialog.
 *
 * Generated from `scripts/icons/shell-sprites.svg`. Change `scripts/icons/manifest.ts`
 * and re-run `bun run generate:icons`; editing this file is reverted by the next run
 * and caught by `components/__tests__/generated-icons.test.ts`.
 */
export function ShortcutsIcon({ size = 18, color }: ShortcutsIconProps) {
  const { colors } = useColorScheme();
  const tint = color ?? colors.mutedForeground;
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20">
      <Path
        d="M15.995 7.33c0-.711 0-1.204-.032-1.588a2.4 2.4 0 0 0-.112-.615l-.056-.13a1.83 1.83 0 0 0-.676-.731l-.126-.07c-.158-.081-.37-.138-.745-.169-.383-.031-.877-.032-1.588-.032H7.33c-.711 0-1.204 0-1.588.032-.376.03-.587.088-.745.168a1.84 1.84 0 0 0-.802.802c-.08.158-.137.37-.168.745-.031.384-.032.877-.032 1.588v5.33c0 .711.001 1.204.032 1.588.031.376.088.587.168.745l.07.126c.177.288.43.522.732.676l.13.056c.144.051.333.089.615.112.384.031.877.032 1.588.032h5.33c.711 0 1.204 0 1.588-.032.376-.03.587-.088.745-.168l.126-.07c.288-.177.522-.43.676-.732l.056-.13a2.4 2.4 0 0 0 .112-.615c.031-.383.032-.877.032-1.588zm1.33 5.33c0 .69 0 1.246-.036 1.696-.033.401-.098.762-.242 1.098l-.067.143c-.265.52-.67.957-1.165 1.261l-.218.122c-.377.192-.783.272-1.24.309-.45.037-1.008.036-1.697.036H7.33c-.689 0-1.246 0-1.696-.036-.4-.033-.762-.098-1.098-.242l-.142-.067a3.17 3.17 0 0 1-1.262-1.166l-.122-.217c-.192-.377-.271-.783-.309-1.24-.037-.45-.036-1.008-.036-1.697V7.33c0-.69 0-1.246.036-1.696.038-.458.117-.864.309-1.24A3.17 3.17 0 0 1 4.394 3.01c.376-.192.782-.272 1.24-.309.45-.037 1.007-.036 1.696-.036h5.33c.69 0 1.246 0 1.696.036.458.038.864.117 1.24.309l.219.122c.496.304.9.74 1.165 1.261l.067.143c.144.336.21.697.242 1.098.037.45.036 1.007.036 1.696z"
        fill={tint}
      />
      <Path
        d="M7.427 10.604 9.9 6.854c.254-.385.853-.133.755.317l-.34 1.579h1.91c.332 0 .53.37.348.646l-2.475 3.75c-.254.385-.853.133-.755-.317l.34-1.579h-1.91a.417.417 0 0 1-.347-.646"
        fill={tint}
      />
    </Svg>
  );
}
