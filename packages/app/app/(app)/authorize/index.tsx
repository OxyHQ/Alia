import { AuthContainer } from '@/features/onboarding/ui/auth-container';
import { AuthLogo } from '@/features/onboarding/ui/auth-logo';
import { useChannelLink } from '@/features/onboarding/runtime/use-channel-link';
import { useTranslation } from '@/shared/i18n/use-translation';
import { StatusSkeleton } from '@/shared/ui/skeletons';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiCheckboxCircleLine } from '@oxy.so/bloom/icons/RiCheckboxCircleLine';
import { RiCloseCircleLine } from '@oxy.so/bloom/icons/RiCloseCircleLine';
import { RiLockLine } from '@oxy.so/bloom/icons/RiLockLine';
import { Loading } from '@oxy.so/bloom/loading';
import { Muted } from '@oxy.so/bloom/typography';
import { useLocalSearchParams } from 'expo-router';
import Head from 'expo-router/head';

/**
 * Links a system bot's chat (Discord) to the signed-in account.
 *
 * The channel link is the only flow here.
 */
const CHANNEL_NAMES: Record<string, string> = {
  discord: 'Discord',
};

function channelDisplayName(channel: string): string {
  return CHANNEL_NAMES[channel] ?? channel.charAt(0).toUpperCase() + channel.slice(1);
}

export default function AuthorizeScreen() {
  const params = useLocalSearchParams();
  const { t } = useTranslation();

  const app = typeof params.app === 'string' && params.app ? params.app : 'discord';
  const channel = params.channel as string | undefined;
  const displayName = channelDisplayName(channel || app);
  const { authLoading, status, message, retry } = useChannelLink({
    token: params.token,
    channelType: channel || app,
    displayName,
  });

  if (authLoading || status === 'loading') {
    return (
      <AuthContainer>
        <AuthLogo />
        <StatusSkeleton />
      </AuthContainer>
    );
  }

  return (
    <>
      <Head>
        <title>{t('authorize.authorizeApp', { app: displayName })}</title>
        <meta name="description" content={t('authorize.appWantsAccess', { app: displayName })} />
        <meta name="robots" content="noindex, nofollow" />
      </Head>
      <AuthContainer>
        <AuthLogo />

        {status === 'authorizing' && (
          <EmptyState
            illustration={<Loading />}
            title={t('authorize.linkingAccount')}
            description={t('authorize.pleaseWait')}
          />
        )}

        {status === 'needLogin' && (
          <EmptyState
            icon={RiLockLine}
            media="circle"
            title={t('authorize.authRequired')}
            description={message}
          />
        )}

        {status === 'success' && (
          <EmptyState
            icon={RiCheckboxCircleLine}
            media="circle"
            title={t('authorize.linked')}
            description={message}
            footer={
              <Muted className="text-center">
                {t('authorize.returnToApp', { app: displayName })}
              </Muted>
            }
          />
        )}

        {status === 'error' && (
          <EmptyState
            icon={RiCloseCircleLine}
            media="circle"
            title={t('authorize.linkFailed')}
            description={message}
            action={{ label: t('common.tryAgain'), onPress: retry }}
          />
        )}
      </AuthContainer>
    </>
  );
}
