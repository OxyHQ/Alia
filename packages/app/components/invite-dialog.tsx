import { errorMessage } from '@/lib/errors/error-utils';
import {
  useRedeemInviteCode,
  useReferralHistory,
  useReferralInfo,
} from '@/lib/hooks/use-referrals';
import { useTranslation } from '@/lib/hooks/use-translation';
import { Button } from '@oxy.so/bloom/button';
import { Chip, ChipRow } from '@oxy.so/bloom/chip';
import { Dialog } from '@oxy.so/bloom/dialog';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { IconCircle } from '@oxy.so/bloom/icon-circle';
import { RiFileCopyLine } from '@oxy.so/bloom/icons/RiFileCopyLine';
import { RiHandHeartLine } from '@oxy.so/bloom/icons/RiHandHeartLine';
import { RiShareLine } from '@oxy.so/bloom/icons/RiShareLine';
import { RiUserHeartLine } from '@oxy.so/bloom/icons/RiUserHeartLine';
import { InputGroup, InputGroupAddon } from '@oxy.so/bloom/input-group';
import { Loading } from '@oxy.so/bloom/loading';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import { SettingsListGroup, SettingsListItem } from '@oxy.so/bloom/settings-list';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';
import * as Clipboard from 'expo-clipboard';
import React from 'react';
import { Linking, Share, View } from 'react-native';

type InviteTab = 'share' | 'redeem' | 'history';

/** Where the invite link can be posted, and the URL that posts it there. */
const SHARE_TARGETS: readonly { name: string; url: (link: string, text: string) => string }[] = [
  { name: 'X', url: (link, text) => `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(link)}` },
  { name: 'LinkedIn', url: (link) => `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(link)}` },
  { name: 'WhatsApp', url: (link, text) => `https://wa.me/?text=${encodeURIComponent(`${text}\n${link}`)}` },
  { name: 'Telegram', url: (link, text) => `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}` },
  { name: 'Facebook', url: (link) => `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(link)}` },
  { name: 'Reddit', url: (link, text) => `https://reddit.com/submit?url=${encodeURIComponent(link)}&title=${encodeURIComponent(text)}` },
  { name: 'Pinterest', url: (link, text) => `https://pinterest.com/pin/create/button/?url=${encodeURIComponent(link)}&description=${encodeURIComponent(text)}` },
];

interface InviteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Invite friends for credits: the link to share, a code to redeem, and who joined. */
export function InviteDialog({ open, onOpenChange }: InviteDialogProps) {
  const { t } = useTranslation();
  const [tab, setTab] = React.useState<InviteTab>('share');

  React.useEffect(() => {
    if (!open) setTab('share');
  }, [open]);

  return (
    <Dialog
      open={open}
      onClose={() => onOpenChange(false)}
      placement={{ base: 'bottom', md: 'center' }}
      title={t('dialogs.invite.title')}
      description={t('dialogs.invite.description')}
    >
      <View className="gap-4">
        <View className="items-center">
          <IconCircle icon={RiHandHeartLine} size="lg" />
        </View>
        <SegmentedControl type="tabs" label={t('dialogs.invite.title')} value={tab} onValueChange={setTab}>
          <SegmentedControlItem value="share">
            <SegmentedControlItemText>{t('dialogs.invite.tabShare')}</SegmentedControlItemText>
          </SegmentedControlItem>
          <SegmentedControlItem value="redeem">
            <SegmentedControlItemText>{t('dialogs.invite.tabRedeem')}</SegmentedControlItemText>
          </SegmentedControlItem>
          <SegmentedControlItem value="history">
            <SegmentedControlItemText>{t('dialogs.invite.tabHistory')}</SegmentedControlItemText>
          </SegmentedControlItem>
        </SegmentedControl>
        {tab === 'share' ? <ShareTab /> : tab === 'redeem' ? <RedeemTab /> : <HistoryTab />}
      </View>
    </Dialog>
  );
}

