import { Link, Stack } from 'expo-router';
import { View, Text } from 'react-native';
import Head from 'expo-router/head';

export default function NotFoundScreen() {
  return (
    <>
      <Head>
        <title>404 - Page Not Found | Clarity</title>
        <meta name="description" content="The page you're looking for doesn't exist. Return to Clarity to continue your AI-powered conversations." />
        <meta name="robots" content="noindex, nofollow" />
      </Head>
      <Stack.Screen options={{ title: 'Oops!' }} />
      <View className="flex-1 items-center justify-center p-5 bg-background">
        <Text className="text-xl font-bold text-foreground">This screen doesn't exist.</Text>

        <Link href="/" className="mt-4 py-4">
          <Text className="text-sm text-primary">Go to home screen!</Text>
        </Link>
      </View>
    </>
  );
}
