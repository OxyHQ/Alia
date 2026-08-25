import Svg, { Path } from "react-native-svg";
import { useColorScheme } from "@/lib/useColorScheme";

export interface Robot2IconProps {
  size?: number;
  /** Fill color. Defaults to the theme muted foreground, as the sibling glyph components do. */
  color?: string;
}

/** Material Symbols "robot_2" — agent delegation. */
const PATH =
  "M151.87-111.87v-196.65q0-37.78 26.61-64.39t64.39-26.61h474.26q37.78 0 64.39 26.61t26.61 64.39v196.65H151.87Zm204.06-327.65q-84.91 0-144.6-59.7-59.7-59.69-59.7-144.61 0-84.91 59.7-144.6 59.69-59.7 144.6-59.7h247.9q84.91 0 144.6 59.7 59.7 59.69 59.7 144.6 0 84.92-59.7 144.61-59.69 59.7-144.6 59.7h-247.9Zm31.49-172.82q12.82-12.81 12.82-31.49 0-18.67-12.82-31.49-12.81-12.81-31.49-12.81-18.67 0-31.48 12.81-12.82 12.82-12.82 31.49 0 18.68 12.82 31.49 12.81 12.82 31.48 12.82 18.68 0 31.49-12.82Zm247.9 0q12.81-12.81 12.81-31.49 0-18.67-12.81-31.49-12.82-12.81-31.49-12.81-18.68 0-31.49 12.81-12.82 12.82-12.82 31.49 0 18.68 12.82 31.49 12.81 12.82 31.49 12.82 18.67 0 31.49-12.82Z";

export function Robot2Icon({ size = 18, color }: Robot2IconProps) {
  const { colors } = useColorScheme();
  return (
    <Svg width={size} height={size} viewBox="0 -960 960 960">
      <Path d={PATH} fill={color ?? colors.mutedForeground} />
    </Svg>
  );
}
