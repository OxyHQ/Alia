import Svg, { Path } from "react-native-svg";
import { useColorScheme } from "@/lib/useColorScheme";

export interface FilesIconProps {
  size?: number;
  /** Fill color. Defaults to the theme muted foreground, as the sibling glyph components do. */
  color?: string;
}

/** Material Symbols "files" — the agent's file system. */
const PATH =
  "M160-160q-33 0-56.5-23.5T80-240v-400q0-33 23.5-56.5T160-720h240l80-80h320q33 0 56.5 23.5T880-720v480q0 33-23.5 56.5T800-160H160Zm73-280h207v-207L233-440Zm-73-40 160-160H160v160Zm0 120v120h640v-480H520v280q0 33-23.5 56.5T440-360H160Zm280-160Z";

export function FilesIcon({ size = 18, color }: FilesIconProps) {
  const { colors } = useColorScheme();
  return (
    <Svg width={size} height={size} viewBox="0 -960 960 960">
      <Path d={PATH} fill={color ?? colors.mutedForeground} />
    </Svg>
  );
}
