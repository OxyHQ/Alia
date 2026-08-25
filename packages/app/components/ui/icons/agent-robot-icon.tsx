import Svg, { Path } from "react-native-svg";
import { useColorScheme } from "@/lib/useColorScheme";

export interface AgentRobotIconProps {
  size?: number;
  /** Icon color. Defaults to the theme muted foreground, as the sibling glyph components do. */
  color?: string;
}

/**
 * `agent-robot` — agents — the sidebar section and the delegation capability.
 *
 * Generated from `scripts/icons/shell-sprites.svg`. Change `scripts/icons/manifest.ts`
 * and re-run `bun run generate:icons`; editing this file is reverted by the next run
 * and caught by `components/__tests__/generated-icons.test.ts`.
 */
export function AgentRobotIcon({ size = 18, color }: AgentRobotIconProps) {
  const { colors } = useColorScheme();
  const tint = color ?? colors.mutedForeground;
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20">
      <Path
        d="M8.195 10.381c.423 0 .767.344.767.767v1.038a.768.768 0 0 1-1.534 0v-1.038c0-.423.344-.766.767-.767M11.715 10.381c.424 0 .767.344.767.767v1.038a.767.767 0 0 1-1.533 0v-1.038c0-.423.343-.766.766-.767"
        fill={tint}
      />
      <Path
        d="M10 1.667a1.694 1.694 0 0 1 .665 3.252v.884c1.425.028 2.833.145 4.24.368 1.299.207 2.394 1.182 2.623 2.529q.08.477.125.93a2.053 2.053 0 0 1 .03 4.068 15 15 0 0 1-.155 1.248c-.229 1.347-1.324 2.322-2.622 2.528A31 31 0 0 1 10 17.85c-1.653 0-3.28-.116-4.906-.375-1.298-.206-2.393-1.181-2.622-2.528a15 15 0 0 1-.155-1.248 2.052 2.052 0 0 1 .03-4.068q.045-.453.125-.93c.229-1.347 1.324-2.322 2.622-2.529a31 31 0 0 1 4.241-.368V4.92A1.693 1.693 0 0 1 10 1.667m0 5.46c-1.59 0-3.147.111-4.698.358-.786.125-1.394.702-1.518 1.436-.173 1.018-.202 1.945-.202 2.902l.006.714a15 15 0 0 0 .196 2.187c.124.734.732 1.311 1.518 1.437 1.551.246 3.108.358 4.698.358 1.589 0 3.146-.112 4.697-.358.786-.125 1.395-.703 1.52-1.437.172-1.018.201-1.944.202-2.901l-.008-.714a15 15 0 0 0-.195-2.188c-.124-.734-.733-1.311-1.52-1.436A30 30 0 0 0 10 7.126"
        fill={tint}
        fillRule="evenodd"
        clipRule="evenodd"
      />
    </Svg>
  );
}
