import { Chip } from '@oxy.so/bloom/chip';
import { Text } from '@oxy.so/bloom/typography';
import type { ReactNode } from 'react';
import { View } from 'react-native';

/** A section of the agent overview: its heading, then its content. */
export function AgentDetailSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <View className="gap-2">
      <View className="flex-row items-center justify-between">
        <Text variant="headline-semibold">{title}</Text>
        {action}
      </View>
      {children}
    </View>
  );
}

/** Static chips in a wrapping row — capabilities, tags. */
export function ChipList({ items }: { items: string[] }) {
  return (
    <View className="flex-row flex-wrap gap-1.5">
      {items.map((item, i) => (
        <Chip key={i} size="large">
          {item}
        </Chip>
      ))}
    </View>
  );
}
