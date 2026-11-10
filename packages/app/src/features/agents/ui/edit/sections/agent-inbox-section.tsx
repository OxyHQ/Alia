import { useAgentInbox } from '@/features/agents/runtime/use-agent-attention';
import { summarizeInboxItem } from '@/features/agents/ui/edit/sections/inbox-summary';
import { useTranslation } from '@/shared/i18n/use-translation';
import { SettingsSkeletonRows } from '@/shared/ui/skeletons';
import { AgentCreatorField, AgentCreatorSection } from '@oxy.so/bloom/agent-creator';
import { Text } from '@oxy.so/bloom/typography';

/** This section's own strings. */
const K = 'agents.editor.inbox';

/** What is waiting for the agent's next look. Read-only; every word of it is someone else's. */
export function AgentInboxSection({ agentId, name }: { agentId: string; name: string }) {
  const { t } = useTranslation();
  const { data: inbox, isPending, isError } = useAgentInbox(agentId);

  return (
    <AgentCreatorSection title={t(`${K}.title`)}>
      {isPending ? (
        <SettingsSkeletonRows control="none" rows={2} />
      ) : isError || !inbox ? (
        <AgentCreatorField label={t(`${K}.title`)} divider={false}>
          <Text variant="body-2-regular">{t(`${K}.loadFailed`)}</Text>
        </AgentCreatorField>
      ) : (
        <>
          <AgentCreatorField label={t(`${K}.looked`)} divider={false}>
            <Text variant="body-2-regular">
              {inbox.heartbeat.lastHeartbeatAt
                ? t(`${K}.lastLooked`, {
                    when: new Date(inbox.heartbeat.lastHeartbeatAt).toLocaleString(),
                  })
                : t(`${K}.neverLooked`, { name })}
            </Text>
          </AgentCreatorField>
          {inbox.items.length === 0 ? (
            <AgentCreatorField label={t(`${K}.waiting`)}>
              <Text variant="body-2-regular">{t(`${K}.empty`, { name })}</Text>
            </AgentCreatorField>
          ) : (
            inbox.items.map((item) => (
              <AgentCreatorField key={item.id} label={item.appId} multiline>
                <Text variant="body-2-regular">
                  {summarizeInboxItem(item.summary) ?? `${item.appId} · ${item.eventType}`}
                </Text>
              </AgentCreatorField>
            ))
          )}
        </>
      )}
    </AgentCreatorSection>
  );
}
