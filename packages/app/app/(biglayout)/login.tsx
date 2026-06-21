import { useLocalSearchParams } from 'expo-router';
import Head from 'expo-router/head';
import { LandingPage } from '@/components/landing-page';

export default function LoginScreen() {
  const { returnTo } = useLocalSearchParams();

  return (
    <>
      <Head>
        <title>Alia - Your Intelligent AI Assistant</title>
        <meta
          name="description"
          content="Meet Alia, your intelligent AI assistant. Chat naturally, remember everything, and access powerful AI models."
        />
        <link rel="canonical" href="https://alia.onl/login" />
      </Head>
      <LandingPage
        returnTo={typeof returnTo === 'string' ? returnTo : undefined}
      />
    </>
  );
}
