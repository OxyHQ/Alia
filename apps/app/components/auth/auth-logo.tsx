import * as React from "react";
import { View } from "react-native";
import { cn } from "@/lib/utils";
import { ClarityWordmark } from "@/components/ui/clarity-wordmark";

export interface AuthLogoProps {
  className?: string;
}

export function AuthLogo({ className }: AuthLogoProps) {
  return (
    <View className={cn("items-center mb-6", className)}>
      <ClarityWordmark width={160} />
    </View>
  );
}
