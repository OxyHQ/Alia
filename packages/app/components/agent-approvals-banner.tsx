import { useDecideAgentApproval, usePendingAgentApprovals } from '@/lib/hooks/use-agent-approvals';
import { useTranslation } from '@/lib/hooks/use-translation';
import { Notification } from '@oxy.so/bloom/notification';
import { View } from 'react-native';

/**
 * What an agent is waiting on this person to approve, above its thread.
 *
 * The same warning `Notification` the live agent panel uses for an approval,
 * but for requests filed by background runs that did not wait for the answer:
 * approving one here starts the run that performs it.
 */
export function AgentApprovalsBanner({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const { data: approvals } = usePendingAgentApprovals(agentId);
  const decide = useDecideAgentApproval();
  if (!approvals?.length) return null;
  return (
    <View className="gap-2 px-4 pt-2">
      {approvals.map((approval) => (
        <Notification
          key={approval.id}
          status="warning"
          title={t('panels.agent.approvalRequired')}
          description={approval.summary}
          dismissible={false}
          actions={[
            {
              label: t('panels.agent.deny'),
              onPress: () => decide.mutate({ id: approval.id, approved: false }),
            },
            {
              label: t('panels.agent.approve'),
              onPress: () => decide.mutate({ id: approval.id, approved: true }),
            },
          ]}
        />
      ))}
    </View>
  );
}
