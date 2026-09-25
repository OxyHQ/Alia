import { contextCardProps } from '@/features/chat/model/context-usage';
import { agentLimitsProps } from '@/features/billing/model/credits-limits';
import { useSubscription } from '@/features/billing/runtime/use-billing';
import { useCredits } from '@/features/billing/runtime/use-credits';
import { useTranslation } from '@/shared/i18n/use-translation';
import { useUIStore } from '@/features/chat/runtime/ui-store';
import { AgentLimitsCard } from '@oxy.so/bloom/agent-limits-card';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { useRouter } from 'expo-router';
import { useAliaSettings } from './settings-context';

/**
 * Settings › Usage: how much of the plan's limits is spent and how full the
 * latest conversation's context window is, as Bloom's `AgentLimitsCard` — the
 * same card and the same numbers as the right panel's credits slot. Its plan arrow leads to Billing when subscribed and to the
 * plans otherwise.
 */
export function UsageSection() {
  const { t } = useTranslation();
  const router = useRouter();
  const settings = useAliaSettings();
  const { data: credits, isLoading } = useCredits();
  const { data: subscription } = useSubscription();
  const { plan, limits } = agentLimitsProps(credits, subscription, Date.now(), t);
  const subscribed = subscription?.status === 'active';
  // The latest conversation's context window, as ChatGPT and Claude show it.
  const context = contextCardProps(useUIStore((s) => s.lastContextUsage), t);

  if (isLoading) return <Skeleton.Box width="100%" height={112} borderRadius={16} />;

  return (
    <AgentLimitsCard
      plan={plan}
      limits={limits}
      onPlanPress={() => (subscribed ? settings.open('usage') : router.push('/(biglayout)/subscribe'))}
      context={context}
      labels={{
        contextWindow: t('chat.bloom.context.title'),
        freeSpace: t('chat.bloom.context.freeSpace'),
        planUsageLimits: t('chat.bloom.limits.planUsage'),
        managePlan: subscribed ? t('credits.manageBilling') : t('credits.upgrade'),
      }}
      testID="settings-usage"
    />
  );
}
