import { AuthContainer } from '@/components/auth/auth-container';
import { AuthLogo } from '@/components/auth/auth-logo';
import { errorMessage } from '@/lib/errors/error-utils';
import { useRedeemInviteCode } from '@/lib/hooks/use-referrals';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiArrowRightLine } from '@oxy.so/bloom/icons/RiArrowRightLine';
import { RiGiftLine } from '@oxy.so/bloom/icons/RiGiftLine';
import { RiLoginBoxLine } from '@oxy.so/bloom/icons/RiLoginBoxLine';
import { RiUserHeartLine } from '@oxy.so/bloom/icons/RiUserHeartLine';
import { Loading } from '@oxy.so/bloom/loading';
import { useAuth } from '@oxy.so/services';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Head from 'expo-router/head';
import { useEffect, useState } from 'react';

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
        <Loading text="Loading..." />
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
          {redeemed ? (
            <EmptyState
              icon={RiGiftLine}
              media="circle"
              title="You got 500 credits!"
              description="Your invite has been redeemed successfully. Both you and your friend earned 500 credits."
              action={{
                label: 'Start chatting',
                icon: RiArrowRightLine,
                onPress: () => router.replace('/(app)'),
              }}
            />
          ) : error ? (
            <EmptyState
              icon={RiUserHeartLine}
              title="Couldn't redeem invite"
              description={error}
              action={{
                label: 'Go to Alia',
                icon: RiArrowRightLine,
                onPress: () => router.replace('/(app)'),
              }}
            />
          ) : (
            <EmptyState
              icon={RiUserHeartLine}
              media="circle"
              title={redeemMutation.isPending ? 'Redeeming invite...' : undefined}
              description={
                redeemMutation.isPending
                  ? 'Please wait while we apply your credits.'
                  : undefined
              }
            />
          )}
        </AuthContainer>
      </>
    );
  }

  // Not authenticated: show signup prompt
  return (
    <>
      <Head>
        <title>You're Invited to Alia</title>
        <meta
          name="description"
          content="Join Alia and get 500 free credits with this invitation link."
        />
      </Head>
      <AuthContainer>
        <EmptyState
          icon={RiUserHeartLine}
          media="circle"
          title="You've been invited to Alia"
          description="Sign up now and you'll both get 500 credits to use with Alia's AI assistant."
          action={{
            label: 'Sign up & claim credits',
            icon: RiGiftLine,
            onPress: () => signIn().catch(() => {}),
          }}
          secondaryAction={{
            label: 'Already have an account? Sign in',
            icon: RiLoginBoxLine,
            onPress: () => signIn().catch(() => {}),
          }}
        />
      </AuthContainer>
    </>
  );
}
