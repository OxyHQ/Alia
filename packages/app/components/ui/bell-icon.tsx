import Svg, { Path } from "react-native-svg";
import { useColorScheme } from "@/lib/useColorScheme";

export interface BellIconProps {
  size?: number;
  /** Fill color. Defaults to the theme muted foreground to match the sibling footer icons. */
  color?: string;
}

/** Notification bell — shared with Mention's sidebar for a consistent icon set. */
const PATH =
  "M19.993 9.042C19.48 5.017 16.054 2 11.996 2s-7.49 3.021-7.999 7.051L2.866 18H7.1c.463 2.282 2.481 4 4.9 4s4.437-1.718 4.9-4h4.236l-1.143-8.958zM12 20c-1.306 0-2.417-.835-2.829-2h5.658c-.412 1.165-1.523 2-2.829 2zm-6.866-4l.847-6.698C6.364 6.272 8.941 4 11.996 4s5.627 2.268 6.013 5.295L18.864 16H5.134z";

export function BellIcon({ size = 18, color }: BellIconProps) {
  const { colors } = useColorScheme();
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d={PATH} fill={color ?? colors.mutedForeground} />
    </Svg>
  );
}
