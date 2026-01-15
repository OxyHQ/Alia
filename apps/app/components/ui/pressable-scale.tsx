import { type ComponentProps, useMemo } from "react";
import { MotiPressable } from "moti/interactions";
import { cssInterop } from "nativewind";

export type PressableScaleProps = ComponentProps<typeof MotiPressable> & {
  scaleTo?: number;
  role?: string;
  className?: string;
};

const StyledMotiPressable = cssInterop(MotiPressable, { className: "style" });

export function PressableScale({
  scaleTo = 0.95,
  className,
  disabled,
  ...props
}: PressableScaleProps) {
  return (
    <StyledMotiPressable
      {...props}
      disabled={disabled}
      className={className}
      animate={useMemo(
        () =>
          ({ pressed }) => {
            "worklet";
            if (disabled) {
              return {};
            }
            return {
              scale: pressed ? scaleTo : 1,
            };
          },
        [disabled, scaleTo]
      )}
    />
  );
}
