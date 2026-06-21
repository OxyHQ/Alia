import React from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { ActivityIndicator } from 'react-native';
import type { ShowProgress as ShowProgressType } from '@/lib/stores/show-store';
import { useColorScheme } from '@/lib/useColorScheme';

interface ShowProgressProps {
  progress: ShowProgressType;
}

const STEP_LABELS: Record<string, string> = {
  generating_script: 'Writing script...',
  generating_audio: 'Generating audio...',
  concatenating: 'Assembling show...',
};

export function ShowProgressCard({ progress }: ShowProgressProps) {
  const { colors } = useColorScheme();
  const stepLabel = progress.currentStep || STEP_LABELS[progress.status] || 'Processing...';

  return (
    <View className="p-3 bg-card rounded-xl border border-border gap-2">
      <View className="flex-row items-center gap-2">
        <ActivityIndicator size="small" color={colors.primary} />
        <Text className="text-sm font-medium text-foreground">{stepLabel}</Text>
      </View>

      {/* Progress bar */}
      <View className="h-1.5 bg-muted rounded-full overflow-hidden">
        <View
          className="h-full bg-primary rounded-full"
          style={{ width: `${Math.max(2, progress.progress)}%` }}
        />
      </View>

      <View className="flex-row items-center justify-between">
        <Text className="text-xs text-muted-foreground">
          {progress.progress}%
        </Text>
        {progress.segmentIndex != null && progress.totalSegments != null && (
          <Text className="text-xs text-muted-foreground">
            Segment {progress.segmentIndex}/{progress.totalSegments}
          </Text>
        )}
      </View>
    </View>
  );
}
