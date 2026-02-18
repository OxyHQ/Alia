import React from "react";
import { View, type ViewProps } from "react-native";
import { Text } from "@/components/ui/text";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { ChevronDown, Circle } from "lucide-react-native";

// --- ChainOfThoughtItem ---

export type ChainOfThoughtItemProps = ViewProps;

export function ChainOfThoughtItem({
  children,
  className,
  ...props
}: ChainOfThoughtItemProps) {
  return (
    <View className={cn("", className)} {...props}>
      {typeof children === "string" ? (
        <Text className="text-sm text-muted-foreground">{children}</Text>
      ) : (
        children
      )}
    </View>
  );
}

// --- ChainOfThoughtTrigger ---

export type ChainOfThoughtTriggerProps = {
  children: React.ReactNode;
  leftIcon?: React.ReactNode;
  className?: string;
};

export function ChainOfThoughtTrigger({
  children,
  className,
  leftIcon,
}: ChainOfThoughtTriggerProps) {
  return (
    <CollapsibleTrigger asChild>
      <View
        className={cn(
          "flex-row items-center justify-start gap-1",
          "web:cursor-pointer",
          className
        )}
      >
        <View className="flex-row items-center gap-2">
          {leftIcon ? (
            <View className="h-4 w-4 items-center justify-center">
              {leftIcon}
            </View>
          ) : (
            <View className="h-4 w-4 items-center justify-center">
              <Circle size={8} fill="currentColor" className="text-muted-foreground" />
            </View>
          )}
          {typeof children === "string" ? (
            <Text className="text-sm text-muted-foreground">{children}</Text>
          ) : (
            children
          )}
        </View>
        {!leftIcon && (
          <ChevronDown size={16} className="text-muted-foreground" />
        )}
      </View>
    </CollapsibleTrigger>
  );
}

// --- ChainOfThoughtContent ---

export type ChainOfThoughtContentProps = {
  children: React.ReactNode;
  isLast?: boolean;
  className?: string;
};

export function ChainOfThoughtContent({
  children,
  isLast = false,
  className,
}: ChainOfThoughtContentProps) {
  return (
    <CollapsibleContent className={cn("overflow-hidden", className)}>
      <View className="flex-row gap-4">
        {!isLast && (
          <View
            className="bg-primary/20 self-stretch"
            style={{ width: 1, marginLeft: 7 }}
          />
        )}
        {isLast && <View style={{ width: 1, marginLeft: 7 }} />}
        <View className="mt-2 min-w-0 flex-1 gap-2">{children}</View>
      </View>
    </CollapsibleContent>
  );
}

// --- ChainOfThoughtStep ---

export type ChainOfThoughtStepProps = {
  children: React.ReactNode;
  className?: string;
  isLast?: boolean;
  defaultOpen?: boolean;
};

export function ChainOfThoughtStep({
  children,
  className,
  isLast = false,
  defaultOpen,
}: ChainOfThoughtStepProps) {
  return (
    <Collapsible className={cn("", className)} defaultOpen={defaultOpen}>
      {React.Children.map(children, (child) => {
        if (React.isValidElement(child) && child.type === ChainOfThoughtContent) {
          return React.cloneElement(
            child as React.ReactElement<ChainOfThoughtContentProps>,
            { isLast }
          );
        }
        return child;
      })}
      {!isLast && (
        <View className="flex-row justify-start">
          <View
            className="bg-primary/20"
            style={{ width: 1, height: 16, marginLeft: 7 }}
          />
        </View>
      )}
    </Collapsible>
  );
}

// --- ChainOfThought (root) ---

export type ChainOfThoughtProps = {
  children: React.ReactNode;
  className?: string;
};

export function ChainOfThought({ children, className }: ChainOfThoughtProps) {
  const childrenArray = React.Children.toArray(children);

  return (
    <View className={cn("", className)}>
      {childrenArray.map((child, index) =>
        React.isValidElement(child)
          ? React.cloneElement(
              child as React.ReactElement<ChainOfThoughtStepProps>,
              { isLast: index === childrenArray.length - 1 }
            )
          : child
      )}
    </View>
  );
}
