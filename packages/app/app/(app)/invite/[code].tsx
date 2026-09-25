import { AuthContainer } from '@/features/onboarding/ui/auth-container';
import { AuthLogo } from '@/features/onboarding/ui/auth-logo';
import { errorMessage } from '@/shared/api/error-utils';
import { useRedeemInviteCode } from '@/features/onboarding/runtime/use-referrals';
import { useTranslation } from '@/shared/i18n/use-translation';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiArrowRightLine } from '@oxy.so/bloom/icons/RiArrowRightLine';
import { RiGiftLine } from '@oxy.so/bloom/icons/RiGiftLine';
import { RiLoginBoxLine } from '@oxy.so/bloom/icons/RiLoginBoxLine';
import { RiUserHeartLine } from '@oxy.so/bloom/icons/RiUserHeartLine';
import { Loading } from '@oxy.so/bloom/loading';
import { useAuth } from '@oxy.so/services';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Head from 'expo-router/head';
import { useEffect, useState } from 'react';

/**
 * What an invite earns each side, before there is an answer to say so.
 *
 * The API's `REFERRAL_CREDIT_REWARD` (`routes/referrals.ts`), which no public
 * endpoint serves to a signed-out visitor. Once redeemed, the page shows what
 * the API actually awarded (`creditsAwarded`) rather than this.
 */
const REFERRAL_CREDITS = 500;

export default function InviteScreen() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const router = useRouter();
  const { isAuthenticated, isLoading: authLoading, signIn } = useAuth();
  const redeemMutation = useRedeemInviteCode();
  const { t } = useTranslation();
  const [redeemed, setRedeemed] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Auto-redeem when authenticated
  useEffect(() => {
    if (!isAuthenticated || authLoading || redeemed !== null || !code) return;
    if (redeemMutation.isPending) return;

    redeemMutation.mutate(code, {
      onSuccess: (data) => {
        setRedeemed(data.creditsAwarded);
      },
      onError: (err: any) => {
        const message = errorMessage(err, t('invitePage.redeemFailed'));
        setError(message);
      },
    });
  }, [isAuthenticated, authLoading, code, redeemed]);

  if (authLoading) {
    return (
      <AuthContainer>
        <AuthLogo />
        <Loading text={t('common.loading')} />
      </AuthContainer>
    );
  }

  // Authenticated: show redeem result
  if (isAuthenticated) {
    return (
      <>
        <Head>
          <title>{t('invitePage.acceptTitle')}</title>
          <meta
            name="description"
            content={t('invitePage.acceptMeta', { count: REFERRAL_CREDITS })}
          />
        </Head>
        <AuthContainer>
          {redeemed !== null ? (
            <EmptyState
              icon={RiGiftLine}
              media="circle"
              title={t('invitePage.redeemedTitle', { count: redeemed })}
              description={t('invitePage.redeemedDescription', {
                count: redeemed,
              })}
              action={{
                label: t('invitePage.startChatting'),
                icon: RiArrowRightLine,
                onPress: () => router.replace('/(app)'),
              }}
            />
          ) : error ? (
            <EmptyState
              icon={RiUserHeartLine}
              title={t('invitePage.redeemErrorTitle')}
              description={error}
              action={{
                label: t('invitePage.goToAlia'),
                icon: RiArrowRightLine,
                onPress: () => router.replace('/(app)'),
              }}
            />
          ) : (
            <EmptyState
              icon={RiUserHeartLine}
              media="circle"
              title={
                redeemMutation.isPending ? t('invitePage.redeeming') : undefined
              }
              description={
                redeemMutation.isPending
                  ? t('invitePage.redeemingDescription')
                  : undefined
              }
            />
          )}
        </AuthContainer>
      </>
    );
  }

  // Not authenticated: show signup prompt
  return (
    <>
      <Head>
        <title>{t('invitePage.invitedTitle')}</title>
        <meta
          name="description"
          content={t('invitePage.invitedMeta', { count: REFERRAL_CREDITS })}
        />
      </Head>
      <AuthContainer>
        <EmptyState
          icon={RiUserHeartLine}
          media="circle"
          title={t('invitePage.invitedHeading')}
          description={t('invitePage.invitedDescription', {
            count: REFERRAL_CREDITS,
          })}
          action={{
            label: t('invitePage.signUp'),
            icon: RiGiftLine,
            onPress: () => signIn().catch(() => {}),
          }}
          secondaryAction={{
            label: t('invitePage.signIn'),
            icon: RiLoginBoxLine,
            onPress: () => signIn().catch(() => {}),
          }}
        />
      </AuthContainer>
    </>
  );
}
