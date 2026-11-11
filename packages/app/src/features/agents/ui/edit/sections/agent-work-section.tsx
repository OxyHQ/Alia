import { useUpdateAgent } from '@/features/agents/runtime/use-agents';
import { useMyAgents } from '@/features/agents/runtime/use-my-agents';
import { EditorSelect } from '@/features/agents/ui/edit/sections/editor-select';
import { useTranslation } from '@/shared/i18n/use-translation';
import { SettingsSkeletonRows } from '@/shared/ui/skeletons';
import { AgentCreatorField, AgentCreatorSection } from '@oxy.so/bloom/agent-creator';
import { Switch } from '@oxy.so/bloom/switch';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { View } from 'react-native';

/** This section's own strings. */
const K = 'agents.editor.work';

/** How often a heartbeat may look, in minutes. A small fixed set, not a free number. */
const HEARTBEAT_CHOICES = [15, 30, 60, 240, 1440] as const;
/** What turning the heartbeat on starts at. */
const DEFAULT_HEARTBEAT = 60;

/**
 * How the agent works when nobody asks: whether it wakes up to look at what is waiting for it,
 * and how often, and whose computer it uses.
 */
export function AgentWorkSection({ agentId, name }: { agentId: string; name: string }) {
  const { t } = useTranslation();
  const { data: agents, isPending } = useMyAgents();
  const update = useUpdateAgent();
  const agent = agents?.find((candidate) => candidate._id === agentId);
  const interval = agent?.scheduleInterval ?? null;
  const source = agent?.computerSource ?? 'alia';

  const save = async (
    updates: { scheduleInterval: number | null } | { computerSource: 'alia' | 'own' },
  ) => {
    try {
      await update.mutateAsync({ id: agentId, updates });
    } catch {
      toast.error(t('settings.saveFailed'));
    }
  };

  const choices = [
    ...(interval !== null && !HEARTBEAT_CHOICES.some((choice) => choice === interval)
      ? [interval]
      : []),
    ...HEARTBEAT_CHOICES,
  ].map((minutes) => ({ value: String(minutes), label: t(`${K}.every`, { count: minutes }) }));

  return (
    <AgentCreatorSection title={t(`${K}.title`)}>
      {isPending ? (
        <SettingsSkeletonRows control="switch" rows={3} />
      ) : (
        <>
          <AgentCreatorField label={t(`${K}.heartbeat`)} divider={false}>
            <Switch
              accessibilityLabel={t(`${K}.heartbeatLabel`, { name })}
              checked={interval !== null}
              disabled={update.isPending}
              onCheckedChange={(on) => save({ scheduleInterval: on ? DEFAULT_HEARTBEAT : null })}
            />
          </AgentCreatorField>
          {interval !== null && (
            <AgentCreatorField label={t(`${K}.frequency`)}>
              <EditorSelect
                label={t(`${K}.frequencyLabel`)}
                value={String(interval)}
                items={choices}
                disabled={update.isPending}
                onChange={(value) => save({ scheduleInterval: Number(value) })}
              />
            </AgentCreatorField>
          )}
          <AgentCreatorField label={t(`${K}.computer`)}>
            <EditorSelect
              label={t(`${K}.computerLabel`, { name })}
              value={source}
              disabled={update.isPending}
              items={[
                { value: 'alia', label: t(`${K}.computerAlia`) },
                { value: 'own', label: t(`${K}.computerOwn`, { name }) },
              ]}
              onChange={(value) => save({ computerSource: value === 'own' ? 'own' : 'alia' })}
            />
          </AgentCreatorField>
          <View className="border-t border-border py-2.5 pe-2.5">
            <Text variant="body-2-regular" className="text-text-secondary">
              {t(`${K}.computerNote`, { name })}
            </Text>
          </View>
        </>
      )}
    </AgentCreatorSection>
  );
}
