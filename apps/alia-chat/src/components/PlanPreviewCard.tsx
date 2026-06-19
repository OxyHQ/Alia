import { View, Pressable } from 'react-native';
import { Text } from './ui/text';
import { Button } from './ui/button';
import { Check, X, ListChecks } from 'lucide-react-native';
import Animated from 'react-native-reanimated';
import { planPreviewEnter } from '../animations';
import type { PlanStep } from '../types';

interface PlanPreviewCardProps {
  steps: PlanStep[];
  onApprove: () => void;
  onReject: () => void;
  approved?: boolean;
  rejected?: boolean;
}

export function PlanPreviewCard({ steps, onApprove, onReject, approved, rejected }: PlanPreviewCardProps) {
  if (approved) {
    return (
      <View className="flex-row items-center gap-1.5 py-1">
        <Check size={12} className="text-green-500" />
        <Text className="text-xs text-muted-foreground">Plan approved</Text>
      </View>
    );
  }

  if (rejected) {
    return (
      <View className="flex-row items-center gap-1.5 py-1">
        <X size={12} className="text-red-500" />
        <Text className="text-xs text-muted-foreground">Plan cancelled</Text>
      </View>
    );
  }

  return (
    <Animated.View entering={planPreviewEnter}>
      <View className="border border-border rounded-xl bg-card p-4 gap-3 my-2">
        <View className="flex-row items-center gap-2">
          <ListChecks size={16} className="text-foreground" />
          <Text className="text-sm font-semibold text-foreground">Here's my plan</Text>
        </View>

        <View className="gap-2">
          {steps.map((step, i) => (
            <View key={i} className="flex-row items-start gap-2.5">
              <View className="w-5 h-5 rounded-full bg-muted items-center justify-center mt-0.5">
                <Text className="text-[10px] font-bold text-muted-foreground">{i + 1}</Text>
              </View>
              <View className="flex-1">
                <Text className="text-[13px] font-medium text-foreground">{step.action}</Text>
                {step.description ? (
                  <Text className="text-xs text-muted-foreground">{step.description}</Text>
                ) : null}
              </View>
            </View>
          ))}
        </View>

        <View className="flex-row gap-2 pt-1">
          <Button onPress={onApprove} size="sm" className="flex-1">
            <View className="flex-row items-center gap-1.5">
              <Check size={14} className="text-primary-foreground" />
              <Text className="text-sm font-medium text-primary-foreground">Approve</Text>
            </View>
          </Button>
          <Pressable
            onPress={onReject}
            className="flex-1 items-center justify-center py-2 rounded-lg active:opacity-70"
          >
            <Text className="text-sm text-muted-foreground">Cancel</Text>
          </Pressable>
        </View>
      </View>
    </Animated.View>
  );
}
