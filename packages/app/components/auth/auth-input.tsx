import * as React from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface AuthInputProps extends React.ComponentPropsWithoutRef<typeof Input> {
  // Additional auth-specific props can be added here
}

const AuthInput = React.forwardRef<
  React.ElementRef<typeof Input>,
  AuthInputProps
>(({ className, ...props }, ref) => {
  return (
    <Input
      ref={ref}
      className={cn(
        "h-12 text-base rounded-full bg-muted/50 border-0 px-4",
        className
      )}
      {...props}
    />
  );
});

AuthInput.displayName = "AuthInput";

export { AuthInput };
