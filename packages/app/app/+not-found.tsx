import { useTranslation } from '@/shared/i18n/use-translation';
import { EmptyState } from '@/shared/stickers/empty-state';
import { Screen } from '@oxy.so/bloom/screen';
import { Stack, useRouter } from 'expo-router';
import Head from 'expo-router/head';
import { View } from 'react-native';

export default function NotFoundScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t('dialogs.notFound.pageTitle')}</title>
        <meta name="description" content={t('dialogs.notFound.metaDescription')} />
        <meta name="robots" content="noindex, nofollow" />
      </Head>
      <Stack.Screen options={{ title: t('dialogs.notFound.title'), headerShown: false }} />
      <Screen scroll="content">
        <View className="flex-1 items-center justify-center p-6">
          <EmptyState
            sticker="notFound"
            title={t('dialogs.notFound.title')}
            description={t('dialogs.notFound.description')}
            action={{ label: t('dialogs.notFound.home'), onPress: () => router.replace('/') }}
          />
        </View>
      </Screen>
    </>
  );
}