function ShareTab() {
  const { t } = useTranslation();
  const { data: referralInfo } = useReferralInfo();
  const [copied, setCopied] = React.useState(false);
  const inviteUrl = referralInfo?.inviteUrl ?? '';
  const shareText = t('dialogs.invite.shareText');

  const copy = async () => {
    if (!inviteUrl) return;
    await Clipboard.setStringAsync(inviteUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <View className="gap-4">
      <InputGroup>
        <TextFieldInput
          label={t('dialogs.invite.linkLabel')}
          value={inviteUrl}
          placeholder={t('common.loading')}
          editable={false}
          selectTextOnFocus
        />
        <InputGroupAddon noPadding>
          <Button size="sm" appearance="subtle" tone="neutral" leadingIcon={RiFileCopyLine} onPress={copy} disabled={!inviteUrl}>
            {t(copied ? 'dialogs.invite.copied' : 'dialogs.invite.copy')}
          </Button>
        </InputGroupAddon>
      </InputGroup>
      <ChipRow role="group" accessibilityLabel={t('dialogs.invite.shareOn')}>
        {SHARE_TARGETS.map((target) => (
          <Chip
            key={target.name}
            size="xl"
            disabled={!inviteUrl}
            onPress={() => {
              void Linking.openURL(target.url(inviteUrl, shareText));
            }}
          >
            {target.name}
          </Chip>
        ))}
      </ChipRow>
      <Button
        leadingIcon={RiShareLine}
        disabled={!inviteUrl}
        onPress={() => {
          void Share.share({ message: `${shareText}\n${inviteUrl}` });
        }}
      >
        {t('dialogs.invite.share')}
      </Button>
      <SettingsListGroup>
        <SettingsListItem
          title={t('dialogs.invite.creditsEarned')}
          value={String(referralInfo?.totalCreditsEarned ?? 0)}
          showChevron={false}
        />
        <SettingsListItem
          title={t('dialogs.invite.referrals')}
          value={String(referralInfo?.totalReferrals ?? 0)}
          showChevron={false}
        />
      </SettingsListGroup>
    </View>
  );
}

function RedeemTab() {
  const { t } = useTranslation();
  const [code, setCode] = React.useState('');
  const redeem = useRedeemInviteCode();
  const trimmed = code.trim();

  const submit = () => {
    if (!trimmed || redeem.isPending) return;
    redeem.mutate(trimmed, {
      onSuccess: (data) => {
        toast.success(t('dialogs.invite.redeemSuccess', { count: data.creditsAwarded }));
        setCode('');
      },
      onError: (error: unknown) => {
        toast.error(errorMessage(error, t('dialogs.invite.redeemInvalid')));
      },
    });
  };

  return (
    <InputGroup>
      <TextFieldInput
        label={t('dialogs.invite.codeLabel')}
        value={code}
        onValueChange={setCode}
        onSubmitEditing={submit}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <InputGroupAddon noPadding>
        <Button size="sm" onPress={submit} disabled={!trimmed} loading={redeem.isPending}>
          {t('dialogs.invite.redeem')}
        </Button>
      </InputGroupAddon>
    </InputGroup>
  );
}

function HistoryTab() {
  const { t } = useTranslation();
  const { data, isLoading } = useReferralHistory();

  if (isLoading) return <Loading />;
  if (!data?.referrals?.length) {
    return <EmptyState variant="compact" icon={RiUserHeartLine} title={t('dialogs.invite.noReferrals')} />;
  }
  return (
    <SettingsListGroup>
      {data.referrals.map((referral) => (
        <SettingsListItem
          key={`${referral.userId}-${referral.creditedAt}`}
          title={referral.email || t('common.user')}
          description={new Date(referral.creditedAt).toLocaleDateString()}
          value={`+${referral.creditsAwarded}`}
          showChevron={false}
        />
      ))}
    </SettingsListGroup>
  );
}
