import { agentLimitsProps } from '@/lib/credits-limits';
import { useSubscription } from '@/lib/hooks/use-billing';
import { useCredits } from '@/lib/hooks/use-credits';
import { useTranslation } from '@/lib/hooks/use-translation';
import { useUIStore } from '@/lib/stores/ui-store';
import { AgentLimitsCard } from '@oxy.so/bloom/agent-limits-card';
import { useAiChatShell } from '@oxy.so/bloom/ai-chat';
import { Button } from '@oxy.so/bloom/button';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { PageHeader } from '@oxy.so/bloom/page-header';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { useRouter } from 'expo-router';
import { View } from 'react-native';

/**
 * The right panel's credits slot: Bloom's `AgentLimitsCard` over `/credits`
 * and the subscription. Buying credits, the balance in numbers and the
 * transactions live in Settings › Usage (`components/settings/billing-section.tsx`),
 * one press away through the card's plan arrow.
 */
export function CreditsLimits() {
  const shell = useAiChatShell();
  const router = useRouter();
  const { t } = useTranslation();
  const setRightPanel = useUIStore((s) => s.setRightPanel);
  const { data: credits, isLoading } = useCredits();
  const { data: subscription } = useSubscription();
  const { plan, limits } = agentLimitsProps(credits, subscription, Date.now(), t);
  const subscribed = subscription?.status === 'active';

  const openPlan = () => {
    setRightPanel(null);
    router.push(subscribed ? '/(app)/settings/usage' : '/(biglayout)/subscribe');
  };

  return (
    <View className="flex-1">
      {shell?.compact ? null : (
        <PageHeader
          title={t('credits.title')}
          actions={
            <Button
              appearance="plain"
              tone="neutral"
              size="xs"
              accessibilityLabel={t('chat.bloom.limits.close')}
              onPress={() => setRightPanel(null)}
              icon={<RiCloseLine />}
            />
          }
        />
      )}
      <View className="p-4">
        {isLoading ? (
          <Skeleton.Box width="100%" height={112} borderRadius={16} />
        ) : (
          <AgentLimitsCard
            plan={plan}
            limits={limits}
            onPlanPress={openPlan}
            labels={{
              planUsageLimits: t('chat.bloom.limits.planUsage'),
              managePlan: subscribed ? t('credits.manageBilling') : t('credits.upgrade'),
            }}
            testID="credits-limits"
          />
        )}
      </View>
    </View>
  );
}
