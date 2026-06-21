import * as React from "react";
import { Text as RNText, type TextProps as RNTextProps } from "react-native";
import { cn } from "../../lib/utils";

const TextClassContext = React.createContext<string | undefined>(undefined);

export type TextProps = RNTextProps & {
  className?: string;
};

const Text = React.forwardRef<RNText, TextProps>(
  ({ className, ...props }, ref) => {
    const textClass = React.useContext(TextClassContext);
    return (
      <RNText
        className={cn(
          "text-base leading-7 text-foreground web:select-text font-sans",
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
