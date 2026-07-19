import Svg, { G, Path } from "react-native-svg";
import { useColorScheme } from "@/lib/useColorScheme";

export interface GetAppIconProps {
  size?: number;
  /** Fill color. Defaults to the theme muted foreground to match the sibling footer icons. */
  color?: string;
}

/**
 * "Get the app" glyph. The source art sits shifted down-right in its box, so
 * both paths are wrapped in a <G> that recenters the content bounding box
 * (x[9.834→19.834], y[7.714→24]) into the 24×24 viewBox with even padding.
 */
const PATH_A =
  "M9.834 9.429v12.857c0 .943.75 1.714 1.666 1.714H14v-1.715h-2.5V9.429H14V7.714h-2.5c-.916 0-1.666.772-1.666 1.715zm10 0v12.857c0 .943-.75 1.714-1.667 1.714H14v-1.715h4.167V9.429H14V7.714h4.167c.917 0 1.667.772 1.667 1.715z";
const PATH_B = "M10.667 11.143H19v2.571h-8.333v-2.571z";
const RECENTER = "translate(12, 12) scale(1.228) translate(-14.834, -15.857)";

export function GetAppIcon({ size = 18, color }: GetAppIconProps) {
  const { colors } = useColorScheme();
  const fill = color ?? colors.mutedForeground;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <G transform={RECENTER}>
        <Path d={PATH_A} fill={fill} fillRule="evenodd" clipRule="evenodd" />
        <Path d={PATH_B} fill={fill} />
      </G>
    </Svg>
  );
}
