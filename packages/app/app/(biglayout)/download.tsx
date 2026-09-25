import { AliaLogo } from '@/shared/ui/alia-logo';
import { useTranslation } from '@/shared/i18n/use-translation';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiAndroidFill } from '@oxy.so/bloom/icons/RiAndroidFill';
import { RiAppleFill } from '@oxy.so/bloom/icons/RiAppleFill';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Screen, ScreenScrollView } from '@oxy.so/bloom/screen';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import { useRouter } from 'expo-router';
import Head from 'expo-router/head';
import { useEffect, useState } from 'react';
import { Linking, Platform, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

const PLAY_STORE_URL =
  'https://play.google.com/store/apps/details?id=onl.alia.app';

type StorePlatform = 'android' | 'ios';

/** Both platforms' panels hold this height, so switching does not shift the page. */
const PANEL_HEIGHT = 320;

function isMobileWeb(): boolean {
  if (Platform.OS !== 'web' || typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

export default function DownloadScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const [platform, setPlatform] = useState<StorePlatform>('android');

  // On mobile web, redirect straight to the store
  useEffect(() => {
    if (isMobileWeb()) {
      Linking.openURL(PLAY_STORE_URL);
    }
  }, []);

  return (
    <>
      <Head>
        <title>{t('subscribe.download.pageTitle')}</title>
        <meta name="description" content={t('subscribe.download.metaDescription')} />
      </Head>

      <Screen
        header={
          <PageHeader
            title={t('subscribe.download.title')}
            backLabel={t('subscribe.download.back')}
            onBack={() => router.replace('/(app)')}
          />
        }
      >
        <ScreenScrollView>
          <View className="mx-auto w-full max-w-sm items-center gap-6 px-6 py-8">
            <AliaLogo width={100} />

            <View>
              <SegmentedControl
                type="tabs"
                label={t('subscribe.download.platform')}
                value={platform}
                onValueChange={setPlatform}
              >
                <SegmentedControlItem value="android">
                  <SegmentedControlItemText>Android</SegmentedControlItemText>
                </SegmentedControlItem>
                <SegmentedControlItem value="ios">
                  <SegmentedControlItemText>iOS</SegmentedControlItemText>
                </SegmentedControlItem>
              </SegmentedControl>
            </View>

            {platform === 'android' ? (
              <EmptyState
                minHeight={PANEL_HEIGHT}
                // The code carries its own white quiet zone, so it scans on a dark page too.
                illustration={
                  <QRCode
                    value={PLAY_STORE_URL}
                    size={180}
                    quietZone={16}
                    backgroundColor="white"
                    color="black"
                  />
                }
                title={t('subscribe.download.scanTitle')}
                description={t('subscribe.download.scanDescription')}
                action={{
                  label: t('subscribe.download.googlePlay'),
                  icon: RiAndroidFill,
                  onPress: () => {
                    void Linking.openURL(PLAY_STORE_URL);
                  },
                }}
              />
            ) : (
              <EmptyState
                minHeight={PANEL_HEIGHT}
                icon={RiAppleFill}
                media="circle"
                title={t('subscribe.download.iosTitle')}
                description={t('subscribe.download.iosDescription')}
              />
            )}
          </View>
        </ScreenScrollView>
      </Screen>
    </>
  );
}
