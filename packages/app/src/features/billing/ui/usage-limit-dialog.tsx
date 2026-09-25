import { useState, useEffect } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { Dialog, type DialogAction } from '@oxy.so/bloom/dialog';
import { IconCircle } from '@oxy.so/bloom/icon-circle';
import { RiBankCardLine } from '@oxy.so/bloom/icons/RiBankCardLine';
import { RiFlashlightLine } from '@oxy.so/bloom/icons/RiFlashlightLine';
import { RiLockLine } from '@oxy.so/bloom/icons/RiLockLine';
import { RiTimeLine } from '@oxy.so/bloom/icons/RiTimeLine';
import { UsageLimitError } from '@/features/billing/model/usage-limit-error';
import { useTranslation } from '@/shared/i18n/use-translation';

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

  /** The plan's rolling usage window: wait it out, or move to a bigger plan. */
  const isWindow = error?.details.limitType === 'usage_window';

  // Title
  let title: string;
  if (isWindow) {
    title = t('usageLimit.windowTitle');
  } else if (isModelAccess) {
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
  if (isWindow) {
    description = countdown > 0
      ? t('usageLimit.windowDescription', { time: formatCountdown(countdown) })
      : t('usageLimit.windowFreed');
  } else if (isModelAccess) {
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
  const actions: DialogAction[] = isWindow
    ? [upgrade, countdown > 0 ? waiting : { label: t('usageLimit.tryAgain'), color: 'cancel' }]
    : isModelAccess
    ? [upgrade, { label: t('usageLimit.gotIt'), color: 'cancel' }]
    : isCredits
      ? [upgrade, { label: t('usageLimit.buyCredits'), color: 'cancel', onPress: handleBuyCredits }]
      : showUpgrade
        ? [upgrade, countdown > 0 ? waiting : { label: t('usageLimit.tryAgain'), color: 'cancel' }]
        : [countdown > 0 ? waiting : { label: t('usageLimit.gotIt'), color: 'cancel' }];

  // What stands between the person and the next reply: the plan, the credits,
  // the plan's limit, or only a moment's wait.
  const icon = isModelAccess
    ? RiLockLine
    : isCredits
      ? RiBankCardLine
      : showUpgrade
        ? RiFlashlightLine
        : RiTimeLine;

  return (
    <Dialog
      open={!!error}
      onClose={onDismiss}
      placement={{ base: 'bottom', md: 'center' }}
      title={title}
      description={description}
      actions={actions}
    >
      <View className="items-center">
        <IconCircle icon={icon} size="lg" />
      </View>
    </Dialog>
  );
}
