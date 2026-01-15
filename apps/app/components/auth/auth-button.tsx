import * as React from "react";
import { Button, ButtonProps } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

export interface AuthButtonProps extends ButtonProps {
  isLoading?: boolean;
  loadingText?: string;
  children?: React.ReactNode;
}

const AuthButton = React.forwardRef<
  React.ElementRef<typeof Button>,
  AuthButtonProps
>(({ className, isLoading, loadingText, children, ...props }, ref) => {
  return (
    <Button
      ref={ref}
      className={cn("h-12 rounded-full", className)}
      isLoading={isLoading}
      {...props}
    >
      {typeof children === 'string' ? (
        <Text className="text-base font-semibold text-primary-foreground">
          {isLoading && loadingText ? loadingText : children}
        </Text>
      ) : (
        children
      )}
    </Button>
  );
});

AuthButton.displayName = "AuthButton";

export { AuthButton };
