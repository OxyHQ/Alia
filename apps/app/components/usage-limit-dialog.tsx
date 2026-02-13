import { useState, useEffect } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { Zap, Clock, CreditCard } from 'lucide-react-native';
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
  const showUpgrade = error.shouldShowUpgrade;
  const isPaidTierRateLimit = error.isRateLimitError && !showUpgrade;

  const handleUpgrade = () => {
    onDismiss();
    router.push('/(biglayout)/subscribe' as any);
  };

  const handleBuyCredits = () => {
    onDismiss();
    router.push('/(app)/billing' as any);
  };

  // Title
  let title: string;
  if (isCredits) {
    title = 'Out of credits';
  } else if (showUpgrade) {
    title = 'Limit reached';
  } else {
    title = 'Slow down';
  }

  // Description
  let description: string;
  if (isCredits) {
    description = 'Add more credits or upgrade your plan to continue chatting with Alia.';
  } else if (showUpgrade) {
    description = "You've reached the limit for your plan. Upgrade for more.";
  } else {
    description = countdown > 0
      ? `You've hit your rate limit. Try again in ${formatCountdown(countdown)}.`
      : "You've hit your rate limit. Please try again shortly.";
  }

  return (
    <Dialog open={!!error} onOpenChange={(open) => !open && onDismiss()}>
      <DialogContent closeButton={true}>
        <DialogHeader>
          <View className="items-center mb-3">
            {isCredits ? (
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
          {isCredits ? (
            <>
              <Button onPress={handleUpgrade} className="flex-1">
                <Text className="text-primary-foreground text-sm font-medium">Upgrade Plan</Text>
              </Button>
              <Button variant="outline" onPress={handleBuyCredits} className="flex-1">
                <Text className="text-sm font-medium">Buy Credits</Text>
              </Button>
            </>
          ) : showUpgrade ? (
            <>
              <Button onPress={handleUpgrade} className="flex-1">
                <Text className="text-primary-foreground text-sm font-medium">Upgrade Plan</Text>
              </Button>
              {countdown > 0 ? (
                <Button variant="outline" disabled className="flex-1">
                  <Text className="text-sm font-medium text-muted-foreground">
                    Try again in {formatCountdown(countdown)}
                  </Text>
                </Button>
              ) : (
                <Button variant="outline" onPress={onDismiss} className="flex-1">
                  <Text className="text-sm font-medium">Try Again</Text>
                </Button>
              )}
            </>
          ) : (
            <Button variant="outline" onPress={onDismiss} className="flex-1">
              <Text className="text-sm font-medium">
                {countdown > 0 ? `Try again in ${formatCountdown(countdown)}` : 'Got it'}
              </Text>
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
