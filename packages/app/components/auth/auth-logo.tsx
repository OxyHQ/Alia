import * as React from 'react';
import { View } from 'react-native';
import { AliaLogo } from '@/components/ui/alia-logo';

/** The Alia lockup, centred above an auth-style page's content. */
export function AuthLogo() {
  return (
    <View className="items-center">
      <AliaLogo width={160} />
    </View>
  );
}
