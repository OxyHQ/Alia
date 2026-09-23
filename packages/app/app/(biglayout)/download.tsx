import { AliaLogo } from '@/components/ui/alia-logo';
import MaterialCommunityIcons from '@/components/ui/material-community-glyphs';
import { cn } from '@/lib/utils';
import { Button } from '@oxy.so/bloom/button';
import { useTheme } from '@oxy.so/bloom/theme';
import { Text } from '@oxy.so/bloom/typography';
import { useRouter } from 'expo-router';
import Head from 'expo-router/head';
import { ArrowLeft } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Linking, Platform, Pressable, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

const PLAY_STORE_URL =
  'https://play.google.com/store/apps/details?id=onl.alia.app';

type StorePlatform = 'android' | 'ios';

function isMobileWeb(): boolean {
  if (Platform.OS !== 'web' || typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

export default function DownloadScreen() {
  const router = useRouter();
  const { colors } = useTheme();
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
        <title>Download Alia</title>
        <meta
          name="description"
          content="Download the Alia app for Android and iOS."
        />
      </Head>

      <View className="flex-1 bg-background items-center justify-center p-6">
        <View className="w-full max-w-xs items-center gap-4">
          {/* Logo */}
          <AliaLogo width={100} />

          {/* Headline */}
          <View className="items-center gap-1">
            <Text className="text-xl font-bold text-foreground text-center">
              Get Alia on your phone
            </Text>
            <Text className="text-xs text-muted-foreground text-center">
              Scan the QR code to download the app.
            </Text>
          </View>

          {/* Platform toggle */}
          <View className="flex-row rounded-full bg-muted p-1">
            <Pressable
              onPress={() => setPlatform('android')}
              className={cn(
                'flex-row items-center gap-1.5 px-4 py-1.5 rounded-full',
                platform === 'android' && 'bg-background shadow-sm',
              )}
            >
              <MaterialCommunityIcons
                name="android"
                size={16}
                color={
                  platform === 'android' ? '#3ddc84' : colors.textSecondary
                }
              />
              <Text
                className={cn(
                  'text-xs font-medium',
                  platform === 'android'
                    ? 'text-foreground'
                    : 'text-muted-foreground',
                )}
              >
                Android
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setPlatform('ios')}
              className={cn(
                'flex-row items-center gap-1.5 px-4 py-1.5 rounded-full',
                platform === 'ios' && 'bg-background shadow-sm',
              )}
            >
              <MaterialCommunityIcons
                name="apple"
                size={16}
                color={platform === 'ios' ? colors.text : colors.textSecondary}
              />
              <Text
                className={cn(
                  'text-xs font-medium',
                  platform === 'ios'
                    ? 'text-foreground'
                    : 'text-muted-foreground',
                )}
              >
                iOS
              </Text>
            </Pressable>
          </View>

          {/* QR / Coming soon — fixed-size container to prevent layout shift */}
          <View
            className="items-center gap-3"
            style={{ width: 212, height: 244 }}
          >
            {platform === 'android' ? (
              <>
                <View className="bg-white p-4 rounded-2xl">
                  <QRCode
                    value={PLAY_STORE_URL}
                    size={180}
                    backgroundColor="white"
                    color="black"
                  />
                </View>
                <Button
                  onPress={() => Linking.openURL(PLAY_STORE_URL)}
                  variant="secondary"
                  className="h-9 rounded-full px-5"
                >
                  Get it on Google Play
                </Button>
              </>
            ) : (
              <View className="flex-1 items-center justify-center rounded-2xl border border-dashed border-border w-full gap-2">
                <Text className="text-sm font-medium text-foreground">
                  Coming soon
                </Text>
                <Text className="text-xs text-muted-foreground text-center">
                  The iOS app is on the way.
                </Text>
              </View>
            )}
          </View>

          {/* Back link */}
          <Pressable
            onPress={() => router.replace('/(app)')}
            className="flex-row items-center gap-1 active:opacity-70"
          >
            <ArrowLeft size={12} className="text-muted-foreground" />
            <Text className="text-xs text-muted-foreground">Back to Alia</Text>
          </Pressable>
        </View>
      </View>
    </>
  );
}
