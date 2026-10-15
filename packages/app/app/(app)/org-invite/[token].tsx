import { AuthContainer } from '@/features/onboarding/ui/auth-container';
import { useTranslation } from '@/shared/i18n/use-translation';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiArrowRightLine } from '@oxy.so/bloom/icons/RiArrowRightLine';
import { RiErrorWarningLine } from '@oxy.so/bloom/icons/RiErrorWarningLine';
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
          icon={RiErrorWarningLine}
          media="circle"
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
