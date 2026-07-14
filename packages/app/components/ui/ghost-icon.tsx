import Svg, { Path, Circle } from "react-native-svg";
import { useColorScheme } from "@/lib/useColorScheme";

export interface GhostIconProps {
  size?: number;
  /** Solid silhouette with punched-out eyes; stroke outline when false. */
  filled?: boolean;
  /** Body color. Defaults to theme foreground (filled) / muted foreground (outline). */
  color?: string;
  /** Eye punch-out color in the filled state. Defaults to the theme background. */
  eyeColor?: string;
}

/** Lucide "ghost" body, kept so the outline state matches the icon set. */
const BODY_PATH =
  "M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 21l3 3V10a8 8 0 0 0-8-8z";

/**
 * Ghost-mode icon with a real filled state — lucide icons are single-color, so
 * the active silhouette (body filled, eyes knocked out) needs its own SVG.
 */
export function GhostIcon({ size = 20, filled = false, color, eyeColor }: GhostIconProps) {
  const { colors } = useColorScheme();
  const body = color ?? (filled ? colors.foreground : colors.mutedForeground);
  const eyes = filled ? (eyeColor ?? colors.background) : body;

  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d={BODY_PATH}
        fill={filled ? body : "none"}
        stroke={body}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Circle cx={9} cy={10} r={1.25} fill={eyes} />
      <Circle cx={15} cy={10} r={1.25} fill={eyes} />
    </Svg>
  );
}
