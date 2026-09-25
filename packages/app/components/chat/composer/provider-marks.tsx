import { RiComputerLine } from "@oxy.so/bloom/icons/RiComputerLine";
import { RiStarLine } from "@oxy.so/bloom/icons/RiStarLine";

/**
 * The model picker's rail marks for Alia's own two groups: the featured and
 * pinned models, and this account's devices. A publisher group has no mark of
 * Alia's making — the rail draws its initial.
 */
type MarkProps = { size: number; color: string };

export const FeaturedMark = ({ size, color }: MarkProps) => <RiStarLine width={size} height={size} fill={color} />;
export const DeviceMark = ({ size, color }: MarkProps) => <RiComputerLine width={size} height={size} fill={color} />;
