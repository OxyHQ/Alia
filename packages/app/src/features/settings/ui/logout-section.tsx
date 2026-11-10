import { useTranslation } from '@/shared/i18n/use-translation';
import { Button } from '@oxy.so/bloom/button';
import { RiLogoutCircleLine } from '@oxy.so/bloom/icons/RiLogoutCircleLine';
import type { SettingsPageSection } from '@oxy.so/bloom/settings-modal';
import { confirm } from '@oxy.so/bloom/surfaces';
import { useOxy } from '@oxy.so/services/ui/client';
import { useAliaSettings } from './settings-context';

/**
 * Log out, for the General page: this device's session only, after a confirm. The person's other
 * devices and Oxy apps stay signed in (`logoutAll` ends them all, and is not offered here).
 */
export function useLogoutSection(): SettingsPageSection {
  const { logout } = useOxy();
  const { afterClose } = useAliaSettings();
  const { t } = useTranslation();
  return {
    key: 'account',
    rows: [
      {
        key: 'logout',
        label: t('settings.general.logout'),
        control: (
          <Button
            size="sm"
            appearance="outline"
            tone="neutral"
            leadingIcon={RiLogoutCircleLine}
            onPress={async () => {
              const ok = await confirm({
                title: t('settings.general.logout'),
                description: t('settings.general.logoutConfirm'),
                confirmLabel: t('settings.general.logout'),
                destructive: true,
              });
              if (ok) afterClose(() => void logout());
            }}
          >
            {t('settings.general.logout')}
          </Button>
        ),
      },
    ],
  };
}
