import { useEffect } from 'react';
import { View, Pressable, Linking, Platform } from 'react-native';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import Head from 'expo-router/head';
import QRCode from 'react-native-qrcode-svg';
import { ArrowLeft } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';

const PLAY_STORE_URL =
  'https://play.google.com/store/apps/details?id=onl.alia.app';

function isMobileWeb(): boolean {
  if (Platform.OS !== 'web' || typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

export default function DownloadScreen() {
  const router = useRouter();

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
        <View className="w-full max-w-sm items-center gap-8">
          {/* Logo */}
          <Image
            source={require('@/assets/images/logo.png')}
            style={{ width: 120, height: 48 }}
            contentFit="contain"
          />

          {/* Headline */}
          <View className="items-center gap-2">
            <Text className="text-2xl font-bold text-foreground text-center">
              Get Alia on your phone
            </Text>
            <Text className="text-sm text-muted-foreground text-center">
              Scan the QR code with your phone camera to download the app.
            </Text>
          </View>

          {/* QR Code */}
          <View className="bg-white p-5 rounded-2xl">
            <QRCode
              value={PLAY_STORE_URL}
              size={200}
              backgroundColor="white"
              color="black"
            />
          </View>

          {/* Store link */}
          <Button
            onPress={() => Linking.openURL(PLAY_STORE_URL)}
            variant="outline"
            className="h-11 rounded-full px-6"
          >
            <Text className="text-sm font-medium">Get it on Google Play</Text>
          </Button>

          {/* Back link */}
          <Pressable
            onPress={() => router.replace('/(app)')}
            className="flex-row items-center gap-1.5 active:opacity-70"
          >
            <ArrowLeft size={14} className="text-muted-foreground" />
            <Text className="text-sm text-muted-foreground">Back to Alia</Text>
          </Pressable>
        </View>
      </View>
    </>
  );
}
