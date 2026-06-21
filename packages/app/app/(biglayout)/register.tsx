import Head from 'expo-router/head';
import { LandingPage } from '@/components/landing-page';

export default function RegisterScreen() {
  return (
    <>
      <Head>
        <title>Sign Up - Alia</title>
        <meta
          name="description"
          content="Create your free Alia account. No credit card required."
        />
        <link rel="canonical" href="https://alia.onl/register" />
      </Head>
      <LandingPage />
    </>
  );
}
