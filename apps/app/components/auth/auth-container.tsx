import * as React from "react";
import { View, ScrollView, Platform } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { cn } from "@/lib/utils";

const ScrollComponent = Platform.OS === 'web' ? ScrollView : KeyboardAwareScrollView;

export interface AuthContainerProps {
  children: React.ReactNode;
  className?: string;
}

export function AuthContainer({ children, className }: AuthContainerProps) {
  return (
    <ScrollComponent
      bottomOffset={20}
      className="flex-1 bg-background"
      contentContainerClassName="flex-1 justify-center px-6 py-6"
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      <View className={cn("max-w-sm w-full mx-auto", className)}>
        {children}
      </View>
    </ScrollComponent>
  );
}
