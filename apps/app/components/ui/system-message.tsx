import { cva, type VariantProps } from "class-variance-authority";
import React from "react";
import { View, type ViewProps } from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AlertCircle, AlertTriangle, Info } from "lucide-react-native";

const systemMessageVariants = cva(
  "flex-row items-center gap-3 rounded-xl border py-2 pr-2 pl-3",
  {
    variants: {
      variant: {
        action: "",
        error: "",
        warning: "",
      },
      fill: {
        true: "bg-background",
        false: "",
      },
    },
    compoundVariants: [
      {
        variant: "action",
        fill: true,
        class: "bg-zinc-100 dark:bg-zinc-900 border-transparent",
      },
      {
        variant: "error",
        fill: true,
        class: "bg-red-100 dark:bg-red-900/20 border-transparent",
      },
      {
        variant: "warning",
        fill: true,
        class: "bg-amber-100 dark:bg-amber-900/20 border-transparent",
      },
      {
        variant: "action",
        fill: false,
        class: "border-zinc-200 dark:border-zinc-800",
      },
      {
        variant: "error",
        fill: false,
        class: "border-red-600 dark:border-red-900",
      },
      {
        variant: "warning",
        fill: false,
        class: "border-amber-600 dark:border-amber-900",
      },
    ],
    defaultVariants: {
      variant: "action",
      fill: false,
    },
  }
);

const textColorMap = {
  action: "text-zinc-700 dark:text-zinc-300",
  error: "text-red-700 dark:text-red-400",
  warning: "text-amber-700 dark:text-amber-400",
} as const;

export type SystemMessageProps = ViewProps &
  VariantProps<typeof systemMessageVariants> & {
    icon?: React.ReactNode;
    isIconHidden?: boolean;
    cta?: {
      label: string;
      onPress?: () => void;
    };
  };

export function SystemMessage({
  children,
  variant = "action",
  fill = false,
  icon,
  isIconHidden = false,
  cta,
  className,
  ...props
}: SystemMessageProps) {
  const iconColor =
    variant === "error"
      ? "#dc2626"
      : variant === "warning"
        ? "#d97706"
        : "#71717a";

  const getDefaultIcon = () => {
    if (isIconHidden) return null;
    switch (variant) {
      case "error":
        return <AlertCircle size={16} color={iconColor} />;
      case "warning":
        return <AlertTriangle size={16} color={iconColor} />;
      default:
        return <Info size={16} color={iconColor} />;
    }
  };

  const iconToShow = isIconHidden ? null : icon ?? getDefaultIcon();

  return (
    <View
      className={cn(systemMessageVariants({ variant, fill }), className)}
      {...props}
    >
      <View className="flex-1 flex-row items-center gap-3">
        {iconToShow && (
          <View className="shrink-0 items-center justify-center self-start pt-0.5">
            {iconToShow}
          </View>
        )}
        <View className="min-w-0 flex-1">
          <Text className={cn("text-sm", textColorMap[variant ?? "action"])}>
            {children}
          </Text>
        </View>
      </View>

      {cta && (
        <Button variant="default" size="sm" onPress={cta.onPress}>
          <Text className="text-sm text-primary-foreground">{cta.label}</Text>
        </Button>
      )}
    </View>
  );
}
