import { Button } from '@oxy.so/bloom/button';
import { Card, CardBody, CardFooter, CardHeader, CardTitle } from '@oxy.so/bloom/card';
import { RiCheckLine, RiCloseLine, RiListCheck3 } from '@oxy.so/bloom/icons';
import { Item } from '@oxy.so/bloom/item';
import { useTheme } from '@oxy.so/bloom/theme';
import { Text } from '@oxy.so/bloom/typography';
import { View } from 'react-native';
import Animated from 'react-native-reanimated';
import { planPreviewEnter } from '../animations';
import { useLabels } from '../lib/labels';
import type { PlanStep } from '../types';

interface PlanPreviewCardProps {
  steps: PlanStep[];
  onApprove: () => void;
  onReject: () => void;
  approved?: boolean;
  rejected?: boolean;
}

/** The plan Alia proposes, until the person approves or cancels it; then one line saying which. */
export function PlanPreviewCard({
  steps,
  onApprove,
  onReject,
  approved,
  rejected,
}: PlanPreviewCardProps) {
  const labels = useLabels();
  const { colors } = useTheme();

  if (approved || rejected) {
    const Icon = approved ? RiCheckLine : RiCloseLine;
    return (
      <View className="flex-row items-center gap-1.5 py-1">
        <Icon width={14} height={14} fill={approved ? colors.success : colors.error} />
        <Text className="text-xs text-text-secondary">
          {approved ? labels.planApproved : labels.planCancelled}
        </Text>
      </View>
    );
  }

  return (
    <Animated.View entering={planPreviewEnter} className="my-2">
      <Card appearance="outline">
        <CardHeader>
          <View className="flex-row items-center gap-2">
            <RiListCheck3 width={16} height={16} fill={colors.icon} />
            <CardTitle>{labels.planTitle}</CardTitle>
          </View>
        </CardHeader>
        <CardBody>
          {steps.map((step, index) => (
            <Item
              // A plan has no ids and its steps never reorder: the position is the identity.
              // biome-ignore lint/suspicious/noArrayIndexKey: see above
              key={index}
              density="compact"
              leading={
                <Text className="w-5 text-center text-xs font-bold text-text-secondary">
                  {index + 1}
                </Text>
              }
              title={step.action}
              subtitle={step.description || undefined}
            />
          ))}
        </CardBody>
        <CardFooter>
          <View className="flex-1 flex-row gap-2">
            <Button
              tone="action"
              size="sm"
              className="flex-1"
              leadingIcon={RiCheckLine}
              onPress={onApprove}
            >
              {labels.planApprove}
            </Button>
            <Button
              tone="neutral"
              appearance="subtle"
              size="sm"
              className="flex-1"
              onPress={onReject}
            >
              {labels.planCancel}
            </Button>
          </View>
        </CardFooter>
      </Card>
    </Animated.View>
  );
}
