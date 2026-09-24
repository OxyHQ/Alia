import { IdentityMark } from "@alia.onl/sdk";
import { RiComputerLine } from "@oxy.so/bloom/icons/RiComputerLine";
import { RiStackLine } from "@oxy.so/bloom/icons/RiStackLine";

/** The model picker's rail marks: Alia's flower, the catalogue, this device. */
type MarkProps = { size: number; color: string };

export const AliaMark = ({ size, color }: MarkProps) => <IdentityMark size={size} color={color} />;
export const ModelsMark = ({ size, color }: MarkProps) => <RiStackLine width={size} height={size} fill={color} />;
export const DeviceMark = ({ size, color }: MarkProps) => <RiComputerLine width={size} height={size} fill={color} />;
