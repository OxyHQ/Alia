import { useTranslation } from '@/shared/i18n/use-translation';
import { Button } from '@oxy.so/bloom/button';
import { RiExternalLinkLine } from '@oxy.so/bloom/icons/RiExternalLinkLine';
import { RiLogoutCircleLine } from '@oxy.so/bloom/icons/RiLogoutCircleLine';
import {
  SettingsProfilePage,
  SettingsValueField,
} from '@oxy.so/bloom/settings-modal';
import { confirm } from '@oxy.so/bloom/surfaces';
import { getAccountDisplayName } from '@oxy.so/core';
import { useOxy } from '@oxy.so/services';
import { useAliaSettings } from './settings-context';

/**
 * The story's Profile page over the Oxy account. The identity is Oxy's, so
 * the fields are read-only here and editing happens in Oxy's own account
 * surface ("Manage").
 */
export function ProfileSection() {
  const { user, showBottomSheet, logoutAll } = useOxy();
  const { afterClose } = useAliaSettings();
  const { t, locale } = useTranslation();

  const name = user ? getAccountDisplayName(user, locale) : '';

  return (
    <SettingsProfilePage
      sections={[
        {
          key: 'identity',
          rows: [
            {
              key: 'name',
              label: t('settings.profile.name'),
              control: <SettingsValueField>{name}</SettingsValueField>,
            },
            {
              key: 'username',
              label: t('settings.profile.username'),
              control: (
                <SettingsValueField>{user?.username ? `@${user.username}` : ''}</SettingsValueField>
              ),
            },
            ...(user?.email
              ? [
                  {
                    key: 'email',
                    label: t('settings.profile.email'),
                    control: <SettingsValueField>{user.email}</SettingsValueField>,
                  },
                ]
              : []),
          ],
        },
        {
          key: 'account',
          rows: [
            {
              key: 'account',
              label: t('settings.profile.oxyAccount'),
              description: t('settings.profile.oxyAccountDescription'),
              control: (
                <Button
                  size="sm"
                  appearance="outline"
                  tone="neutral"
                  leadingIcon={RiExternalLinkLine}
                  onPress={() => afterClose(() => showBottomSheet?.('ManageAccount'))}
                >
                  {t('settings.profile.manage')}
                </Button>
              ),
            },
            {
              key: 'user-id',
              label: t('settings.profile.userId'),
              control: <SettingsValueField muted>{user?.id ?? ''}</SettingsValueField>,
            },
            {
              key: 'logout',
              label: t('settings.profile.logoutAll'),
              control: (
                <Button
                  size="sm"
                  appearance="outline"
                  tone="neutral"
                  leadingIcon={RiLogoutCircleLine}
                  onPress={async () => {
                    const ok = await confirm({
                      title: t('settings.profile.logoutAll'),
                      description: t('settings.profile.logoutAllConfirm'),
                      confirmLabel: t('settings.profile.logout'),
                      destructive: true,
                    });
                    if (ok) afterClose(() => void logoutAll());
                  }}
                >
                  {t('settings.profile.logout')}
                </Button>
              ),
            },
          ],
        },
      ]}
    />
  );
}
