import { useTranslation } from '@/shared/i18n/use-translation';
import { ButtonGroup, ButtonGroupItem } from '@oxy.so/bloom/button-group';
import { RiShare2Line } from '@oxy.so/bloom/icons/RiShare2Line';

/**
 * The agent screen's header: edit (owner only), chat (when this person may
 * talk to it), start a task, share.
 *
 * A private agent is in the catalogue for everyone but answers only its own
 * account (`canReachAgent` in the API): for anyone else its thread is "Agent
 * not found". Offering Chat there was a button that led to a dead end — on a
 * Pixel 8a it flashed "Agent not found" and seemed to do nothing (#608,
 * `docs/native-validation.mdx`).
 *
 * There used to be a "More" menu with two items, and neither did anything
 * (#608, rule 6). "Report" was a toast saying the report was submitted — no
 * request left the device, because no API route accepts one. "Bookmark" wrote
 * the id to AsyncStorage, and the only reader of that list was this same menu
 * deciding which icon to draw: no screen listed, sorted or filtered by it. Both
 * come back when there is something real behind them.
 */
export function AgentHeaderActions({
  isOwner,
  canChat,
  price,
  onEdit,
  onChat,
  onStartTask,
  onShare,
}: {
  isOwner: boolean;
  /** A public agent, or this person's own. */
  canChat: boolean;
  /** Credits per use, or null for a free agent. */
  price: number | null;
  onEdit: () => void;
  onChat: () => void;
  onStartTask: () => void;
  onShare: () => void;
}) {
  const { t } = useTranslation();

  return (
    <ButtonGroup accessibilityLabel={t('pages.agents.agentActions')}>
      {isOwner ? (
        <ButtonGroupItem onPress={onEdit}>{t('agents.edit')}</ButtonGroupItem>
      ) : null}
      {canChat ? <ButtonGroupItem onPress={onChat}>{t('agents.chat')}</ButtonGroupItem> : null}
      <ButtonGroupItem onPress={onStartTask}>
        {price != null
          ? t('agents.startTaskPriced', { count: price })
          : t('agents.startTask')}
      </ButtonGroupItem>
      <ButtonGroupItem
        iconOnly
        leadingIcon={RiShare2Line}
        accessibilityLabel={t('agents.share')}
        onPress={onShare}
      />
    </ButtonGroup>
  );
}
