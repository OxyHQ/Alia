import { AliaSharedConversation, type AliaChatLabels } from '@alia.onl/sdk';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Screen } from '@oxy.so/bloom/screen';
import { Text } from '@oxy.so/bloom/typography';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Head from 'expo-router/head';
import { useMemo } from 'react';
import { View } from 'react-native';
import { useTranslation } from '@/shared/i18n/use-translation';
import config from '@/shared/platform/config';

/**
 * A shared conversation (`/shared/<token>`): the one public page every app's share link opens
 * (`aliaSharedConversationUrl`, `docs/agent-embedding.md` §6), whichever agent led it and
 * whichever app it was minted in. Anybody with the link reads it, signed in or not; the thread
 * is the SDK's, read-only, and never carries a tool's output. Not for search engines: a share is
 * somebody's conversation, handed to the people they chose.
 */
export default function SharedConversationScreen() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const router = useRouter();
  const { t, locale } = useTranslation();
  const labels = useMemo<Partial<AliaChatLabels>>(() => ({ t, locale }), [t, locale]);

  return (
    <>
      <Head>
        <title>{t('sharedConversation.pageTitle')}</title>
        <meta name="robots" content="noindex, nofollow" />
      </Head>
      <Screen
        documentScroll
        header={
          <PageHeader
            title={t('sharedConversation.title')}
            backLabel={t('sharedConversation.open')}
            onBack={() => router.replace('/(app)')}
          />
        }
      >
        <View className="flex-1">
          {token ? (
            <AliaSharedConversation token={token} apiUrl={config.apiUrl} labels={labels} />
          ) : null}
        </View>
        <Text className="px-4 py-3 text-center text-xs text-muted-foreground">
          {t('sharedConversation.footer')}
        </Text>
      </Screen>
    </>
  );
}
