import {
  useAgentSubscriptionMutations,
  useAgentSubscriptions,
  type AgentSubscription,
  type SubscriptionAccount,
} from '@/features/agents/runtime/use-agent-attention';
import { useEmailAlerts } from '@/features/notifications/runtime/use-email-alerts';
import { errorStatus } from '@/shared/api/error-utils';
import { useTranslation } from '@/shared/i18n/use-translation';
import { SettingsSkeletonRows } from '@/shared/ui/skeletons';
import { AgentCreatorField, AgentCreatorSection } from '@oxy.so/bloom/agent-creator';
import { Button } from '@oxy.so/bloom/button';
import { RiDeleteBinLine } from '@oxy.so/bloom/icons/RiDeleteBinLine';
import { Switch } from '@oxy.so/bloom/switch';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';

/** This section's own strings. */
const K = 'agents.editor.hears';

/** The one ready-made subscription: new email in the Inbox. */
const NEW_EMAIL = { appId: 'inbox', eventType: 'new_email' } as const;

/** Whether `subscription` hears the owner's events (otherwise the agent's own mailbox). */
const hearsOwner = (subscription: AgentSubscription) =>
  subscription.sourceAccountId === subscription.ownerAccountId;

const isNewEmail = (subscription: AgentSubscription) =>
  subscription.appId === NEW_EMAIL.appId && subscription.eventType === NEW_EMAIL.eventType;

/** The accounts a ready-made subscription may name, with the strings each toggle carries. */
const NEW_EMAIL_TOGGLES: ReadonlyArray<{ account: SubscriptionAccount; key: string }> = [
  { account: 'owner', key: 'newEmailOwner' },
  { account: 'agent', key: 'newEmailAgent' },
];

/**
 * What the agent hears about on its own: new emails (the person's, its own mailbox), any other
 * subscription it holds, and whether it may write to the person when its own mailbox gets
 * something important.
 */
export function AgentHearsSection({ agentId, name }: { agentId: string; name: string }) {
  const { t } = useTranslation();
  const { data: subscriptions, isPending, isError } = useAgentSubscriptions(agentId);
  const { subscribe, unsubscribe } = useAgentSubscriptionMutations(agentId);
  const { alerts, setEnabled } = useEmailAlerts();
  const busy = subscribe.isPending || unsubscribe.isPending;
  const alert = alerts?.agents.find((candidate) => candidate.agentId === agentId);

  const toggle = async (account: SubscriptionAccount, on: boolean) => {
    if (!subscriptions) return;
    try {
      if (on) {
        await subscribe.mutateAsync({ ...NEW_EMAIL, account });
        return;
      }
      const owner = account === 'owner';
      const matching = subscriptions.filter((s) => isNewEmail(s) && hearsOwner(s) === owner);
      for (const subscription of matching) await unsubscribe.mutateAsync(subscription.id);
    } catch (error) {
      // 409: the agent already holds as many subscriptions as it may.
      toast.error(errorStatus(error) === 409 ? t(`${K}.limitReached`) : t(`${K}.subscribeFailed`));
    }
  };

  const remove = async (subscription: AgentSubscription) => {
    try {
      await unsubscribe.mutateAsync(subscription.id);
    } catch {
      toast.error(t(`${K}.unsubscribeFailed`));
    }
  };

  return (
    <AgentCreatorSection title={t(`${K}.title`)}>
      {isPending ? (
        <SettingsSkeletonRows control="switch" rows={3} />
      ) : isError || !subscriptions ? (
        <AgentCreatorField label={t(`${K}.title`)} divider={false}>
          <Text variant="body-2-regular">{t(`${K}.loadFailed`)}</Text>
        </AgentCreatorField>
      ) : (
        <>
          {NEW_EMAIL_TOGGLES.map(({ account, key }, index) => (
            <AgentCreatorField key={account} label={t(`${K}.${key}`)} divider={index > 0}>
              <Switch
                accessibilityLabel={t(`${K}.${key}Label`, { name })}
                checked={subscriptions.some(
                  (s) => isNewEmail(s) && hearsOwner(s) === (account === 'owner'),
                )}
                disabled={busy}
                onCheckedChange={(on) => toggle(account, on)}
              />
            </AgentCreatorField>
          ))}
          {alert && (
            <AgentCreatorField label={t(`${K}.important`)}>
              <Switch
                accessibilityLabel={t(`${K}.importantLabel`, { name })}
                checked={alert.enabled}
                onCheckedChange={(enabled) => setEnabled(agentId, enabled)}
              />
            </AgentCreatorField>
          )}
          {subscriptions
            .filter((s) => !isNewEmail(s))
            .map((subscription) => (
              <AgentCreatorField key={subscription.id} label={subscription.appId}>
                <Button
                  size="sm"
                  appearance="outline"
                  tone="danger"
                  leadingIcon={RiDeleteBinLine}
                  disabled={busy}
                  accessibilityLabel={`${t(`${K}.remove`)} ${subscription.appId} ${subscription.eventType}`}
                  onPress={() => remove(subscription)}
                >
                  {`${subscription.eventType} · ${t(hearsOwner(subscription) ? `${K}.sourceOwner` : `${K}.sourceAgent`)}`}
                </Button>
              </AgentCreatorField>
            ))}
        </>
      )}
    </AgentCreatorSection>
  );
}
