import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import type { AutomationStepStatus } from '@/lib/automations/types';

export type AutomationPillTone = 'neutral' | 'positive' | 'warning' | 'danger';

export function AutomationPill({
  label,
  tone = 'neutral',
}: {
  label: string;
  tone?: AutomationPillTone;
}) {
  const colors = tone === 'positive'
    ? { background: 'bg-green-500/10', text: 'text-green-600' }
    : tone === 'warning'
      ? { background: 'bg-yellow-500/10', text: 'text-yellow-700' }
      : tone === 'danger'
        ? { background: 'bg-destructive/10', text: 'text-destructive' }
        : { background: 'bg-muted', text: 'text-muted-foreground' };
  return (
    <View className={`rounded-full px-2.5 py-1 ${colors.background}`}>
      <Text className={`text-[11px] font-medium ${colors.text}`} selectable>{label}</Text>
    </View>
  );
}

export function automationStatusTone(status: AutomationStepStatus): AutomationPillTone {
  if (status === 'succeeded' || status === 'observed') return 'positive';
  if (status === 'running' || status === 'planned') return 'warning';
  if (status === 'failed' || status === 'cancelled' || status === 'denied') return 'danger';
  return 'neutral';
}
