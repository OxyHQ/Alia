import { AiProviderLogo, hasAiProviderLogo } from "@oxy.so/bloom-ai-icons";
import { RiComputerLine } from "@oxy.so/bloom/icons/RiComputerLine";
import { RiStarLine } from "@oxy.so/bloom/icons/RiStarLine";

/**
 * The model picker's rail marks for Alia's own two groups: the featured and
 * pinned models, and this account's devices — plus each publisher's logo.
 */
type MarkProps = { size: number; color: string };

export const FeaturedMark = ({ size, color }: MarkProps) => <RiStarLine width={size} height={size} fill={color} />;
export const DeviceMark = ({ size, color }: MarkProps) => <RiComputerLine width={size} height={size} fill={color} />;

/**
 * A publisher group's rail mark: the lab's logo, or `undefined` when there is
 * none so the rail draws its own initial, the same as for any other group.
 * Bloom calls the mark as a function, so a fresh one per lineup costs nothing.
 */
export function publisherMark(publisherId: string): ((props: MarkProps) => React.JSX.Element) | undefined {
  if (!hasAiProviderLogo(publisherId)) return undefined;
  return ({ size, color }: MarkProps) => <AiProviderLogo provider={publisherId} size={size} color={color} />;
}
