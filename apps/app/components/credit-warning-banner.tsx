import { View, Pressable } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { X, Zap } from 'lucide-react-native';
import { Text } from '@/components/ui/text';

interface UsageWarningData {
  level: string;
  daysRemaining: number;
  todaySpend: number;
  avgDailySpend: number;
  currentModelMultiplier?: number;
}

interface CreditWarningBannerProps {
  selectedModel: string;
  onSwitchModel: (model: string) => void;
}

const CHEAPER_ALTERNATIVES: Record<string, { model: string; name: string; multiplier: number }> = {
  'alia-v1':           { model: 'alia-lite',    name: 'Alia Lite',     multiplier: 0.5 },
  'alia-v1-codea':     { model: 'alia-lite',    name: 'Alia Lite',     multiplier: 0.5 },
  'alia-v1-cowork':    { model: 'alia-v1',      name: 'Alia V1',       multiplier: 1 },
  'alia-v1-browser':   { model: 'alia-v1',      name: 'Alia V1',       multiplier: 1 },
  'alia-v1-vision':    { model: 'alia-v1',      name: 'Alia V1',       multiplier: 1 },
  'alia-v1-multimodal':{ model: 'alia-v1',      name: 'Alia V1',       multiplier: 1 },
  'alia-v1-pro':       { model: 'alia-v1',      name: 'Alia V1',       multiplier: 1 },
  'alia-v1-thinking':  { model: 'alia-v1',      name: 'Alia V1',       multiplier: 1 },
  'alia-v1-pro-max':   { model: 'alia-v1',      name: 'Alia V1',       multiplier: 1 },
  'alia-v1-voice-pro': { model: 'alia-v1-voice', name: 'Alia V1 Voice', multiplier: 2 },
};

export function CreditWarningBanner({ selectedModel, onSwitchModel }: CreditWarningBannerProps) {
  const queryClient = useQueryClient();

  const usageWarning = queryClient.getQueryData<UsageWarningData>(['usage-warning']);
  if (!usageWarning) return null;

  const alt = CHEAPER_ALTERNATIVES[selectedModel];
  // No cheaper alternative available (e.g. already on alia-lite or alia-v1-voice)
  if (!alt) return null;

  const isCritical = usageWarning.level === 'critical';
  const days = Math.round(usageWarning.daysRemaining);
  const showDays = days < 999;

  const currentMultiplier = usageWarning.currentModelMultiplier || 1;
  const savingsRatio = Math.round(currentMultiplier / alt.multiplier);

  const handleDismiss = () => {
    queryClient.setQueryData(['usage-warning'], null);
  };

  let statusText: string;
  if (isCritical && showDays) {
    statusText = `High usage — credits may run out in ~${days} day${days !== 1 ? 's' : ''}.`;
  } else if (showDays) {
    statusText = `Spending more than usual. At this rate, credits last ~${days} days.`;
  } else {
    statusText = 'Spending more than usual today.';
  }

  const suggestionText = savingsRatio > 1
    ? `Switch to ${alt.name} for ~${savingsRatio}x fewer credits.`
    : `Switch to ${alt.name} for fewer credits.`;

  return (
    <View className="mx-auto w-full max-w-3xl px-4 pb-1">
      <View className={`flex-row items-center gap-2 rounded-lg px-3 py-2 ${isCritical ? 'bg-destructive/10' : 'bg-yellow-500/10'}`}>
        <Zap size={14} className={isCritical ? 'text-destructive' : 'text-yellow-600'} />
        <Text className={`text-xs flex-1 ${isCritical ? 'text-destructive' : 'text-yellow-700 dark:text-yellow-400'}`}>
          {statusText} {suggestionText}
        </Text>
        <Pressable onPress={() => onSwitchModel(alt.model)} className="active:opacity-70">
          <Text className="text-xs font-medium text-primary">Switch</Text>
        </Pressable>
        <Pressable onPress={handleDismiss} className="active:opacity-70">
          <X size={12} className="text-muted-foreground" />
        </Pressable>
      </View>
    </View>
  );
}
