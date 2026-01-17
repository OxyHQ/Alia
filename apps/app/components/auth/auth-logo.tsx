import * as React from "react";
import { View } from "react-native";
import { Image } from "expo-image";
import { cn } from "@/lib/utils";

export interface AuthLogoProps {
  className?: string;
}

export function AuthLogo({ className }: AuthLogoProps) {
  return (
    <View className={cn("items-center mb-6", className)}>
      <Image
        source={require("@/assets/images/logo.png")}
        style={{ width: 160, height: 64 }}
        contentFit="contain"
      />
    </View>
  );
}
