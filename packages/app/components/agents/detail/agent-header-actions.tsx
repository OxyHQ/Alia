import { useTranslation } from '@/lib/hooks/use-translation';
import { ButtonGroup, ButtonGroupItem } from '@oxy.so/bloom/button-group';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@oxy.so/bloom/dropdown-menu';
import {
  RiAlertLine,
  RiBookmarkFill,
  RiBookmarkLine,
} from '@oxy.so/bloom/icons';
import { RiMore2Line } from '@oxy.so/bloom/icons/RiMore2Line';
import { RiShare2Line } from '@oxy.so/bloom/icons/RiShare2Line';
import { toast } from '@oxy.so/bloom/toast';

/** The agent screen's header: edit (owner only), chat, start a task, share, more. */
export function AgentHeaderActions({
  isOwner,
  price,
  bookmarked,
  onEdit,
  onChat,
  onStartTask,
  onShare,
  onToggleBookmark,
}: {
  isOwner: boolean;
  /** Credits per use, or null for a free agent. */
  price: number | null;
  bookmarked: boolean;
  onEdit: () => void;
  onChat: () => void;
  onStartTask: () => void;
  onShare: () => void;
  onToggleBookmark: () => void;
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
          ? `${t('agents.startTask')} · ${price} credits`
          : t('agents.startTask')}
      </ButtonGroupItem>
      <ButtonGroupItem
        iconOnly
        leadingIcon={RiShare2Line}
        accessibilityLabel={t('agents.share')}
        onPress={onShare}
      />
      <DropdownMenu>
        <DropdownMenuTrigger label="Actions" asChild>
          <ButtonGroupItem
            iconOnly
            leadingIcon={RiMore2Line}
            accessibilityLabel={t('pages.agents.moreActions')}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem
            key="bookmark"
            onPress={onToggleBookmark}
            leading={
              bookmarked ? (
                <RiBookmarkFill size="sm" />
              ) : (
                <RiBookmarkLine size="sm" />
              )
            }
          >
            {bookmarked ? t('agents.removeBookmark') : t('agents.bookmark')}
          </DropdownMenuItem>
          <DropdownMenuItem
            key="report"
            onPress={() => toast.info(t('agents.reportSubmitted'))}
            leading={<RiAlertLine size="sm" />}
          >
            {t('agents.report')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
  );
}
