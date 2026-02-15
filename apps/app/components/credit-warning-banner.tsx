import { View, Pressable } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { X, Zap, AlertTriangle } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { useRouter } from 'expo-router';
import { useCredits } from '@/lib/hooks/use-credits';
import { queryKeys } from '@/lib/hooks/query-keys';
import { useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';

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
  const router = useRouter();
  const { t } = useTranslation();
  const { data: creditsInfo } = useCredits();
  const [lowCreditsDismissed, setLowCreditsDismissed] = useState(false);

  const usageWarning = queryClient.getQueryData<UsageWarningData>(queryKeys.credits.usageWarning);

  // Low credits banner (< 50 credits remaining, non-zero)
  const isLowCredits = !lowCreditsDismissed && creditsInfo && creditsInfo.credits < 50 && creditsInfo.credits > 0;
  if (!usageWarning && isLowCredits) {
    return (
      <View className="mx-auto w-full max-w-3xl px-4 pb-1">
        <View className="flex-row items-center gap-2 rounded-lg px-3 py-2 bg-yellow-500/10">
          <AlertTriangle size={14} className="text-yellow-600" />
          <Text className="text-xs flex-1 text-yellow-700 dark:text-yellow-400">
            {t('usageLimit.creditsRemaining', { count: creditsInfo.credits })}
          </Text>
          <Pressable onPress={() => router.push('/(app)/billing')} className="active:opacity-70">
            <Text className="text-xs font-medium text-primary">{t('usageLimit.buyMore')}</Text>
          </Pressable>
          <Pressable onPress={() => setLowCreditsDismissed(true)} className="active:opacity-70">
            <X size={12} className="text-muted-foreground" />
          </Pressable>
        </View>
      </View>
    );
  }

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
    queryClient.setQueryData(queryKeys.credits.usageWarning, null);
  };

  let statusText: string;
  if (isCritical && showDays) {
    statusText = t('usageLimit.criticalMessage', { days });
  } else if (showDays) {
    statusText = t('usageLimit.warningMessage', { days });
  } else {
    statusText = t('usageLimit.spendingHighToday');
  }

  const suggestionText = savingsRatio > 1
    ? t('usageLimit.switchToModel', { model: alt.name, ratio: savingsRatio })
    : t('usageLimit.switchToModelAlt', { model: alt.name });

  return (
    <View className="mx-auto w-full max-w-3xl px-4 pb-1">
      <View className={`flex-row items-center gap-2 rounded-lg px-3 py-2 ${isCritical ? 'bg-destructive/10' : 'bg-yellow-500/10'}`}>
        <Zap size={14} className={isCritical ? 'text-destructive' : 'text-yellow-600'} />
        <Text className={`text-xs flex-1 ${isCritical ? 'text-destructive' : 'text-yellow-700 dark:text-yellow-400'}`}>
          {statusText} {suggestionText}
        </Text>
        <Pressable onPress={() => onSwitchModel(alt.model)} className="active:opacity-70">
          <Text className="text-xs font-medium text-primary">{t('usageLimit.switchModel')}</Text>
        </Pressable>
        <Pressable onPress={handleDismiss} className="active:opacity-70">
          <X size={12} className="text-muted-foreground" />
        </Pressable>
      </View>
    </View>
  );
}
