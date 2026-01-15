import * as React from "react";
import { Text as RNText, type TextProps } from "react-native";
import { cn } from "@/lib/utils";

const TextClassContext = React.createContext<string | undefined>(undefined);

const Text = React.forwardRef<RNText, TextProps>(
  ({ className, ...props }, ref) => {
    const textClass = React.useContext(TextClassContext);
    return (
      <RNText
        className={cn(
          "text-lg text-foreground web:select-text font-sans",
          textClass,
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Text.displayName = "Text";

export { Text, TextClassContext };
