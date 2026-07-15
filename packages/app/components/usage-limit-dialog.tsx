import { useState, useEffect } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { Zap, Clock, CreditCard, Lock } from 'lucide-react-native';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
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

  return (
    <Dialog open={!!error} onOpenChange={(open) => !open && onDismiss()}>
      <DialogContent closeButton={true}>
        <DialogHeader>
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
          <DialogTitle className="text-center">{title}</DialogTitle>
          <DialogDescription className="text-center">{description}</DialogDescription>
        </DialogHeader>

        <DialogFooter className="justify-center">
          {isModelAccess ? (
            <>
              <Button onPress={handleUpgrade} className="flex-1">
                <Text className="text-primary-foreground text-sm font-medium">{t('usageLimit.upgradePlan')}</Text>
              </Button>
              <Button variant="outline" onPress={onDismiss} className="flex-1">
                <Text className="text-sm font-medium">{t('usageLimit.gotIt')}</Text>
              </Button>
            </>
          ) : isCredits ? (
            <>
              <Button onPress={handleUpgrade} className="flex-1">
                <Text className="text-primary-foreground text-sm font-medium">{t('usageLimit.upgradePlan')}</Text>
              </Button>
              <Button variant="outline" onPress={handleBuyCredits} className="flex-1">
                <Text className="text-sm font-medium">{t('usageLimit.buyCredits')}</Text>
              </Button>
            </>
          ) : showUpgrade ? (
            <>
              <Button onPress={handleUpgrade} className="flex-1">
                <Text className="text-primary-foreground text-sm font-medium">{t('usageLimit.upgradePlan')}</Text>
              </Button>
              {countdown > 0 ? (
                <Button variant="outline" disabled className="flex-1">
                  <Text className="text-sm font-medium text-muted-foreground">
                    {t('usageLimit.tryAgainIn', { time: formatCountdown(countdown) })}
                  </Text>
                </Button>
              ) : (
                <Button variant="outline" onPress={onDismiss} className="flex-1">
                  <Text className="text-sm font-medium">{t('usageLimit.tryAgain')}</Text>
                </Button>
              )}
            </>
          ) : (
            <Button variant="outline" onPress={onDismiss} className="flex-1">
              <Text className="text-sm font-medium">
                {countdown > 0 ? t('usageLimit.tryAgainIn', { time: formatCountdown(countdown) }) : t('usageLimit.gotIt')}
              </Text>
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
