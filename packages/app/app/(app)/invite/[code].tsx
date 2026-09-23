import { AuthContainer } from '@/components/auth/auth-container';
import { AuthLogo } from '@/components/auth/auth-logo';
import { errorMessage } from '@/lib/errors/error-utils';
import { useRedeemInviteCode } from '@/lib/hooks/use-referrals';
import { Button } from '@oxy.so/bloom/button';
import { ContentPanel } from '@oxy.so/bloom/content-panel';
import { Text } from '@oxy.so/bloom/typography';
import { useAuth } from '@oxy.so/services';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Head from 'expo-router/head';
import { ArrowRight, Gift, HeartHandshake, LogIn } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

export default function InviteScreen() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const router = useRouter();
  const { isAuthenticated, isLoading: authLoading, signIn } = useAuth();
  const redeemMutation = useRedeemInviteCode();
  const [redeemed, setRedeemed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Auto-redeem when authenticated
  useEffect(() => {
    if (!isAuthenticated || authLoading || redeemed || !code) return;
    if (redeemMutation.isPending) return;

    redeemMutation.mutate(code, {
      onSuccess: () => {
        setRedeemed(true);
      },
      onError: (err: any) => {
        const message = errorMessage(err, 'Failed to redeem invite code');
        setError(message);
      },
    });
  }, [isAuthenticated, authLoading, code, redeemed]);

  if (authLoading) {
    return (
      <AuthContainer>
        <AuthLogo />
        <View className="items-center justify-center py-8">
          <Text className="text-muted-foreground">Loading...</Text>
        </View>
      </AuthContainer>
    );
  }

  // Authenticated: show redeem result
  if (isAuthenticated) {
    return (
      <>
        <Head>
          <title>Accept Invite - Alia</title>
          <meta
            name="description"
            content="Accept your invitation and get 500 free credits on Alia."
          />
        </Head>
        <AuthContainer>
          <View className="items-center gap-6">
            {/* Icon */}
            <View className="h-20 w-20 items-center justify-center rounded-full bg-primary/10">
              {redeemed ? (
                <Gift size={40} className="text-primary" />
              ) : error ? (
                <HeartHandshake size={40} className="text-muted-foreground" />
              ) : (
                <HeartHandshake size={40} className="text-primary" />
              )}
            </View>

            {redeemMutation.isPending && (
              <>
                <Text className="text-2xl font-bold text-foreground text-center">
                  Redeeming invite...
                </Text>
                <Text className="text-base text-muted-foreground text-center">
                  Please wait while we apply your credits.
                </Text>
              </>
            )}

            {redeemed && (
              <>
                <Text className="text-2xl font-bold text-foreground text-center">
                  You got 500 credits!
                </Text>
                <Text className="text-base text-muted-foreground text-center">
                  Your invite has been redeemed successfully. Both you and your
                  friend earned 500 credits.
                </Text>
                <Button
                  onPress={() => router.replace('/(app)')}
                  className="w-full h-12 rounded-full"
                  leading={
                    <>
                      <ArrowRight
                        size={18}
                        className="text-primary-foreground"
                      />
                    </>
                  }
                >
                  Start chatting
                </Button>
              </>
            )}

            {error && (
              <>
                <Text className="text-2xl font-bold text-foreground text-center">
                  Couldn't redeem invite
                </Text>
                <Text className="text-base text-muted-foreground text-center">
                  {error}
                </Text>
                <Button
                  onPress={() => router.replace('/(app)')}
                  className="w-full h-12 rounded-full"
                  leading={
                    <>
                      <ArrowRight
                        size={18}
                        className="text-primary-foreground"
                      />
                    </>
                  }
                >
                  Go to Alia
                </Button>
              </>
            )}
          </View>
        </AuthContainer>
      </>
    );
  }

  // Not authenticated: show signup prompt
  return (
    <ContentPanel surfaceClassName="bg-background">
      <>
        <Head>
          <title>You're Invited to Alia</title>
          <meta
            name="description"
            content="Join Alia and get 500 free credits with this invitation link."
          />
        </Head>
        <AuthContainer>
          <View className="items-center gap-6">
            {/* Icon */}
            <View className="h-20 w-20 items-center justify-center rounded-full bg-primary/10">
              <HeartHandshake size={40} className="text-primary" />
            </View>

            <Text className="text-2xl font-bold text-foreground text-center">
              You've been invited to Alia
            </Text>
            <Text className="text-base text-muted-foreground text-center">
              Sign up now and you'll both get 500 credits to use with Alia's AI
              assistant.
            </Text>

            <View className="w-full gap-3">
              <Button
                onPress={() => signIn().catch(() => {})}
                className="w-full h-12 rounded-full"
                leading={
                  <>
                    <Gift size={18} className="text-primary-foreground" />
                  </>
                }
              >
                Sign up & claim credits
              </Button>

              <Button
                variant="secondary"
                onPress={() => signIn().catch(() => {})}
                className="w-full h-12 rounded-full"
                leading={
                  <>
                    <LogIn size={18} className="text-foreground" />
                  </>
                }
              >
                Already have an account? Sign in
              </Button>
            </View>
          </View>
        </AuthContainer>
      </>
    </ContentPanel>
  );
}
