import { Pressable, View } from 'react-native';
import { CalendarClock, ChevronRight } from 'lucide-react-native';
import { useRouter } from 'expo-router';
import { Text } from '@/components/ui/text';
import { AutomationPill } from '@/components/automations/automation-pill';
import { triggerLabel } from '@/lib/automations/format';
import type { AutomationTrigger } from '@/lib/automations/types';
import { useColorScheme } from '@/lib/useColorScheme';

export interface ScheduledTaskCardData {
  id: string;
  objective: string;
  enabled: boolean;
  trigger: AutomationTrigger;
}

export function ScheduledTaskCard({ data }: { data: ScheduledTaskCardData }) {
  const router = useRouter();
  const { colors } = useColorScheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open scheduled task ${data.objective}`}
      onPress={() => router.push({ pathname: '/(app)/automations/[id]', params: { id: data.id } })}
      className="my-2 w-full max-w-md rounded-2xl border border-border bg-surface p-4 active:bg-muted"
    >
      <View className="flex-row items-center gap-3">
        <View className="h-10 w-10 items-center justify-center rounded-xl bg-muted">
          <CalendarClock size={19} color={colors.foreground} />
        </View>
        <View className="min-w-0 flex-1 gap-1">
          <Text className="text-sm font-semibold text-foreground" numberOfLines={2}>
            {data.objective}
          </Text>
          <Text className="text-xs text-muted-foreground" numberOfLines={1}>
            {triggerLabel(data.trigger)}
          </Text>
        </View>
        <AutomationPill
          label={data.enabled ? 'Scheduled' : 'Paused'}
          tone={data.enabled ? 'positive' : 'neutral'}
        />
        <ChevronRight size={16} color={colors.mutedForeground} />
      </View>
    </Pressable>
  );
}
