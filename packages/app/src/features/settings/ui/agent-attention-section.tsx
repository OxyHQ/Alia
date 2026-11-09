import { useMyAgents } from '@/features/agents/runtime/use-my-agents';
import { useUpdateAgent } from '@/features/agents/runtime/use-agents';
import {
  useAgentInbox,
  useAgentSubscriptionMutations,
  useAgentSubscriptions,
  type AgentSubscription,
  type SubscriptionAccount,
} from '@/features/agents/runtime/use-agent-attention';
import { errorStatus } from '@/shared/api/error-utils';
import { useTranslation } from '@/shared/i18n/use-translation';
import { SettingsRowsSkeleton, SettingsSkeletonRows } from '@/shared/ui/skeletons';
import { Button } from '@oxy.so/bloom/button';
import { RiArrowLeftLine } from '@oxy.so/bloom/icons/RiArrowLeftLine';
import { RiDeleteBinLine } from '@oxy.so/bloom/icons/RiDeleteBinLine';
import { SettingsCard, SettingsRow, SettingsSection } from '@oxy.so/bloom/settings-modal';
import { SettingsSelect } from '@oxy.so/bloom/settings-modal/rows';
import { Switch } from '@oxy.so/bloom/switch';
import { toast } from '@oxy.so/bloom/toast';
import { View } from 'react-native';
import { summarizeInboxItem } from './agent-attention-summary';
import { useAliaSettings } from './settings-context';

/** This page's own strings. */
const K = 'settings.assistant.attention';

/** How often a heartbeat may look, in minutes. A small fixed set, not a free number. */
export const HEARTBEAT_CHOICES = [15, 30, 60, 240, 1440] as const;
/** What turning the heartbeat on starts at. */
const DEFAULT_HEARTBEAT = 60;

/** The one ready-made subscription: new email in the Inbox. */
const NEW_EMAIL = { appId: 'inbox', eventType: 'new_email' } as const;

/** Whether `subscription` hears the owner's events (otherwise the agent's own mailbox). */
const hearsOwner = (subscription: AgentSubscription) =>
  subscription.sourceAccountId === subscription.ownerAccountId;

const isNewEmail = (subscription: AgentSubscription) =>
  subscription.appId === NEW_EMAIL.appId && subscription.eventType === NEW_EMAIL.eventType;

/** The accounts a ready-made subscription may name, with the label each toggle carries. */
const NEW_EMAIL_TOGGLES: ReadonlyArray<{ account: SubscriptionAccount; key: string }> = [
  { account: 'owner', key: 'newEmailOwner' },
  { account: 'agent', key: 'newEmailAgent' },
];

/**
 * The person's agents, each opening what it notices on its own — a section of the memory page,
 * beside what the agents remember.
 */
export function AttentionAgentsSection() {
  const { t } = useTranslation();
  const settings = useAliaSettings();
  const { data: agents, isPending } = useMyAgents();

  return (
    <SettingsSection label={t(`${K}.agentsTitle`)}>
      <SettingsCard>
        {isPending ? (
          <SettingsSkeletonRows rows={2} />
        ) : !agents?.length ? (
          <SettingsRow
            label={t(`${K}.agentsEmpty`)}
            description={t(`${K}.agentsEmptyDescription`)}
          />
        ) : (
          agents.map((agent) => (
            <SettingsRow
              key={agent._id}
              label={agent.name ?? (agent.handle ? `@${agent.handle}` : t(`${K}.unnamedAgent`))}
              description={t(`${K}.agentsDescription`)}
            >
              <Button
                size="sm"
                appearance="outline"
                tone="neutral"
                onPress={() =>
                  settings.open('agent-attention', {
                    agentId: agent._id,
                    name: agent.name ?? agent.handle ?? '',
                  })
                }
              >
                {t(`${K}.open`)}
              </Button>
            </SettingsRow>
          ))
        )}
      </SettingsCard>
    </SettingsSection>
  );
}

/** How often the agent looks, or off. */
function HeartbeatCard({ agentId, name }: { agentId: string; name: string }) {
  const { t } = useTranslation();
  const { data: agents, isPending } = useMyAgents();
  const update = useUpdateAgent();
  const agent = agents?.find((candidate) => candidate._id === agentId);
  const interval = agent?.scheduleInterval ?? null;

  if (isPending) return <SettingsRowsSkeleton control="switch" rows={2} />;

  const save = async (scheduleInterval: number | null) => {
    try {
      await update.mutateAsync({ id: agentId, updates: { scheduleInterval } });
    } catch {
      toast.error(t('settings.saveFailed'));
    }
  };

  const choices = [
    ...(interval !== null && !HEARTBEAT_CHOICES.some((choice) => choice === interval)
      ? [interval]
      : []),
    ...HEARTBEAT_CHOICES,
  ].map((minutes) => ({
    value: String(minutes),
    label: t(`${K}.every`, { count: minutes }),
  }));

  return (
    <SettingsCard>
      <SettingsRow
        label={t(`${K}.heartbeat`)}
        description={t(`${K}.heartbeatDescription`, { name })}
      >
        <Switch
          accessibilityLabel={t(`${K}.heartbeat`)}
          checked={interval !== null}
          disabled={update.isPending}
          onCheckedChange={(on) => save(on ? DEFAULT_HEARTBEAT : null)}
        />
      </SettingsRow>
      {interval !== null && (
        <SettingsRow label={t(`${K}.frequency`)} description={t(`${K}.frequencyDescription`)}>
          <SettingsSelect
            label={t(`${K}.frequency`)}
            value={String(interval)}
            onChange={(value: string) => save(Number(value))}
            items={choices}
          />
        </SettingsRow>
      )}
    </SettingsCard>
  );
}

