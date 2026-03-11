import * as React from "react";
import { View } from "react-native";
import { cn } from "@/lib/utils";
import { AliaLogo } from "@/components/ui/alia-logo";

export interface AuthLogoProps {
  className?: string;
}

export function AuthLogo({ className }: AuthLogoProps) {
  return (
    <View className={cn("items-center mb-6", className)}>
      <AliaLogo width={160} />
    </View>
  );
}
