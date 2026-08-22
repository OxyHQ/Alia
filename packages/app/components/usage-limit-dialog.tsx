import { useState, useEffect } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { Zap, Clock, CreditCard, Lock } from 'lucide-react-native';
import { Dialog, type DialogAction } from '@oxyhq/bloom/dialog';
import { UsageLimitError } from '@/lib/errors/usage-limit-error';
import { useTranslation } from '@/lib/hooks/use-translation';

interface UsageLimitDialogProps {
  error: UsageLimitError | null;
  onDismiss: () => void;
}

function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function UsageLimitDialog({ error, onDismiss }: UsageLimitDialogProps) {
  const router = useRouter();
  const { t } = useTranslation();
  const [countdown, setCountdown] = useState(0);

  useEffect(() => {
    if (!error?.details.retryAfterSeconds) {
      setCountdown(0);
      return;
    }
    setCountdown(error.details.retryAfterSeconds);
    const interval = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [error]);

  if (!error) return null;

  const isCredits = error.isCreditsError;
  const isModelAccess = error.isModelAccessError;
  const showUpgrade = error.shouldShowUpgrade;

  const handleUpgrade = () => {
    onDismiss();
    router.push('/(biglayout)/subscribe');
  };

  const handleBuyCredits = () => {
    onDismiss();
    router.push('/(app)/settings/usage');
  };

  // Title
  let title: string;
  if (isModelAccess) {
    title = t('usageLimit.modelLockedTitle');
  } else if (isCredits) {
    title = t('usageLimit.outOfCreditsTitle');
  } else if (showUpgrade) {
    title = t('usageLimit.limitReachedTitle');
  } else {
    title = t('usageLimit.slowDownTitle');
  }

  // Description
  let description: string;
  if (isModelAccess) {
    description = t('usageLimit.modelLockedDesc');
  } else if (isCredits) {
    description = t('usageLimit.outOfCreditsDescription');
  } else if (showUpgrade) {
    description = t('usageLimit.limitReachedDescription');
  } else {
    description = countdown > 0
      ? t('usageLimit.slowDownDescription', { time: formatCountdown(countdown) })
      : t('usageLimit.slowDownGeneric');
  }

  // Every former footer button was a plain button, so the whole branch becomes
  // a declarative action list. `color: 'cancel'` dismisses on its own, which is
  // what `onClose` already routes to `onDismiss`.
  const waiting: DialogAction = {
    label: t('usageLimit.tryAgainIn', { time: formatCountdown(countdown) }),
    color: 'cancel',
    disabled: true,
  };
  const upgrade: DialogAction = { label: t('usageLimit.upgradePlan'), onPress: handleUpgrade };
  const actions: DialogAction[] = isModelAccess
    ? [upgrade, { label: t('usageLimit.gotIt'), color: 'cancel' }]
    : isCredits
      ? [upgrade, { label: t('usageLimit.buyCredits'), color: 'cancel', onPress: handleBuyCredits }]
      : showUpgrade
        ? [upgrade, countdown > 0 ? waiting : { label: t('usageLimit.tryAgain'), color: 'cancel' }]
        : [countdown > 0 ? waiting : { label: t('usageLimit.gotIt'), color: 'cancel' }];

  return (
    <Dialog
      open={!!error}
      onClose={onDismiss}
      placement={{ base: 'bottom', md: 'center' }}
      title={title}
      description={description}
      actions={actions}
    >
        <View className="items-center mb-3">
          {isModelAccess ? (
            <View className="w-12 h-12 rounded-full bg-purple-100 dark:bg-purple-900/30 items-center justify-center">
              <Lock size={24} className="text-purple-500" />
            </View>
          ) : isCredits ? (
            <View className="w-12 h-12 rounded-full bg-orange-100 dark:bg-orange-900/30 items-center justify-center">
              <CreditCard size={24} className="text-orange-500" />
            </View>
          ) : showUpgrade ? (
            <View className="w-12 h-12 rounded-full bg-blue-100 dark:bg-blue-900/30 items-center justify-center">
              <Zap size={24} className="text-blue-500" />
            </View>
          ) : (
            <View className="w-12 h-12 rounded-full bg-yellow-100 dark:bg-yellow-900/30 items-center justify-center">
              <Clock size={24} className="text-yellow-500" />
            </View>
          )}
        </View>
    </Dialog>
  );
}
