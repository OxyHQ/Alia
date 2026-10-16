import { Card, CardBody, CardHeader, CardTitle } from '@oxy.so/bloom/card';
import { RiListCheck3 } from '@oxy.so/bloom/icons';
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
}

/**
 * The plan the agent shows before it works. It is only shown: the agent does not wait on it, and
 * nobody is asked to approve it.
 */
export function PlanPreviewCard({ steps }: PlanPreviewCardProps) {
  const labels = useLabels();
  const { colors } = useTheme();

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
      </Card>
    </Animated.View>
  );
}
