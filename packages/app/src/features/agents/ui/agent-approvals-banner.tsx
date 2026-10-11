import {
  type PendingAgentApproval,
  useDecideAgentApproval,
  usePendingAgentApprovals,
  usePendingConversationApprovals,
} from '@/features/agents/runtime/use-agent-approvals';
import { useTranslation } from '@/shared/i18n/use-translation';
import { Notification } from '@oxy.so/bloom/notification';
import { toast } from '@oxy.so/bloom/toast';
import { View } from 'react-native';

/**
 * The approval cards above a conversation: what Alia or an agent is waiting
 * on this person to approve.
 *
 * The same warning `Notification` the live agent panel uses for an approval,
 * for requests filed by turns that did not wait for the answer. A payment or
 * a deletion is performed by the approval itself, once; the decision carries
 * the hash of the exact action shown, so one that changed since is refused.
 */
function ApprovalCards({ approvals }: { approvals: PendingAgentApproval[] | undefined }) {
  const { t } = useTranslation();
  const decide = useDecideAgentApproval();
  if (!approvals?.length) return null;
  const answer = (approval: PendingAgentApproval, approved: boolean) =>
    decide.mutate(
      { id: approval.id, approved, ...(approval.hash ? { hash: approval.hash } : {}) },
      { onError: () => toast.error(t('panels.agent.approvalFailed')) },
    );
  return (
    <View className="gap-2 px-4 pt-2">
      {approvals.map((approval) => (
        <Notification
          key={approval.id}
          status="warning"
          title={
            approval.kind === 'payment'
              ? t('panels.agent.paymentApprovalRequired')
              : approval.kind === 'deletion'
                ? t('panels.agent.deletionApprovalRequired')
                : t('panels.agent.approvalRequired')
          }
          description={approval.summary}
          dismissible={false}
          actions={[
            { label: t('panels.agent.deny'), onPress: () => answer(approval, false) },
            { label: t('panels.agent.approve'), onPress: () => answer(approval, true) },
          ]}
        />
      ))}
    </View>
  );
}

/** Above an agent's thread: that agent's requests. */
export function AgentApprovalsBanner({ agentId }: { agentId: string }) {
  const { data } = usePendingAgentApprovals(agentId);
  return <ApprovalCards approvals={data} />;
}

/** Above an Alia conversation: the requests asked in it. */
export function ConversationApprovalsBanner({ conversationId }: { conversationId: string }) {
  const { data } = usePendingConversationApprovals(conversationId);
  return <ApprovalCards approvals={data} />;
}
