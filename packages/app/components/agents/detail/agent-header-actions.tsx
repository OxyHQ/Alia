import { useTranslation } from '@/lib/hooks/use-translation';
import { ButtonGroup, ButtonGroupItem } from '@oxy.so/bloom/button-group';
import { RiShare2Line } from '@oxy.so/bloom/icons/RiShare2Line';

/**
 * The agent screen's header: edit (owner only), chat, start a task, share.
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
  price,
  onEdit,
  onChat,
  onStartTask,
  onShare,
}: {
  isOwner: boolean;
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
      <ButtonGroupItem onPress={onChat}>{t('agents.chat')}</ButtonGroupItem>
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
