import Svg, { Path } from "react-native-svg";
import { useColorScheme } from "@/lib/useColorScheme";

export interface UpgradePlanIconProps {
  size?: number;
  /** Icon color. Defaults to the theme muted foreground, as the sibling glyph components do. */
  color?: string;
}

/**
 * `upgrade-plan` — upgrading the plan.
 *
 * Generated from `scripts/icons/shell-sprites.svg`. Change `scripts/icons/manifest.ts`
 * and re-run `bun run generate:icons`; editing this file is reverted by the next run
 * and caught by `components/__tests__/generated-icons.test.ts`.
 */
export function UpgradePlanIcon({ size = 18, color }: UpgradePlanIconProps) {
  const { colors } = useColorScheme();
  const tint = color ?? colors.mutedForeground;
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20">
      <Path
        d="M8.448 8.218a.251.251 0 0 1 .477 0l.363 1.09a1.76 1.76 0 0 0 1.113 1.113l1.09.363c.23.077.23.401 0 .478l-1.09.363a1.76 1.76 0 0 0-1.113 1.114l-.363 1.09a.251.251 0 0 1-.477 0l-.363-1.09a1.76 1.76 0 0 0-1.113-1.114l-1.09-.363a.252.252 0 0 1 0-.478l1.09-.363a1.76 1.76 0 0 0 1.113-1.113zM12.072 6.108a.157.157 0 0 1 .298 0l.228.68a1.1 1.1 0 0 0 .695.697l.682.226a.158.158 0 0 1 0 .299l-.682.227a1.1 1.1 0 0 0-.695.696l-.228.68a.157.157 0 0 1-.298 0l-.226-.68a1.1 1.1 0 0 0-.697-.696l-.68-.227a.158.158 0 0 1 0-.299l.68-.226c.329-.11.587-.368.697-.697z"
        fill={tint}
      />
      <Path
        d="M9.001 1.818a2.27 2.27 0 0 1 2.132.07l5.326 3.076.128.08a2.27 2.27 0 0 1 1.004 1.881v6.15c0 .759-.38 1.464-1.004 1.882l-.128.08-5.326 3.075a2.27 2.27 0 0 1-2.132.07l-.133-.07-5.327-3.076a2.27 2.27 0 0 1-1.132-1.96V6.924c0-.809.432-1.556 1.132-1.96l5.327-3.076zm1.467 1.222a.94.94 0 0 0-.823-.054l-.112.054-5.327 3.075a.94.94 0 0 0-.467.81v6.15c0 .334.178.643.467.81l5.327 3.075.112.055c.265.11.57.091.823-.055l5.326-3.075.104-.07a.94.94 0 0 0 .363-.74v-6.15a.94.94 0 0 0-.363-.74l-.104-.07z"
        fill={tint}
        fillRule="evenodd"
        clipRule="evenodd"
      />
    </Svg>
  );
}