/** The ready-made toggles and every subscription that is not one of them. */
function SubscriptionsCard({ agentId, name }: { agentId: string; name: string }) {
  const { t } = useTranslation();
  const { data: subscriptions, isPending, isError } = useAgentSubscriptions(agentId);
  const { subscribe, unsubscribe } = useAgentSubscriptionMutations(agentId);
  const busy = subscribe.isPending || unsubscribe.isPending;

  if (isPending) return <SettingsRowsSkeleton control="switch" rows={2} />;
  if (isError || !subscriptions) {
    return (
      <SettingsCard>
        <SettingsRow label={t(`${K}.loadFailed`)} />
      </SettingsCard>
    );
  }

  const toggle = async (account: SubscriptionAccount, on: boolean) => {
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

  const others = subscriptions.filter((s) => !isNewEmail(s));

  const remove = async (subscription: AgentSubscription) => {
    try {
      await unsubscribe.mutateAsync(subscription.id);
    } catch {
      toast.error(t(`${K}.unsubscribeFailed`));
    }
  };

  return (
    <>
      <SettingsCard>
        {NEW_EMAIL_TOGGLES.map(({ account, key }) => (
          <SettingsRow
            key={account}
            label={t(`${K}.${key}`, { name })}
            description={t(`${K}.${key}Description`, { name })}
          >
            <Switch
              accessibilityLabel={t(`${K}.${key}`, { name })}
              checked={subscriptions.some(
                (s) => isNewEmail(s) && hearsOwner(s) === (account === 'owner'),
              )}
              disabled={busy}
              onCheckedChange={(on) => toggle(account, on)}
            />
          </SettingsRow>
        ))}
      </SettingsCard>
      {others.length > 0 && (
        <SettingsCard>
          {others.map((subscription) => (
            <SettingsRow
              key={subscription.id}
              label={`${subscription.appId} · ${subscription.eventType}`}
              description={t(hearsOwner(subscription) ? `${K}.sourceOwner` : `${K}.sourceAgent`)}
            >
              <Button
                size="sm"
                appearance="outline"
                tone="danger"
                leadingIcon={RiDeleteBinLine}
                disabled={busy}
                accessibilityLabel={`${t(`${K}.remove`)} ${subscription.appId} ${subscription.eventType}`}
                onPress={() => remove(subscription)}
              >
                {t(`${K}.remove`)}
              </Button>
            </SettingsRow>
          ))}
        </SettingsCard>
      )}
    </>
  );
}

/** What is waiting for the agent's next look. Read-only; every word of it is someone else's. */
function InboxCard({ agentId, name }: { agentId: string; name: string }) {
  const { t } = useTranslation();
  const { data: items, isPending, isError } = useAgentInbox(agentId);

  if (isPending) return <SettingsRowsSkeleton control="none" rows={2} />;
  if (isError || !items) {
    return (
      <SettingsCard>
        <SettingsRow label={t(`${K}.loadFailed`)} />
      </SettingsCard>
    );
  }
  return (
    <SettingsCard>
      {items.length === 0 ? (
        <SettingsRow label={t(`${K}.inboxEmpty`, { name })} />
      ) : (
        items.map((item) => (
          <SettingsRow
            key={item.id}
            label={summarizeInboxItem(item.summary) ?? `${item.appId} · ${item.eventType}`}
            description={`${item.appId} · ${item.eventType}`}
          />
        ))
      )}
    </SettingsCard>
  );
}

/** What one agent notices on its own: its heartbeat, what it hears about, and what is waiting. */
export function AgentAttentionSection() {
  const { t } = useTranslation();
  const settings = useAliaSettings();
  const agentId = settings.params.agentId ?? '';
  const name = settings.params.name || t(`${K}.unnamedAgent`);

  return (
    <View className="w-full gap-6">
      <SettingsCard>
        <SettingsRow label={name} description={t(`${K}.description`, { name })}>
          <Button
            size="sm"
            appearance="outline"
            tone="neutral"
            leadingIcon={RiArrowLeftLine}
            onPress={() => settings.open('memory')}
          >
            {t(`${K}.back`)}
          </Button>
        </SettingsRow>
      </SettingsCard>

      <SettingsSection label={t(`${K}.heartbeatTitle`)}>
        <HeartbeatCard agentId={agentId} name={name} />
      </SettingsSection>

      <SettingsSection label={t(`${K}.subscriptionsTitle`)}>
        <SubscriptionsCard agentId={agentId} name={name} />
      </SettingsSection>

      <SettingsSection label={t(`${K}.inboxTitle`)}>
        <InboxCard agentId={agentId} name={name} />
      </SettingsSection>
    </View>
  );
}
