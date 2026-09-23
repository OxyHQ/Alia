import { cn } from '@/lib/utils';
import { Text } from '@oxy.so/bloom/typography';
import { View } from 'react-native';
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
