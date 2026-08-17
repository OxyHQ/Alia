import { View, Pressable } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { X, Zap, AlertTriangle } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { useRouter } from 'expo-router';
import { useCredits } from '@/lib/hooks/use-credits';
import { queryKeys } from '@/lib/hooks/query-keys';
import React, { useState } from 'react';
import { useTranslation } from '@/lib/hooks/use-translation';
import { useCatalogue, type CatalogueEntry } from '@/lib/hooks/use-catalogue';
import { presentation, useProductModes } from '@/lib/hooks/use-product-modes';

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

/**
 * The cheapest entry the product currently offers below this one.
 *
 * Read off the catalogue rather than a table. The table this replaces was
 * keyed by the thirteen `alia-*` identifiers and mapped each to a hand-picked
 * alternative; once the picker began sending `profile:*` ids every lookup
 * missed, and a miss is indistinguishable from "already on the cheapest
 * option" — so the banner would have stopped suggesting anything, silently and
 * forever.
 *
 * `null` whenever the answer is not known: no catalogue, no multiplier on the
 * current entry, or nothing cheaper offered. Suggesting a downgrade on missing
 * data would be a recommendation with nothing behind it.
 */
function cheaperAlternative(
  selectedModel: string,
  entries: readonly CatalogueEntry[] | undefined,
): { entry: CatalogueEntry; multiplier: number } | null {
  if (entries === undefined) return null;
  const offered = entries.filter((entry) => entry.chatVisible && !entry.unavailable);
  const current = offered.find((entry) => entry.id === selectedModel);
  if (current?.creditMultiplier == null) return null;

  let best: CatalogueEntry | null = null;
  for (const entry of offered) {
    if (entry.creditMultiplier === null) continue;
    if (entry.creditMultiplier >= current.creditMultiplier) continue;
    if (best === null || entry.creditMultiplier < best.creditMultiplier!) best = entry;
  }
  if (best === null || best.creditMultiplier === null) return null;
  // The ENTRY, not a name: naming it here would be a second answer to "what do
  // we call this", and `presentation` is the one that answers it.
  return { entry: best, multiplier: best.creditMultiplier };
}

// Memoized: mounted next to the streaming chat surface, which re-renders per
// flush; this banner's props never change per token.
export const CreditWarningBanner = React.memo(function CreditWarningBanner({ selectedModel, onSwitchModel }: CreditWarningBannerProps) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { t } = useTranslation();
  const { data: creditsInfo } = useCredits();
  const { data: catalogue } = useCatalogue();
  const { data: modes } = useProductModes();
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
          <Pressable onPress={() => router.push('/(app)/settings/usage')} className="active:opacity-70">
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

  // `null` means "no cheaper option, or we cannot tell" — both of which are
  // reasons to say nothing rather than to guess.
  const alt = cheaperAlternative(selectedModel, catalogue);
  if (!alt) return null;

  const isCritical = usageWarning.level === 'critical';
  const days = Math.round(usageWarning.daysRemaining);
  const showDays = days < 999;

  // The product's word for the alternative, when it has one — the same
  // Automatic/Fast/Balanced language the picker shows, so the banner and the
  // menu cannot name the same entry two different ways.
  const altName = presentation(alt.entry, modes).label;

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
    ? t('usageLimit.switchToModel', { model: altName, ratio: savingsRatio })
    : t('usageLimit.switchToModelAlt', { model: altName });

  return (
    <View className="mx-auto w-full max-w-3xl px-4 pb-1">
      <View className={`flex-row items-center gap-2 rounded-lg px-3 py-2 ${isCritical ? 'bg-destructive/10' : 'bg-yellow-500/10'}`}>
        <Zap size={14} className={isCritical ? 'text-destructive' : 'text-yellow-600'} />
        <Text className={`text-xs flex-1 ${isCritical ? 'text-destructive' : 'text-yellow-700 dark:text-yellow-400'}`}>
          {statusText} {suggestionText}
        </Text>
        <Pressable onPress={() => onSwitchModel(alt.entry.id)} className="active:opacity-70">
          <Text className="text-xs font-medium text-primary">{t('usageLimit.switchModel')}</Text>
        </Pressable>
        <Pressable onPress={handleDismiss} className="active:opacity-70">
          <X size={12} className="text-muted-foreground" />
        </Pressable>
      </View>
    </View>
  );
});
