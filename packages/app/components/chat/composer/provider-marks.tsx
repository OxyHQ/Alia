import { AiProviderLogo } from "@oxy.so/bloom-ai-icons";
import { RiComputerLine } from "@oxy.so/bloom/icons/RiComputerLine";
import { RiStarLine } from "@oxy.so/bloom/icons/RiStarLine";

/**
 * The model picker's rail marks for Alia's own two groups: the featured and
 * pinned models, and this account's devices — plus each publisher's logo.
 */
type MarkProps = { size: number; color: string };

export const FeaturedMark = ({ size, color }: MarkProps) => <RiStarLine width={size} height={size} fill={color} />;
export const DeviceMark = ({ size, color }: MarkProps) => <RiComputerLine width={size} height={size} fill={color} />;

const publisherMarks = new Map<string, (props: MarkProps) => React.JSX.Element>();

/**
 * A publisher group's rail mark: the lab's logo, or its initial when there is
 * none. One component per publisher id, kept for the session, so the rail does
 * not remount its marks on every render of the lineup.
 */
export function publisherMark(publisherId: string): (props: MarkProps) => React.JSX.Element {
  let mark = publisherMarks.get(publisherId);
  if (mark === undefined) {
    mark = ({ size, color }: MarkProps) => <AiProviderLogo provider={publisherId} size={size} color={color} />;
    publisherMarks.set(publisherId, mark);
  }
  return mark;
}
