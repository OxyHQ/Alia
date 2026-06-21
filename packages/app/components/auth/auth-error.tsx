import * as React from "react";
import { View } from "react-native";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

export interface AuthErrorProps {
  message: string;
  className?: string;
}

export function AuthError({ message, className }: AuthErrorProps) {
  if (!message) return null;

  return (
    <View className={cn("bg-destructive/10 rounded-full px-4 py-2 mb-1", className)}>
      <Text className="text-destructive text-sm text-center">{message}</Text>
    </View>
  );
}
