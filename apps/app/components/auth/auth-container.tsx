import * as React from "react";
import { View, ScrollView, KeyboardAvoidingView, Platform } from "react-native";
import { cn } from "@/lib/utils";

export interface AuthContainerProps {
  children: React.ReactNode;
  className?: string;
}

export function AuthContainer({ children, className }: AuthContainerProps) {
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      className="flex-1 bg-background"
    >
      <ScrollView
        className="flex-1"
        contentContainerClassName="flex-1 justify-center px-6 py-6"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View className={cn("max-w-sm w-full mx-auto", className)}>
          {children}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
