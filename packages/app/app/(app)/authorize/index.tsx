import { AuthContainer } from '@/components/auth/auth-container';
import { AuthLogo } from '@/components/auth/auth-logo';
import { useChannelLink } from '@/lib/hooks/auth/use-channel-link';
import { useTranslation } from '@/lib/hooks/use-translation';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiCheckboxCircleLine } from '@oxy.so/bloom/icons/RiCheckboxCircleLine';
import { RiCloseCircleLine } from '@oxy.so/bloom/icons/RiCloseCircleLine';
import { RiLockLine } from '@oxy.so/bloom/icons/RiLockLine';
import { Loading } from '@oxy.so/bloom/loading';
import { Muted } from '@oxy.so/bloom/typography';
import { useLocalSearchParams } from 'expo-router';
import Head from 'expo-router/head';
import { Linking, Platform } from 'react-native';

/**
 * Links a chat channel (Telegram, Discord, ...) to the signed-in account.
 *
 * This screen once also ran a PKCE authorize flow for Codea and Cowork against
 * `POST /auth/authorize/:app`. Both clients sign in with Oxy directly now and
 * that endpoint is gone, so the channel link is the only flow left here.
 */
const CHANNEL_NAMES: Record<string, string> = {
  telegram: 'Telegram',
  discord: 'Discord',
};

function channelDisplayName(channel: string): string {
  return CHANNEL_NAMES[channel] ?? channel.charAt(0).toUpperCase() + channel.slice(1);
}

export default function AuthorizeScreen() {
  const params = useLocalSearchParams();
  const { t } = useTranslation();

  const app = typeof params.app === 'string' && params.app ? params.app : 'telegram';
  const channel = params.channel as string | undefined;
  const displayName = channelDisplayName(channel || app);
  const { authLoading, status, message, retry } = useChannelLink({
    token: params.token,
    app,
    channelType: channel || app,
    displayName,
  });

  if (authLoading || status === 'loading') {
    return (
      <AuthContainer>
        <AuthLogo />
        <Loading text={t('common.loading')} />
      </AuthContainer>
    );
  }

  const requestNewLink = () => {
    const botUsername = process.env.EXPO_PUBLIC_TELEGRAM_BOT_USERNAME || 'alia_onlbot';
    const botUrl = `https://t.me/${botUsername}?start=link`;
    if (Platform.OS === 'web') {
      window.open(botUrl, '_blank');
    } else {
      Linking.openURL(botUrl);
    }
  };

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
              <Muted className="text-center">{t('authorize.returnToApp', { app: displayName })}</Muted>
            }
          />
        )}

        {status === 'error' && (
          <EmptyState
            icon={RiCloseCircleLine}
            media="circle"
            title={t('authorize.linkFailed')}
            description={message}
            action={
              message.includes('expired')
                ? { label: t('authorize.requestNewLink'), onPress: requestNewLink }
                : { label: t('common.tryAgain'), onPress: retry }
            }
          />
        )}
      </AuthContainer>
    </>
  );
}
