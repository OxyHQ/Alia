import { useEffect, useState } from 'react';
import { View, Pressable, Linking, Platform } from 'react-native';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import Head from 'expo-router/head';
import QRCode from 'react-native-qrcode-svg';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import Animated, {
  FadeIn,
  FadeOut,
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import { ArrowLeft } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const PLAY_STORE_URL =
  'https://play.google.com/store/apps/details?id=onl.alia.app';

type StorePlatform = 'android' | 'ios';

function isMobileWeb(): boolean {
  if (Platform.OS !== 'web' || typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

export default function DownloadScreen() {
  const router = useRouter();
  const [platform, setPlatform] = useState<StorePlatform>('android');
  const tabLayouts = useSharedValue<{ x: number; width: number }[]>([]);
  const indicatorX = useSharedValue(0);
  const indicatorW = useSharedValue(0);

  const timingConfig = { duration: 250, easing: Easing.out(Easing.cubic) };

  const indicatorStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: withTiming(indicatorX.value, timingConfig) }],
    width: withTiming(indicatorW.value, timingConfig),
  }));

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
          <Image
            source={require('@/assets/images/logo.png')}
            style={{ width: 100, height: 40 }}
            contentFit="contain"
          />

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
            {/* Animated sliding pill */}
            <Animated.View
              className="absolute top-1 bottom-1 rounded-full bg-background shadow-sm"
              style={[{ left: 4 }, indicatorStyle]}
              pointerEvents="none"
            />
            {(['android', 'ios'] as const).map((key, i) => (
              <Pressable
                key={key}
                onPress={() => {
                  setPlatform(key);
                  const layout = tabLayouts.value[i];
                  if (layout) {
                    indicatorX.value = layout.x;
                    indicatorW.value = layout.width;
                  }
                }}
                onLayout={(e) => {
                  const { x, width } = e.nativeEvent.layout;
                  const prev = [...tabLayouts.value];
                  prev[i] = { x, width };
                  tabLayouts.value = prev;
                  // Set initial indicator position for active tab
                  if (key === platform) {
                    indicatorX.value = x;
                    indicatorW.value = width;
                  }
                }}
                className="flex-row items-center gap-1.5 px-4 py-1.5 rounded-full z-10"
              >
                <MaterialCommunityIcons
                  name={key === 'android' ? 'android' : 'apple'}
                  size={16}
                  color={platform === key ? (key === 'android' ? '#3ddc84' : '#999') : '#999'}
                />
                <Text className={cn(
                  'text-xs font-medium',
                  platform === key ? 'text-foreground' : 'text-muted-foreground'
                )}>
                  {key === 'android' ? 'Android' : 'iOS'}
                </Text>
              </Pressable>
            ))}
          </View>

          {/* QR / Coming soon — fixed-size container to prevent layout shift */}
          <View className="items-center gap-3" style={{ width: 212, height: 244 }}>
            {platform === 'android' ? (
              <Animated.View
                key="android"
                entering={FadeIn.duration(200)}
                exiting={FadeOut.duration(150)}
                className="items-center gap-3"
              >
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
                  variant="outline"
                  className="h-9 rounded-full px-5"
                >
                  <Text className="text-xs font-medium">Get it on Google Play</Text>
                </Button>
              </Animated.View>
            ) : (
              <Animated.View
                key="ios"
                entering={FadeIn.duration(200)}
                exiting={FadeOut.duration(150)}
                className="flex-1 items-center justify-center rounded-2xl border border-dashed border-border w-full gap-2"
              >
                <Text className="text-sm font-medium text-foreground">Coming soon</Text>
                <Text className="text-xs text-muted-foreground text-center">
                  The iOS app is on the way.
                </Text>
              </Animated.View>
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
