import React, { useState } from "react";
import { View, type ViewProps } from "react-native";
import { Text } from "@/components/ui/text";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { ChevronDown } from "lucide-react-native";

// --- StepsItem ---

export type StepsItemProps = ViewProps;

export function StepsItem({ children, className, ...props }: StepsItemProps) {
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

// --- StepsBar ---

export type StepsBarProps = ViewProps;

export function StepsBar({ className, ...props }: StepsBarProps) {
  return (
    <View
      className={cn("bg-muted self-stretch", className)}
      style={{ width: 2 }}
      accessibilityElementsHidden
      {...props}
    />
  );
}

// --- StepsTrigger ---

export type StepsTriggerProps = {
  children: React.ReactNode;
  leftIcon?: React.ReactNode;
  className?: string;
};

export function StepsTrigger({
  children,
  className,
  leftIcon,
}: StepsTriggerProps) {
  return (
    <CollapsibleTrigger asChild>
      <View
        className={cn(
          "flex-row items-center justify-start gap-1 w-full",
          "web:cursor-pointer",
          className
        )}
      >
        <View className="flex-row items-center gap-2">
          {leftIcon && (
            <View className="h-4 w-4 items-center justify-center">
              {leftIcon}
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

// --- StepsContent ---

export type StepsContentProps = {
  children: React.ReactNode;
  bar?: React.ReactNode;
  className?: string;
};

export function StepsContent({
  children,
  className,
  bar,
}: StepsContentProps) {
  return (
    <CollapsibleContent className={cn("overflow-hidden", className)}>
      <View className="mt-3 flex-row items-start gap-3">
        <View className="self-stretch">{bar ?? <StepsBar />}</View>
        <View className="min-w-0 flex-1 gap-2">{children}</View>
      </View>
    </CollapsibleContent>
  );
}

// --- Steps (root) ---

export type StepsProps = {
  children: React.ReactNode;
  defaultOpen?: boolean;
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export function Steps({
  defaultOpen = true,
  className,
  open,
  onOpenChange,
  ...props
}: StepsProps) {
  return (
    <Collapsible
      className={cn(className)}
      defaultOpen={defaultOpen}
      open={open}
      onOpenChange={onOpenChange}
      {...props}
    />
  );
}
