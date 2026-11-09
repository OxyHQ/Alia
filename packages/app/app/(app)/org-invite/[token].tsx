import { AuthContainer } from '@/features/onboarding/ui/auth-container';
import { useTranslation } from '@/shared/i18n/use-translation';
import { EmptyState } from '@/shared/stickers/empty-state';
import { RiArrowRightLine } from '@oxy.so/bloom/icons/RiArrowRightLine';
import { useRouter } from 'expo-router';
import Head from 'expo-router/head';

export default function OrgInviteScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t('orgInvite.unavailableTitle')}</title>
      </Head>
      <AuthContainer>
        <EmptyState
          sticker="inviteUnavailable"
          title={t('orgInvite.unavailableTitle')}
          description={t('orgInvite.unavailableDescription')}
          action={{
            label: t('invitePage.goToAlia'),
            icon: RiArrowRightLine,
            onPress: () => router.replace('/(app)'),
          }}
        />
      </AuthContainer>
    </>
  );
}
