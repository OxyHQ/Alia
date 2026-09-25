import { contextCardProps } from '@/features/chat/model/context-usage';
import { agentLimitsProps } from '@/features/billing/model/credits-limits';
import { useSubscription } from '@/features/billing/runtime/use-billing';
import { useCredits } from '@/features/billing/runtime/use-credits';
import { useTranslation } from '@/shared/i18n/use-translation';
import { useStore } from '@/features/chat/runtime/global-store';
import { useUIStore } from '@/features/chat/runtime/ui-store';
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
 * and the subscription, with the open conversation's context window. Buying credits, the balance in numbers and the
 * transactions live in Settings › Usage (`src/features/settings/ui/billing-section.tsx`),
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
  // The open conversation's context window, as its latest turn filled it.
  const conversationId = useStore((s) => s.chatId?.id);
  const context = contextCardProps(useUIStore((s) => (conversationId ? s.contextUsage[conversationId] : undefined)), t);

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
            context={context}
            labels={{
              contextWindow: t('chat.bloom.context.title'),
              freeSpace: t('chat.bloom.context.freeSpace'),
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
